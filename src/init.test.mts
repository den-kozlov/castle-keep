// `castle-keep init` in a temp repo.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseConfig } from "./config.mts";
import { runInit } from "./init.mts";

const run = async (argv: string[], opts: { tty?: boolean; answers?: string[]; setup?: (cwd: string) => void } = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), "castle-keep-init-"));
  opts.setup?.(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const code = await runInit(argv, {
    cwd,
    tty: opts.tty ?? false,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ask: async () => answers.shift() ?? "",
  });
  return { cwd, code, out: out.join("\n"), err: err.join("\n") };
};

const ALL = [
  "--source", "local_md", "--sandbox", "no-sandbox", "--agent", "claude-code", "--model", "claude-sonnet-5-5",
  "--reviewer-model", "claude-opus-5-5", "--gate", "npm test", "--gate", "npm run lint",
  "--plugin", "claude-limits", "--plugin", '{"module":"claude-limits","fiveHourPercent":80}', "--base-branch", "trunk",
];

describe("castle-keep init", () => {
  it("with all flags writes a config the resolver accepts and copies the four prompts", async () => {
    const r = await run(ALL);
    assert.equal(r.code, 0, r.err);
    const parsed = parseConfig(readFileSync(join(r.cwd, ".sandcastle/config.json"), "utf8"));
    assert.equal(parsed.source.module, "local_md");
    assert.deepEqual(parsed.file.gates, ["npm test", "npm run lint"]);
    assert.equal(parsed.file.roles.reviewer.model, "claude-opus-5-5");
    assert.equal(parsed.file.roles.planner.model, "claude-sonnet-5-5");
    assert.equal(parsed.file.baseBranch, "trunk");
    for (const file of ["plan", "implement", "review", "merge"]) {
      assert.ok(existsSync(join(r.cwd, `.sandcastle/${file}-prompt.md`)), file);
    }
    assert.ok(existsSync(join(r.cwd, ".sandcastle/CODING_STANDARDS.md")));
    assert.match(readFileSync(join(r.cwd, ".sandcastle/.env.example"), "utf8"), /CLAUDE_CODE_OAUTH_TOKEN=/);
  });

  it("without a TTY and without a required flag exits non-zero naming the flag", async () => {
    const noSource = await run(["--gate", "npm test"]);
    assert.equal(noSource.code, 2);
    assert.match(noSource.err, /--source is needed/);
    const noGate = await run(["--source", "local_md"]);
    assert.equal(noGate.code, 2);
    assert.match(noGate.err, /--gate is needed/);
    assert.ok(!existsSync(join(noGate.cwd, ".sandcastle/config.json")));
  });

  it("on a TTY asks for the missing required flags", async () => {
    const r = await run([], { tty: true, answers: ["local_md", "npm test"] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(parseConfig(readFileSync(join(r.cwd, ".sandcastle/config.json"), "utf8")).file.gates, ["npm test"]);
  });

  it("refuses to overwrite an existing config without the overwrite flag", async () => {
    const setup = (cwd: string) => {
      mkdirSync(join(cwd, ".sandcastle"));
      writeFileSync(join(cwd, ".sandcastle/config.json"), "mine");
    };
    const refused = await run(ALL, { setup });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /--force/);
    assert.equal(readFileSync(join(refused.cwd, ".sandcastle/config.json"), "utf8"), "mine");
    const forced = await run([...ALL, "--force"], { setup });
    assert.equal(forced.code, 0, forced.err);
    assert.notEqual(readFileSync(join(forced.cwd, ".sandcastle/config.json"), "utf8"), "mine");
  });

  it("refuses to overwrite an existing prompt", async () => {
    const r = await run(ALL, {
      setup: (cwd) => {
        mkdirSync(join(cwd, ".sandcastle"));
        writeFileSync(join(cwd, ".sandcastle/plan-prompt.md"), "mine");
      },
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /plan-prompt\.md/);
    assert.ok(!existsSync(join(r.cwd, ".sandcastle/config.json")));
  });

  it("adds the local files of a run to .gitignore once, after the lines already there", async () => {
    const r = await run(ALL, { setup: (cwd) => writeFileSync(join(cwd, ".gitignore"), "node_modules/\n.sandcastle/.env\n") });
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(join(r.cwd, ".gitignore"), "utf8");
    assert.ok(text.startsWith("node_modules/\n.sandcastle/.env\n"));
    assert.equal(text.match(/^\.sandcastle\/\.env$/gm)?.length, 1);
    for (const line of [".sandcastle/logs/", ".sandcastle/worktrees/", ".sandcastle/run.pid"]) assert.ok(text.split("\n").includes(line), line);
    const again = await runInit([...ALL, "--force"], { cwd: r.cwd, tty: false, out: () => {}, err: () => {} });
    assert.equal(again, 0);
    assert.equal(readFileSync(join(r.cwd, ".gitignore"), "utf8"), text);
  });

  it("takes hook commands as <key>=<command> and prints the next steps", async () => {
    const r = await run(["--source", "local_md", "--gate", "npm test", "--hook", "sandbox.worktreeBuildup=npm ci", "--hook", "sandbox.worktreeBuildup=npm run build"]);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(readFileSync(join(r.cwd, ".sandcastle/config.json"), "utf8"));
    assert.deepEqual(parsed.hooks, { "sandbox.worktreeBuildup": ["npm ci", "npm run build"] });
    assert.match(r.out, /\.sandcastle\/\.env/);
    assert.match(r.out, /npx castle-keep run/);
    const bad = await run(["--source", "local_md", "--gate", "npm test", "--hook", "npm ci"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--hook: not <key>=<command>/);
  });

  it("rejects an unknown source with the resolver's message", async () => {
    const r = await run(["--source", "nope", "--gate", "x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown task source "nope"/);
  });
});
