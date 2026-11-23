// Shows a sandcastle run on the Orca board.
//
// Orca already finds the git worktrees under `.sandcastle/worktrees/` by
// itself. This module adds what Orca cannot guess: which issue a worktree
// works on, how far that issue got, a terminal tab that streams the agent
// log while the agent runs, and the status of the run in the title of the
// tab that runs it.
//
// Every call here is best effort. Orca is a view on the run, never a gate on
// it. When the CLI is missing, the app is closed, or a call times out, the run
// continues and prints one line.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "../plugin.mts";
import { initialState, reduce, tabTitle, type RunEvent, type RunState } from "../events.mts";

const execFileAsync = promisify(execFile);

/** How often the tab title is recomputed between events, for the countdown of a pause. */
const TAB_TITLE_TICK_MS = 30_000;

/** The board columns Orca ships with. */
export type WorkspaceStatus = "todo" | "in-progress" | "in-review" | "completed";

/** How long one `orca` call may take before the run moves on without it. */
const ORCA_TIMEOUT_MS = 15_000;

/** The answer of the first readiness probe. Probed once per run. */
let ready: Promise<boolean> | undefined;

/**
 * Runs one `orca` command. Returns its stdout, or undefined when the command
 * fails. A failure never throws: the caller is a reporting step, not work.
 */
async function orca(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("orca", args, {
      timeout: ORCA_TIMEOUT_MS,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    console.log(`  ! orca ${args[0]} ${args[1] ?? ""}: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * True when the Orca runtime answers. The probe runs once; every later call
 * reuses the answer, so a closed app costs one timeout per run and not one per
 * agent.
 */
export function orcaReady(): Promise<boolean> {
  ready ??= orca(["status"]).then((out) => {
    const up = out?.includes("runtimeReachable: true") ?? false;
    console.log(
      up
        ? "Orca is up: worktrees and agent terminals appear on the board."
        : "Orca is not reachable. The run goes on without the board.",
    );
    return up;
  });
  return ready;
}

/** Selects a worktree by its host path. The most exact of the selectors. */
function selector(worktreePath: string): string {
  return `path:${worktreePath}`;
}

/**
 * Names the worktree on the board after its issue and moves it into a column.
 * The issues are markdown files, not tracker issues, so no `--issue` link.
 */
export async function markWorktree(options: {
  worktreePath: string;
  issueId: string;
  title: string;
  status: WorkspaceStatus;
}): Promise<void> {
  if (!(await orcaReady())) return;

  await orca([
    "worktree",
    "set",
    "--worktree",
    selector(options.worktreePath),
    "--display-name",
    `#${options.issueId} ${options.title}`,
    "--comment",
    options.title,
    "--workspace-status",
    options.status,
  ]);
}

/** Moves a worktree into another column. Used when a phase ends. */
export async function setStatus(
  worktreePath: string,
  status: WorkspaceStatus,
): Promise<void> {
  if (!(await orcaReady())) return;

  await orca([
    "worktree",
    "set",
    "--worktree",
    selector(worktreePath),
    "--workspace-status",
    status,
  ]);
}

/**
 * Keeps the title of the tab that runs the loop at the short status of the
 * run (`tabTitle` in ../events.mts). Orca gives the process its own tab in
 * `ORCA_TERMINAL_HANDLE`; without it, or outside Orca, nothing happens.
 *
 * Every event folds into a RunState of its own, so the title works in both
 * modes and never touches the view. A rename runs only when the title
 * changes, one at a time, in order. `close` puts the auto title back.
 */
export function trackTabTitle(): { emit: (event: RunEvent) => void; close: () => Promise<void> } {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) return { emit: () => {}, close: async () => {} };

  let state: RunState = initialState();
  let shown: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const rename = (title: string | undefined) => {
    queue = queue.then(async () => {
      if (!(await orcaReady())) return;
      await orca(["terminal", "rename", "--terminal", handle, ...(title === undefined ? [] : ["--title", title])]);
    });
  };
  const refresh = () => {
    const title = tabTitle(state);
    if (title === shown) return;
    shown = title;
    rename(title);
  };
  const timer = setInterval(refresh, TAB_TITLE_TICK_MS);
  timer.unref();

  return {
    emit: (event) => {
      state = reduce(state, event);
      refresh();
    },
    close: async () => {
      clearInterval(timer);
      shown = undefined;
      rename(undefined);
      await queue;
    },
  };
}

/**
 * Opens a terminal tab in the worktree that streams the log of one agent.
 *
 * `tail -F` waits for a file that does not exist yet, so the tab can open
 * before the agent writes its first line. The tab lives as long as the
 * worktree: `sandbox.close()` removes the worktree and the tab with it. The
 * log file stays under `.sandcastle/logs/`.
 */
export async function watchLog(options: {
  worktreePath: string;
  title: string;
  logPath: string;
}): Promise<void> {
  if (!(await orcaReady())) return;

  await orca([
    "terminal",
    "create",
    "--worktree",
    selector(options.worktreePath),
    "--title",
    options.title,
    "--command",
    `tail -n +1 -F ${JSON.stringify(options.logPath)}`,
  ]);
}

/**
 * The plugin: the worktree of each issue on the board, a tab per agent that
 * streams its log, and the status of the run in the title of the tab that
 * runs the loop. Without it the run has no Orca probe and no Orca notice.
 */
export function orcaPlugin(): Plugin {
  let tab: ReturnType<typeof trackTabTitle> | undefined;
  return {
    name: "orca",
    listeners: {
      onRunStart: async () => {
        tab = trackTabTitle();
        await orcaReady();
      },
      onAgentStart: async ({ role, worktreePath, issue, logPath }) => {
        if (role === "implementer") {
          await markWorktree({ worktreePath, issueId: issue.id, title: issue.title, status: "in-progress" });
        } else {
          await setStatus(worktreePath, "in-review");
        }
        await watchLog({ worktreePath, title: `#${issue.id} ${role}`, logPath });
      },
      onEvent: (event) => tab?.emit(event),
    },
    lifecycle: {
      runEnd: async () => {
        await tab?.close();
      },
    },
  };
}
