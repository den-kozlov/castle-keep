// Git queries for the merge phase.
//
// The merger runs in the host checkout and must survive being killed at any
// point. Two questions decide whether a rerun repeats work or breaks:
//   1. Is a branch already contained in the base? git already holds the answer,
//      so no state file is needed — a branch merged by a killed run is dropped
//      from the merge and its issue closed without merging again.
//   2. Is the base checkout safe to merge into? A kill during a conflicting
//      `git merge` leaves MERGE_HEAD; the guard reads that state and stops the
//      run rather than merging on top of a half-finished merge.
//
// The reading functions shell out to git. The decision functions are pure, so
// tests drive them without a repo. Both share the `checkLimits` shape: a result
// the caller logs and acts on, never a throw.

import { spawnSync } from "node:child_process";
import { withRetry } from "./gh.mts";

/** One git invocation: its exit code, standard output and, when the runner
 *  keeps it, standard error. Never throws on a non-zero exit — callers read the
 *  status. Replaced in tests. */
export type GitRunner = (args: string[]) => { status: number; stdout: string; stderr?: string };

// A push that waits on a password prompt or a dead network would hold the
// loop: git never prompts here, and a call ends after this time.
const GIT_TIMEOUT_MS = 120_000;

export const realGit: GitRunner = (args) => {
  const out = spawnSync("git", args, {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: out.status ?? 128, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
};

/**
 * Commits on `branch` that `base` does not have. Returns 0 when the branch is
 * contained in the base, or does not exist. This counts work from earlier runs
 * too, unlike a single run's own commit list.
 */
export function commitsAhead(
  base: string,
  branch: string,
  run: GitRunner = realGit,
): number {
  const res = run(["rev-list", "--count", `${base}..${branch}`]);
  if (res.status !== 0) return 0;
  return Number.parseInt(res.stdout.trim(), 10) || 0;
}

/**
 * True when every commit on `branch` is already on `base` — the branch tip is
 * an ancestor of the base. A branch that does not exist is not contained.
 */
export function isContainedIn(
  base: string,
  branch: string,
  run: GitRunner = realGit,
): boolean {
  return run(["merge-base", "--is-ancestor", branch, base]).status === 0;
}

/** A half-finished operation left in the checkout, or null when there is none. */
export type Unfinished = "merge" | "cherry-pick" | "revert" | null;

/** The state of the base checkout that the merge guard reads. */
export interface CheckoutState {
  /** A half-finished merge/cherry-pick/revert, or null. */
  unfinished: Unfinished;
  /** Porcelain status lines; empty when the working tree is clean. */
  dirty: string[];
}

/** Same shape as the limit gate: a result the caller logs and acts on. */
export type CheckoutGate = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether the base checkout is safe to merge into. An unfinished merge
 * leads a dirty tree, because a conflicted merge is both and the user must
 * resolve the merge first. The gate never proposes a command that discards
 * work; the user decides what happens to a conflicted merge.
 */
export function checkCheckout(state: CheckoutState): CheckoutGate {
  if (state.unfinished) {
    return {
      ok: false,
      reason:
        `an unfinished ${state.unfinished} is in the base checkout; ` +
        `resolve it or run \`git ${state.unfinished} --abort\`, then rerun`,
    };
  }
  if (state.dirty.length > 0) {
    return {
      ok: false,
      reason:
        `the base checkout working tree is not clean (${state.dirty.length} path(s)); ` +
        "commit or `git stash` the changes, then rerun",
    };
  }
  return { ok: true };
}

/** Reads the base checkout state from git. */
export function readCheckout(run: GitRunner = realGit): CheckoutState {
  const has = (ref: string) =>
    run(["rev-parse", "--verify", "--quiet", ref]).status === 0;

  // First head that exists wins, in resolve-order: a conflicted merge shows
  // MERGE_HEAD, and that is what the user must resolve first.
  const heads: [ref: string, kind: Unfinished][] = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  const unfinished: Unfinished = heads.find(([ref]) => has(ref))?.[1] ?? null;

  const status = run(["status", "--porcelain"]);
  const dirty = status.stdout.split("\n").filter((line) => line.trim() !== "");

  return { unfinished, dirty };
}

/**
 * Deletes a branch that the base already holds. `git branch -d` refuses a
 * branch that is not merged into HEAD, or one that a worktree still has
 * checked out, so this never drops work. Returns false when git refused.
 */
export function deleteMergedBranch(branch: string, run: GitRunner = realGit): boolean {
  return run(["branch", "-d", branch]).status === 0;
}

// ---------------------------------------------------------------------------
// The record on GitHub
//
// Every issue branch goes to `origin` with a pull request against the mirror
// `sandcastle/main`, a copy of the local base that only the harness pushes.
// Once the mirror holds a merged branch, GitHub marks its pull request merged
// by itself. `main` on `origin` stays the human's. A failed push is a result
// the caller warns about, never a throw: the record is a view, not a gate.
// ---------------------------------------------------------------------------

/** The names of the record on the remote; the config sets them (./config.mts). */
export interface Refs {
  remote: string;
  /** The branch on the remote that mirrors the local base; the PRs' base. */
  mirror: string;
  /** The prefix of an issue branch: `sandcastle/issue-` for issue 42 on `sandcastle/issue-42`. */
  branchPrefix: string;
}

export const DEFAULT_REFS: Refs = { remote: "origin", mirror: "sandcastle/main", branchPrefix: "sandcastle/issue-" };

/** What a push did, or why it failed. */
export type PushResult =
  | { ok: true; forced: boolean }
  | { ok: false; reason: string };

/**
 * Reads `git push --porcelain`. Its ref lines on stdout start with a flag:
 * `+` forced update, ` ` fast-forward, `*` new ref, `=` up to date, `-`
 * deleted, `!` rejected.
 */
function pushResult(res: ReturnType<GitRunner>): PushResult {
  const refs = res.stdout.split("\n").filter((line) => /^[ +*=!-]\t/.test(line));
  const rejected = refs.find((line) => line.startsWith("!"));
  if (res.status !== 0 || rejected !== undefined) {
    const text = rejected?.split("\t").slice(2).join(" ") || res.stderr?.trim() || `git exited ${res.status}`;
    return { ok: false, reason: text.split("\n")[0] ?? "" };
  }
  return { ok: true, forced: refs.some((line) => line.startsWith("+")) };
}

/**
 * Sets the mirror on `origin` to the local base. Forced: only the harness
 * pushes the mirror, and a base that the human rebased or reset is no longer a
 * descendant of it. `forced` tells the caller that the mirror went back.
 */
export function pushMirror(base: string, run: GitRunner = realGit, refs: Refs = DEFAULT_REFS): PushResult {
  return pushResult(run(["push", "--porcelain", "--force", refs.remote, `${base}:refs/heads/${refs.mirror}`]));
}

/** Asks `origin` whether it takes a push of the mirror, without pushing. */
export function canPushMirror(base: string, run: GitRunner = realGit, refs: Refs = DEFAULT_REFS): PushResult {
  return pushResult(
    run(["push", "--porcelain", "--force", "--dry-run", refs.remote, `${base}:refs/heads/${refs.mirror}`]),
  );
}

/**
 * Pushes an issue branch to `origin` under its own name. The lease is the
 * remote-tracking ref of the last push, so a branch that changed on `origin`
 * behind the harness is not overwritten.
 */
export function pushBranch(branch: string, run: GitRunner = realGit, refs: Refs = DEFAULT_REFS): PushResult {
  return pushResult(
    run(["push", "--porcelain", "--force-with-lease", refs.remote, `${branch}:refs/heads/${branch}`]),
  );
}

/**
 * The issue branches the harness pushed and has not deleted on `origin` yet:
 * their remote-tracking refs, under the branch names.
 */
export function pushedBranches(run: GitRunner = realGit, refs: Refs = DEFAULT_REFS): string[] {
  const prefix = `refs/remotes/${refs.remote}/`;
  return run(["for-each-ref", "--format=%(refname)", `${prefix}${refs.branchPrefix}*`])
    .stdout.split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** The pushed tip of `branch`, for the containment check of ./git.mts. */
export function pushedRef(branch: string, refs: Refs = DEFAULT_REFS): string {
  return `refs/remotes/${refs.remote}/${branch}`;
}

/** Deletes an issue branch on `origin`; git drops its remote-tracking ref too. */
export function deleteRemoteBranch(branch: string, run: GitRunner = realGit, refs: Refs = DEFAULT_REFS): PushResult {
  return pushResult(run(["push", "--porcelain", refs.remote, "--delete", branch]));
}

/** Attempts per push, including the first one. */
const PUSH_ATTEMPTS = 3;

/** Pause before the first retry of a push; it doubles before the next. */
const PUSH_BASE_DELAY_MS = 2_000;

/**
 * Runs a push until it succeeds or PUSH_ATTEMPTS run out, like the `gh` calls
 * of ./gh.mts: a short network failure costs a pause, not the record.
 */
export async function retryPush(
  push: () => PushResult,
  sleep?: (ms: number) => Promise<void>,
): Promise<PushResult> {
  let last: PushResult = { ok: false, reason: "no attempt ran" };
  try {
    return await withRetry(
      async () => {
        last = push();
        if (!last.ok) throw new Error(last.reason);
        return last;
      },
      { attempts: PUSH_ATTEMPTS, baseDelayMs: PUSH_BASE_DELAY_MS, sleep, onRetry: () => {} },
    );
  } catch {
    return last;
  }
}
