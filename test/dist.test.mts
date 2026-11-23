// The built package runs on plain node: no tsx, no type stripping. `npm test` builds first (pretest).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "dist", "bin.mjs");

const bin = (args: string[], cwd = ROOT) => {
  const env = { ...process.env, NODE_OPTIONS: "" };
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8" });
};

describe("the built bin", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("exists: run `npm run build`", () => {
    assert.ok(existsSync(BIN), BIN);
  });

  it("prints the usage on --help", () => {
    const r = bin(["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /castle-keep init/);
    assert.match(r.stdout, /castle-keep task/);
  });

  it("prints the version of the package", () => {
    const r = bin(["--version"]);
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal(r.stdout.trim(), manifest.version);
  });

  it("prints the init options on init --help", () => {
    const r = bin(["init", "--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--source <module>/);
  });

  it("writes a config and the templates from dist", () => {
    const dir = mkdtempSync(join(tmpdir(), "castle-keep-dist-"));
    dirs.push(dir);
    const r = bin(["init", "--source", "local_md", "--gate", "npm test", "--plugin", "claude-limits"], dir);
    assert.equal(r.status, 0, r.stderr);
    const config = JSON.parse(readFileSync(join(dir, ".sandcastle", "config.json"), "utf8"));
    assert.equal(config.source.module, "local_md");
    assert.deepEqual(config.gates, ["npm test"]);
    for (const file of ["plan-prompt.md", "implement-prompt.md", "review-prompt.md", "merge-prompt.md", "CODING_STANDARDS.md", ".env.example"]) {
      assert.ok(existsSync(join(dir, ".sandcastle", file)), file);
    }
  });

  it("refuses a task command without a config", () => {
    const dir = mkdtempSync(join(tmpdir(), "castle-keep-dist-"));
    dirs.push(dir);
    const r = bin(["task", "view", "1"], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no \.sandcastle\/config\.json/);
  });

  it("lists run in the usage", () => {
    assert.match(bin(["--help"]).stdout, /castle-keep run/);
  });

  it("refuses to run without a config and without a terminal", () => {
    const dir = mkdtempSync(join(tmpdir(), "castle-keep-dist-"));
    dirs.push(dir);
    const r = bin(["run", "--batch"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refuses to start/);
  });

  it("loads the loop on run and stops at the preflight without .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "castle-keep-dist-"));
    dirs.push(dir);
    assert.equal(bin(["init", "--source", "local_md", "--gate", "true"], dir).status, 0);
    const r = bin(["run", "--batch", "--iterations", "1"], dir);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /refuses to start:[\s\S]*\.sandcastle\/\.env/);
  });

  it("loads the public API of the package", async () => {
    const api = await import(join(ROOT, "dist", "index.mjs"));
    for (const name of ["runSandcastle", "parseConfig", "runTaskCommand", "githubSource", "claudeLimits", "githubPrPlugin"]) {
      assert.equal(typeof api[name], "function", name);
    }
  });
});
