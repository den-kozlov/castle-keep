import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carry, ConfigError, parseConfig } from "../config.mts";
import type { GitRunner } from "../git.mts";
import type { LifecycleContext } from "../plugin.mts";
import { ensurePullRequest, githubPrPlugin, waitMerged } from "./github-pr.mts";

const noSleep = async () => {};

describe("ensurePullRequest", () => {
  const input = {
    branch: "sandcastle/issue-7",
    base: "sandcastle/main",
    title: "Fix the parser",
    body: "Refs #7",
  };

  it("opens a pull request against the mirror when the branch has none", async () => {
    const calls: string[][] = [];
    const pr = await ensurePullRequest(input, {
      run: async (args) => {
        calls.push(args);
        return args[1] === "list" ? "\n" : "https://github.com/o/r/pull/9\n";
      },
      sleep: noSleep,
    });

    assert.deepEqual(pr, { url: "https://github.com/o/r/pull/9", created: true });
    assert.deepEqual(calls[1], [
      "pr", "create", "--base", "sandcastle/main", "--head", "sandcastle/issue-7",
      "--title", "Fix the parser", "--body", "Refs #7",
    ]);
  });

  it("keeps the open pull request of a rerun issue", async () => {
    const calls: string[][] = [];
    const pr = await ensurePullRequest(input, {
      run: async (args) => {
        calls.push(args);
        return "https://github.com/o/r/pull/9\n";
      },
      sleep: noSleep,
    });

    assert.deepEqual(pr, { url: "https://github.com/o/r/pull/9", created: false });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes("open"));
  });
});

describe("waitMerged", () => {
  const states = (...answers: (string | Error)[]) => {
    let call = 0;
    return async () => {
      const answer = answers[Math.min(call++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return `${answer}\n`;
    };
  };

  it("waits until GitHub marks the pull request merged", async () => {
    const state = await waitMerged("sandcastle/issue-7", "sandcastle/main", {
      run: states("OPEN", "OPEN", "MERGED"),
      sleep: noSleep,
    });
    assert.equal(state, "MERGED");
  });

  it("returns at once for a pull request closed without a merge", async () => {
    const state = await waitMerged("sandcastle/issue-7", "sandcastle/main", {
      run: states("CLOSED", "MERGED"),
      sleep: noSleep,
    });
    assert.equal(state, "CLOSED");
  });

  it("returns at once for a branch with no pull request", async () => {
    let calls = 0;
    const state = await waitMerged("sandcastle/issue-7", "sandcastle/main", {
      run: async () => {
        calls++;
        return "\n";
      },
      sleep: noSleep,
    });
    assert.equal(state, "NONE");
    assert.equal(calls, 1);
  });

  it("reports an open pull request when GitHub does not catch up", async () => {
    const state = await waitMerged("sandcastle/issue-7", "sandcastle/main", {
      run: states("OPEN"),
      sleep: noSleep,
    });
    assert.equal(state, "OPEN");
  });

  it("is UNKNOWN when GitHub cannot be read, so the branch is not deleted", async () => {
    const state = await waitMerged("sandcastle/issue-7", "sandcastle/main", {
      run: states(new Error("TLS handshake timeout")),
      sleep: noSleep,
    });
    assert.equal(state, "UNKNOWN");
  });
});

const config = {
  source: { module: "github" },
  sandbox: { module: "no-sandbox" },
  roles: Object.fromEntries(["planner", "implementer", "reviewer", "merger"].map((r) => [r, { agent: "claude-code", model: "m" }])),
  prompts: { plan: "p", implement: "i", review: "r", merge: "m" },
  gates: ["true"],
  plugins: [{ module: "github-pr" }],
};

describe("the plugin github-pr", () => {
  it("refuses the start with a source other than github", () => {
    const parsed = parseConfig(JSON.stringify(config));
    assert.doesNotThrow(() => carry(parsed));
    parsed.file.source.module = "local_md";
    assert.throws(() => carry(parsed), (error) => error instanceof ConfigError && /github-pr requires the github source, the config has local_md/.test(error.message));
  });

  /** A git that records its calls and answers like a remote that takes every push. */
  const rig = () => {
    const pushes: string[] = [];
    const notices: string[] = [];
    const git: GitRunner = (args) => {
      if (args[0] === "push") pushes.push(args.join(" "));
      return { status: 0, stdout: "" };
    };
    const context = {
      base: "main",
      refs: { remote: "origin", mirror: "sandcastle/main", branchPrefix: "sandcastle/issue-" },
      git: { commitsAhead: () => 2, isContainedIn: () => true, run: git },
      notice: (text: string) => void notices.push(text),
    } as unknown as LifecycleContext;
    const ghCalls: string[][] = [];
    const plugin = githubPrPlugin({ git, gh: { sleep: noSleep, run: async (args) => (ghCalls.push(args), args[1] === "list" ? "\n" : "https://github.com/o/r/pull/1\n") } });
    return { plugin, context, pushes, ghCalls, notices };
  };

  it("pushes the mirror at the start of an iteration", async () => {
    const { plugin, context, pushes } = rig();
    await plugin.lifecycle!.iterationStart!(context, { iteration: 1 });
    assert.deepEqual(pushes, ["push --porcelain --force origin main:refs/heads/sandcastle/main"]);
  });

  it("pushes the branch and opens its pull request when the branch is ready", async () => {
    const { plugin, context, pushes, ghCalls, notices } = rig();
    await plugin.lifecycle!.branchReady!(context, { issue: { id: "7", title: "t" }, branch: "sandcastle/issue-7", review: { outcome: "done", blocked: false } });
    assert.match(pushes[0]!, /--force-with-lease origin sandcastle\/issue-7:refs\/heads\/sandcastle\/issue-7/);
    assert.ok(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));
    assert.deepEqual(notices, ["#7: pull request https://github.com/o/r/pull/1"]);
  });

  it("opens no pull request for a branch with no commits ahead", async () => {
    const { plugin, context, pushes } = rig();
    context.git.commitsAhead = () => 0;
    await plugin.lifecycle!.branchReady!(context, { issue: { id: "7", title: "t" }, branch: "b", review: { outcome: "done", blocked: false } });
    assert.deepEqual(pushes, []);
  });

  it("warns in preflight when the remote refuses a push of the mirror, and does not push", () => {
    const calls: string[] = [];
    const plugin = githubPrPlugin({ git: (args) => (calls.push(args.join(" ")), { status: 128, stdout: "" }) });
    const found = plugin.preflight![0]!({ base: "main", refs: { remote: "origin", mirror: "sandcastle/main", branchPrefix: "p" } });
    assert.match(found.warnings![0]!, /sandcastle\/main/);
    assert.match(calls[0]!, /--dry-run/);
  });
});
