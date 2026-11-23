// The plugin `github-pr`: the mirror `sandcastle/main` and one pull request per
// issue branch. It works with the `github` source only.
//
// Mirror push at the start of an iteration; branch push and pull request once
// the branch is reviewed; mirror push, wait for merged and remote branch
// deletion after the merge and at the end of the iteration; a dry-run push in
// preflight. Every failure is a warning: the pull requests are a view of the
// work, not a condition of it.

import { withRetry, gh, type GhOptions } from "../gh.mts";
import {
  canPushMirror,
  deleteRemoteBranch,
  pushBranch,
  pushedBranches,
  pushedRef,
  pushMirror,
  realGit,
  retryPush,
  type GitRunner,
  type Refs,
} from "../git.mts";
import type { LifecycleContext, Plugin } from "../plugin.mts";

// ---------------------------------------------------------------------------
// Pull requests of the issue branches
//
// A pull request is the record of one issue: its base is the mirror
// `sandcastle/main` (./git.mts), its head the issue branch. Nobody merges it
// on GitHub; GitHub marks it merged once the mirror holds the branch.
// ---------------------------------------------------------------------------

export interface PullRequestInput {
  /** The issue branch, also the head of the pull request. */
  branch: string;
  /** The branch the pull request merges into: the mirror. */
  base: string;
  title: string;
  body: string;
}

/**
 * One field of the newest pull request of `branch` into `base` in `state`
 * (open, closed, merged or all), or "" when there is none.
 */
async function newestPullRequest(
  branch: string,
  base: string,
  state: string,
  field: "url" | "state",
  options: GhOptions,
): Promise<string> {
  const out = await gh(
    ["pr", "list", "--head", branch, "--base", base, "--state", state, "--json", field, "--jq", `.[0].${field} // ""`],
    options,
  );
  return out.trim();
}

/** The URL of the open pull request of `branch` into `base`, or "" when there is none. */
export function openPullRequest(branch: string, base: string, options: GhOptions = {}): Promise<string> {
  return newestPullRequest(branch, base, "open", "url", options);
}

/**
 * Opens the pull request of an issue branch unless one is open already; a
 * rerun of the issue updates the open one by its push. Returns its URL and
 * whether this call created it.
 */
export async function ensurePullRequest(
  input: PullRequestInput,
  options: GhOptions = {},
): Promise<{ url: string; created: boolean }> {
  const open = await openPullRequest(input.branch, input.base, options);
  if (open !== "") return { url: open, created: false };
  const out = await gh(
    ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body],
    options,
  );
  // `gh pr create` prints the URL on its last line.
  const url = out.trim().split("\n").pop() ?? "";
  return { url, created: true };
}

/**
 * The state of a branch's pull request as the harness sees it: GitHub's own
 * three, NONE when the branch has no pull request, UNKNOWN when GitHub could
 * not be read.
 */
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED" | "NONE" | "UNKNOWN";

/** The state of the newest pull request of `branch` into `base`. */
export async function pullRequestState(
  branch: string,
  base: string,
  options: GhOptions = {},
): Promise<PullRequestState> {
  const state = await newestPullRequest(branch, base, "all", "state", options);
  if (state === "") return "NONE";
  return state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "UNKNOWN";
}

/** Checks of the state while GitHub catches up with a push of the mirror. */
const MERGED_CHECKS = 5;

/** Pause before the second check; it doubles each time (1+2+4+8 s in all). */
const MERGED_BASE_DELAY_MS = 1_000;

/**
 * Waits until GitHub marks the pull request of `branch` merged, after a push
 * of the mirror that holds the branch. Waits only while it is OPEN. Returns
 * the last state seen: MERGED, NONE or CLOSED at once, OPEN when GitHub did not
 * catch up, or UNKNOWN when the last read failed.
 */
export async function waitMerged(
  branch: string,
  base: string,
  options: GhOptions = {},
): Promise<PullRequestState> {
  let state: PullRequestState = "UNKNOWN";
  try {
    await withRetry(
      async () => {
        state = "UNKNOWN";
        state = await pullRequestState(branch, base, { ...options, attempts: 1 });
        if (state === "OPEN") throw new Error(`pull request ${state}`);
      },
      {
        attempts: MERGED_CHECKS,
        baseDelayMs: MERGED_BASE_DELAY_MS,
        sleep: options.sleep,
        onRetry: () => {},
      },
    );
  } catch {
    // `state` holds what the last check saw.
  }
  return state;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

export interface GithubPrOptions {
  /** Replaced in tests. */
  git?: GitRunner;
  gh?: GhOptions;
}

export function githubPrPlugin(options: GithubPrOptions = {}): Plugin {
  const git = options.git ?? realGit;
  const ghOptions = options.gh ?? {};

  /** Pushes an issue branch and opens its pull request against the mirror. */
  const publishBranch = async (
    { refs, notice }: LifecycleContext,
    issue: { id: string; title: string },
    branch: string,
  ): Promise<void> => {
    const pushed = await retryPush(() => pushBranch(branch, git, refs));
    if (!pushed.ok) {
      notice(`#${issue.id}: ${branch} not pushed to ${refs.remote}, no pull request: ${pushed.reason}`, "warn");
      return;
    }
    try {
      const pr = await ensurePullRequest(
        {
          branch,
          base: refs.mirror,
          title: issue.title,
          body:
            `Refs #${issue.id}\n\n` +
            `Sandcastle work on #${issue.id}. A record of the diff: nobody merges it here. ` +
            `The merger agent merges the branch into the local \`main\`, and the harness pushes ` +
            `the mirror \`${refs.mirror}\`; GitHub then marks this pull request merged.`,
        },
        ghOptions,
      );
      if (pr.created) notice(`#${issue.id}: pull request ${pr.url}`);
    } catch (error) {
      notice(`#${issue.id}: no pull request: ${message(error)}`, "warn");
    }
  };

  /**
   * Sets the mirror on the remote to the base, then deletes on the remote every
   * pushed issue branch that the base holds. A branch left by a failed merger or
   * a slow GitHub goes on a later pass. A branch goes only once its pull request
   * is no longer open: a head deleted before GitHub sees the merge closes it unmerged.
   */
  const syncRecord = async ({ base, refs, notice, git: host }: LifecycleContext): Promise<void> => {
    const { remote, mirror } = refs;
    const pushed = await retryPush(() => pushMirror(base, git, refs));
    if (!pushed.ok) {
      notice(`${mirror} not pushed to ${remote}: ${pushed.reason}`, "warn");
      return;
    }
    if (pushed.forced) {
      notice(`${mirror} on ${remote} forced to ${base}: ${base} no longer holds it (a rebase or a reset)`, "warn");
    }
    const merged = pushedBranches(git, refs).filter((branch) => host.isContainedIn(base, pushedRef(branch, refs)));
    for (const branch of merged) {
      const state = await waitMerged(branch, mirror, ghOptions);
      if (state === "OPEN" || state === "UNKNOWN") {
        notice(`${branch} kept on ${remote} for now: its pull request is ${state}, not MERGED`, "warn");
        continue;
      }
      const deleted = await retryPush(() => deleteRemoteBranch(branch, git, refs));
      if (!deleted.ok) notice(`${branch} not deleted on ${remote}: ${deleted.reason}`, "warn");
    }
  };

  return {
    name: "github-pr",
    requires: { source: "github" },
    preflight: [
      ({ base, refs }) => {
        // Origin may refuse a push of the mirror; the run still works, with no record on GitHub.
        const push = canPushMirror(base, git, refs);
        return push.ok ? {} : { warnings: [`${refs.remote} refuses a push of ${refs.mirror}, so no pull requests: ${push.reason}`] };
      },
    ],
    lifecycle: {
      iterationStart: (context) => syncRecord(context),
      async branchReady(context, { issue, branch }) {
        // A blocked branch gets its pull request too: it stays open for the human.
        if (context.git.commitsAhead(context.base, branch) > 0) await publishBranch(context, issue, branch);
      },
      mergeDone: (context) => syncRecord(context),
      iterationEnd: (context) => syncRecord(context),
    },
  };
}
