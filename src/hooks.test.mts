import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { carry, parseConfig, resolveHarness } from "./config.mts";
import { hookCommand, parseHooks, runHook } from "./hooks.mts";

describe("parseHooks", () => {
  it("spreads * over both places and reads intervals", () => {
    const { table, errors } = parseHooks({
      "*.worktreeBuildup": ["a.sh"],
      "host.periodic": [{ run: "b.mjs", interval: "2h" }],
    });
    assert.deepEqual(errors, []);
    assert.equal(table.host.worktreeBuildup[0]?.run, "a.sh");
    assert.equal(table.sandbox.worktreeBuildup[0]?.run, "a.sh");
    assert.equal(table.host.periodic[0]?.intervalMs, 2 * 3_600_000);
  });
});

describe("a hook script", () => {
  const dir = mkdtempSync(join(tmpdir(), "castle-keep-hook-"));
  const script = join(dir, "show.sh");
  writeFileSync(script, 'echo "$CASTLE_KEEP_WORKTREE|$CASTLE_KEEP_TASK|$CASTLE_KEEP_ROLE"\n');
  chmodSync(script, 0o755);
  const context = { worktree: "/some/work tree", task: "42", role: "implementer" };

  it("receives the worktree path, the task id and the role on the host", async () => {
    const done = await runHook({ run: script }, context);
    assert.equal(done.stdout.trim(), "/some/work tree|42|implementer");
  });

  it("receives them in the command a sandbox runs", () => {
    const out = spawnSync("sh", ["-c", hookCommand({ run: script }, context)], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), "/some/work tree|42|implementer");
  });

  it("takes the working directory as the worktree when the context has none", () => {
    const out = spawnSync("sh", ["-c", hookCommand({ run: script }, { task: "7", role: "merger" })], { cwd: dir, encoding: "utf8" });
    assert.equal(out.stdout.trim(), `${realpathSync(dir)}|7|merger`);
  });

  it("runs a script by extension and a shell command as it is", async () => {
    const mjs = join(dir, "show.mjs");
    writeFileSync(mjs, "console.log(process.env.CASTLE_KEEP_TASK)\n");
    assert.equal((await runHook({ run: mjs }, context)).stdout.trim(), "42");
    assert.equal((await runHook({ run: 'echo "$CASTLE_KEEP_ROLE"' }, context)).stdout.trim(), "implementer");
  });

  it("is passed through the harness teardown and sandbox hooks", async () => {
    const parsed = parseConfig(
      JSON.stringify({
        source: { module: "github" },
        sandbox: { module: "no-sandbox" },
        roles: Object.fromEntries(["planner", "implementer", "reviewer", "merger"].map((r) => [r, { agent: "claude-code", model: "m" }])),
        prompts: { plan: "p", implement: "i", review: "r", merge: "m" },
        gates: ["g"],
        hooks: { "host.worktreeTeardown": [script], "sandbox.worktreeBuildup": [script] },
      }),
    );
    const h = resolveHarness(parsed, carry(parsed), dir);
    const commands = h.hooksFor({ task: "9", role: "implementer" }).sandbox?.onSandboxReady ?? [];
    assert.match(commands[0]!.command, /CASTLE_KEEP_TASK='9'/);
    const warnings: string[] = [];
    await h.teardown({ worktree: dir, task: "9", role: "implementer" }, (w) => warnings.push(w));
    assert.deepEqual(warnings, []);
  });
});
