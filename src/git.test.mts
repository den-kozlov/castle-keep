import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type GitRunner,
  checkCheckout,
  commitsAhead,
  deleteMergedBranch,
  deleteRemoteBranch,
  isContainedIn,
  canPushMirror,
  pushBranch,
  pushedBranches,
  pushMirror,
  retryPush,
} from "./git.mts";

// A runner that answers each git argv from a table, keyed by the joined args.
// An entry not in the table returns exit 128, like git on a bad ref.
const stub = (
  table: Record<string, { status?: number; stdout?: string; stderr?: string }>,
): GitRunner => {
  return (args) => {
    const entry = table[args.join(" ")];
    if (!entry) return { status: 128, stdout: "" };
    return { status: entry.status ?? 0, stdout: entry.stdout ?? "", stderr: entry.stderr };
  };
};

// The stdout of `git push --porcelain` with one ref line.
const porcelain = (flag: string, ref: string, summary: string) =>
  `To github.com:o/r.git\n${flag}\t${ref}\t${summary}\nDone\n`;

describe("commitsAhead", () => {
  it("counts the commits on the branch that the base lacks", () => {
    const run = stub({ "rev-list --count main..feature": { stdout: "3\n" } });
    assert.equal(commitsAhead("main", "feature", run), 3);
  });

  it("is zero when the range is empty", () => {
    const run = stub({ "rev-list --count main..feature": { stdout: "0\n" } });
    assert.equal(commitsAhead("main", "feature", run), 0);
  });

  it("is zero when the branch does not exist", () => {
    const run = stub({}); // every ref errors
    assert.equal(commitsAhead("main", "ghost", run), 0);
  });
});

describe("isContainedIn", () => {
  it("is true when the branch tip is an ancestor of the base", () => {
    const run = stub({ "merge-base --is-ancestor feature main": { status: 0 } });
    assert.equal(isContainedIn("main", "feature", run), true);
  });

  it("is false when the branch has commits the base does not", () => {
    const run = stub({ "merge-base --is-ancestor feature main": { status: 1 } });
    assert.equal(isContainedIn("main", "feature", run), false);
  });

  it("is false when the branch does not exist", () => {
    const run = stub({}); // git exits 128
    assert.equal(isContainedIn("main", "ghost", run), false);
  });
});

describe("checkCheckout", () => {
  it("opens the gate for a clean tree with no half-merge", () => {
    assert.deepEqual(checkCheckout({ unfinished: null, dirty: [] }), { ok: true });
  });

  it("closes the gate on an unfinished merge and names the abort command", () => {
    const gate = checkCheckout({ unfinished: "merge", dirty: [] });
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.match(gate.reason, /merge/);
      assert.match(gate.reason, /git merge --abort/);
    }
  });

  it("names the cherry-pick abort command for a half cherry-pick", () => {
    const gate = checkCheckout({ unfinished: "cherry-pick", dirty: [] });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.match(gate.reason, /git cherry-pick --abort/);
  });

  it("closes the gate on a dirty working tree and counts the paths", () => {
    const gate = checkCheckout({ unfinished: null, dirty: [" M a.go", "?? b.go"] });
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.match(gate.reason, /2/);
      assert.match(gate.reason, /clean|dirty|working tree/i);
    }
  });

  it("reports the unfinished merge before the dirty tree", () => {
    // A conflicted merge is both unfinished and dirty; the merge state is the
    // one the user must resolve first, so it leads the message.
    const gate = checkCheckout({ unfinished: "merge", dirty: [" M a.go"] });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.match(gate.reason, /merge/);
  });
});

describe("deleteMergedBranch", () => {
  it("deletes with -d, never -D", () => {
    const run = stub({ "branch -d sandcastle/issue-7": {} });
    assert.equal(deleteMergedBranch("sandcastle/issue-7", run), true);
  });

  it("reports a branch that git refused to delete", () => {
    const run = stub({ "branch -d sandcastle/issue-7": { status: 1 } });
    assert.equal(deleteMergedBranch("sandcastle/issue-7", run), false);
  });
});

describe("pushMirror", () => {
  const args = "push --porcelain --force origin main:refs/heads/sandcastle/main";

  it("moves the mirror forward without a forced update", () => {
    const run = stub({ [args]: { stdout: porcelain(" ", "main:refs/heads/sandcastle/main", "1a..2b") } });
    assert.deepEqual(pushMirror("main", run), { ok: true, forced: false });
  });

  it("reports a forced update when the base no longer holds the mirror", () => {
    const run = stub({ [args]: { stdout: porcelain("+", "main:refs/heads/sandcastle/main", "1a...2b (forced update)") } });
    assert.deepEqual(pushMirror("main", run), { ok: true, forced: true });
  });

  it("creates the mirror on the first push", () => {
    const run = stub({ [args]: { stdout: porcelain("*", "main:refs/heads/sandcastle/main", "[new branch]") } });
    assert.deepEqual(pushMirror("main", run), { ok: true, forced: false });
  });

  it("only asks origin on a dry run", () => {
    const run = stub({
      "push --porcelain --force --dry-run origin main:refs/heads/sandcastle/main": {
        stdout: porcelain("=", "main:refs/heads/sandcastle/main", "[up to date]"),
      },
    });
    assert.deepEqual(canPushMirror("main", run), { ok: true, forced: false });
  });

  it("gives the first line of the error when origin is unreachable", () => {
    const run = stub({ [args]: { status: 128, stderr: "fatal: Could not read from remote repository.\nPlease make sure" } });
    assert.deepEqual(pushMirror("main", run), {
      ok: false,
      reason: "fatal: Could not read from remote repository.",
    });
  });
});

describe("pushBranch", () => {
  const args = "push --porcelain --force-with-lease origin sandcastle/issue-7:refs/heads/sandcastle/issue-7";

  it("pushes the branch under its own name with a lease", () => {
    const run = stub({ [args]: { stdout: porcelain("*", "sandcastle/issue-7:refs/heads/sandcastle/issue-7", "[new branch]") } });
    assert.deepEqual(pushBranch("sandcastle/issue-7", run), { ok: true, forced: false });
  });

  it("fails on a rejected ref even when git exits 0 for it", () => {
    const run = stub({
      [args]: { stdout: porcelain("!", "sandcastle/issue-7:refs/heads/sandcastle/issue-7", "[rejected] (stale info)") },
    });
    assert.deepEqual(pushBranch("sandcastle/issue-7", run), { ok: false, reason: "[rejected] (stale info)" });
  });
});

describe("pushedBranches", () => {
  it("names the issue branches that have a remote-tracking ref", () => {
    const run = stub({
      "for-each-ref --format=%(refname) refs/remotes/origin/sandcastle/issue-*": {
        stdout: "refs/remotes/origin/sandcastle/issue-7\nrefs/remotes/origin/sandcastle/issue-12\n",
      },
    });
    assert.deepEqual(pushedBranches(run), ["sandcastle/issue-7", "sandcastle/issue-12"]);
  });

  it("is empty when the harness pushed nothing", () => {
    const run = stub({ "for-each-ref --format=%(refname) refs/remotes/origin/sandcastle/issue-*": {} });
    assert.deepEqual(pushedBranches(run), []);
  });
});

describe("retryPush", () => {
  const noSleep = async () => {};

  it("retries a failed push and returns the later result", async () => {
    let calls = 0;
    const result = await retryPush(() => {
      calls++;
      return calls < 2 ? { ok: false, reason: "Connection reset" } : { ok: true, forced: false };
    }, noSleep);
    assert.deepEqual(result, { ok: true, forced: false });
    assert.equal(calls, 2);
  });

  it("returns the last failure once the attempts run out", async () => {
    let calls = 0;
    const result = await retryPush(() => {
      calls++;
      return { ok: false, reason: `failure ${calls}` };
    }, noSleep);
    assert.deepEqual(result, { ok: false, reason: "failure 3" });
  });
});

describe("deleteRemoteBranch", () => {
  it("deletes the branch on origin", () => {
    const run = stub({
      "push --porcelain origin --delete sandcastle/issue-7": {
        stdout: porcelain("-", ":refs/heads/sandcastle/issue-7", "[deleted]"),
      },
    });
    assert.deepEqual(deleteRemoteBranch("sandcastle/issue-7", run), { ok: true, forced: false });
  });
});
