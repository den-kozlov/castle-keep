import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitRunner } from "./git.mts";
import { preflight } from "./preflight.mts";

const allFiles = new Set([".sandcastle/.env"]);

const env = { CLAUDE_CODE_OAUTH_TOKEN: "t" };

const git =
  (answers: Record<string, { status: number; stdout: string }> = {}): GitRunner =>
  (args) =>
    answers[args.join(" ")] ?? { status: args[0] === "rev-parse" ? 1 : 0, stdout: "" };

const run = (overrides: Partial<Parameters<typeof preflight>[0]> = {}) =>
  preflight({
    base: "main",
    env,
    authEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    exists: (path) => allFiles.has(path),
    git: git(),
    ...overrides,
  });

describe("preflight", () => {
  it("passes a ready checkout on main", () => {
    assert.deepEqual(run(), { errors: [], warnings: [], confirmBase: false });
  });

  it("refuses a missing token", () => {
    const result = run({ env: {} });

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("adds the errors and warnings of the extra checks", () => {
    const result = run({ checks: [() => ({ warnings: ["a warning"] }), () => ({ errors: ["an error"] })] });

    assert.deepEqual(result.errors, ["an error"]);
    assert.deepEqual(result.warnings, ["a warning"]);
  });

  it("asks to confirm a base other than the configured one", () => {
    assert.equal(run({ base: "dev", expectedBase: "dev" }).confirmBase, false);
    assert.equal(run({ base: "main", expectedBase: "dev" }).confirmBase, true);
  });

  it("refuses a missing key of the task source, naming it", () => {
    const result = run({ source: { env: ["CASTLE_TEST_TOKEN_UNSET"] } });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /CASTLE_TEST_TOKEN_UNSET/);
    assert.deepEqual(run({ source: { env: ["TOKEN"] }, env: { ...env, TOKEN: "x" } }).errors, []);
  });

  it("shows the findings of the source itself", () => {
    const result = run({ source: { env: [], preflight: () => ({ errors: ["not signed in"], warnings: ["slow"] }) } });
    assert.deepEqual(result.errors, ["not signed in"]);
    assert.deepEqual(result.warnings, ["slow"]);
  });

  it("refuses a missing env file", () => {
    const result = run({ env: {}, exists: () => false });

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /no \.sandcastle\/\.env/);
  });

  it("refuses a dirty checkout", () => {
    const result = run({ git: git({ "status --porcelain": { status: 0, stdout: " M a.rs\n" } }) });

    assert.match(result.errors.join(), /not clean/);
  });

  it("refuses an unfinished merge", () => {
    const result = run({
      git: git({ "rev-parse --verify --quiet MERGE_HEAD": { status: 0, stdout: "abc" } }),
    });

    assert.match(result.errors.join(), /unfinished merge/);
  });

  it("warns and asks on a base other than main", () => {
    const result = run({ base: "dev" });

    assert.equal(result.confirmBase, true);
    assert.match(result.warnings.join(), /base branch is dev/);
  });

  it("warns about leftover worktrees and branches", () => {
    const result = run({
      git: git({
        "worktree list --porcelain": {
          status: 0,
          stdout: "worktree /r\n\nworktree /r/.sandcastle/worktrees/issue-1\n",
        },
        "branch --list sandcastle/issue-*": { status: 0, stdout: "  sandcastle/issue-1\n" },
      }),
    });

    assert.equal(result.warnings.length, 2);
  });
});
