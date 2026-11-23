// One log directory per sandcastle run, and one per iteration inside it.
//
// Sandcastle names a log file after the branch and the agent, and it appends.
// A re-run of the same issue therefore wrote into the file of the run before,
// and nothing marked the boundary. An endless run replans the same issues for
// days, so the boundary is the iteration:
//
//   logs/<run>/orchestrator.log   what the harness did, in plain lines
//   logs/<run>/001/<branch>-<agent>.log
//   logs/latest -> <run>/<iteration>
//
// An iteration directory appears only when the planner runs; an idle poll
// writes one line into orchestrator.log and nothing else.
//
// Retention: the newest KEEP_ITERATIONS iteration directories stay, counted
// over all runs, checked at each iteration. The newest KEEP_RUNS run
// directories stay, checked at the start of a run. A run that lost its last
// iteration goes too. Files of the old flat layout are left alone; they no
// longer grow, so you can remove them by hand.

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Run directories kept under the log root. Older ones are removed. */
export const KEEP_RUNS = 10;

/** Iteration directories kept over all runs. Older ones are removed. */
export const KEEP_ITERATIONS = 50;

/** The plain-line journal of the harness, at the top of a run directory. */
export const ORCHESTRATOR_LOG = "orchestrator.log";

const ITERATION_DIR_PATTERN = /^\d{3,}$/;

/** Name of the symlink that points at the newest run directory. */
export const LATEST_LINK = "latest";

/** Where the run directories live. */
export const LOGS_ROOT = ".sandcastle/logs";

// A stamp, and the `-2`, `-3` … of a second run inside the same second.
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/;

/** Runs allowed inside one second before startLogRun gives up. */
const MAX_RUNS_PER_SECOND = 100;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Builds the name of a run directory from the local time. The shape sorts in
 * the same order as the clock.
 */
export function runStamp(at: Date): string {
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  );
}

// The same characters sandcastle replaces, so the file names do not change.
function sanitizeBranch(branch: string): string {
  return branch.replace(/[/\\:*?"<>|]/g, "-");
}

/** The log file name of one agent on one branch, as sandcastle wrote it. */
export function logFileName(branch: string, name: string): string {
  const agent = name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `${sanitizeBranch(branch)}-${agent}.log`;
}

/**
 * Names the run directories to remove so that at most `keep` of them stay.
 * Entries that are not run directories are never named.
 */
export function runsToPrune(names: string[], keep: number): string[] {
  const runs = names.filter((name) => RUN_DIR_PATTERN.test(name)).sort();
  return runs.slice(0, Math.max(0, runs.length - keep));
}

/** The name of an iteration directory: 001, 002 … */
export function iterationDirName(iteration: number): string {
  return String(iteration).padStart(3, "0");
}

/**
 * Names the iteration directories to remove, as `<run>/<iteration>`, so that
 * at most `keep` stay. The oldest go first: by run, then by number.
 */
export function iterationsToPrune(paths: string[], keep: number): string[] {
  const order = (path: string) => {
    const [run = "", iteration = "0"] = path.split("/");
    return { run, iteration: Number.parseInt(iteration, 10) };
  };
  const sorted = [...paths].sort((a, b) => {
    const x = order(a);
    const y = order(b);
    return x.run === y.run ? x.iteration - y.iteration : x.run < y.run ? -1 : 1;
  });
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** The `logging` option of a sandcastle run. */
export interface FileLogging {
  readonly type: "file";
  readonly path: string;
}

export interface IterationLogs {
  readonly iteration: number;
  /** Absolute path of the directory of this iteration. */
  readonly dir: string;
  /** The `logging` option for one agent on one branch. */
  file(branch: string, name: string): FileLogging;
}

export interface LogRun {
  /** Absolute path of the directory that holds the logs of this run. */
  readonly dir: string;
  /** The journal of the harness. */
  readonly orchestratorPath: string;
  /** Makes the directory of an iteration and points `latest` at it. */
  startIteration(iteration: number): IterationLogs;
}

export interface StartLogRunOptions {
  /** Log root. Defaults to `.sandcastle/logs`. */
  root?: string;
  /** Start time of the run. Defaults to now. */
  at?: Date;
  /** Run directories to keep. Defaults to KEEP_RUNS. */
  keep?: number;
  /** Iteration directories to keep. Defaults to KEEP_ITERATIONS. */
  keepIterations?: number;
}

/**
 * Makes the log directory of this run, points `latest` at it, and removes the
 * run directories above the keep count.
 */
export function startLogRun(options: StartLogRunOptions = {}): LogRun {
  const root = options.root ?? resolve(LOGS_ROOT);
  mkdirSync(root, { recursive: true });

  const dir = makeRunDir(root, runStamp(options.at ?? new Date()));
  refreshLatestLink(root, basename(dir));
  prune(root, options.keep ?? KEEP_RUNS);

  return {
    dir,
    orchestratorPath: join(dir, ORCHESTRATOR_LOG),
    startIteration: (iteration) => {
      const name = iterationDirName(iteration);
      const iterationDir = join(dir, name);
      mkdirSync(iterationDir, { recursive: true });
      refreshLatestLink(root, `${basename(dir)}/${name}`);
      pruneIterations(root, dir, options.keepIterations ?? KEEP_ITERATIONS);
      return {
        iteration,
        dir: iterationDir,
        file: (branch, agent) => ({
          type: "file",
          path: join(iterationDir, logFileName(branch, agent)),
        }),
      };
    },
  };
}
/**
 * Makes a new directory for the stamp. Two runs inside the same second get
 * `<stamp>` and `<stamp>-2`, so neither writes into the log of the other.
 */
function makeRunDir(root: string, stamp: string): string {
  for (let run = 1; run <= MAX_RUNS_PER_SECOND; run++) {
    const dir = join(root, run === 1 ? stamp : `${stamp}-${run}`);
    try {
      // Not recursive: an existing directory must fail, so the loop can move on.
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`more than ${MAX_RUNS_PER_SECOND} log runs in the second ${stamp}`);
}

function refreshLatestLink(root: string, target: string): void {
  const link = join(root, LATEST_LINK);
  try {
    unlinkSync(link);
  } catch {
    // No link yet, or it is not ours to remove. symlinkSync reports the rest.
  }
  try {
    symlinkSync(target, link, "dir");
  } catch (error) {
    console.warn(`  ! could not update ${link}: ${(error as Error).message}`);
  }
}

function prune(root: string, keep: number): void {
  for (const name of runsToPrune(readdirSync(root), keep)) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

function pruneIterations(root: string, current: string, keep: number): void {
  const paths: string[] = [];
  for (const run of readdirSync(root).filter((name) => RUN_DIR_PATTERN.test(name))) {
    for (const name of readdirSync(join(root, run))) {
      if (ITERATION_DIR_PATTERN.test(name)) paths.push(`${run}/${name}`);
    }
  }
  const emptied = new Set<string>();
  for (const path of iterationsToPrune(paths, keep)) {
    rmSync(join(root, path), { recursive: true, force: true });
    emptied.add(path.split("/")[0]!);
  }
  for (const run of emptied) {
    const dir = join(root, run);
    if (dir === current || !existsSync(dir)) continue;
    if (!readdirSync(dir).some((name) => ITERATION_DIR_PATTERN.test(name))) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
