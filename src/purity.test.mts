// castle-keep must stay generic: a tool name appears only in the files of its own module,
// so the core, the prompts and the README work with any tracker, agent and plugin set.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The files git sees (tracked, and new ones not ignored), but for the lock file (a list of packages):
// installed, built, run-time and local tool files are ignored.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED = ["package-lock.json"];

// A tool name is allowed only in the files of its own module. `gh` and `bd` are
// short: they match as whole words only.
interface ToolRule {
  names: RegExp;
  files: string[];
}

// modules.mts is the registry of every module; the tests of config and hooks name the modules they load;
// the config of this repo and the test of the built exports list modules too.
const LISTS_MODULES = ["README.md", "src/index.mts", "package.json", ".sandcastle/config.json", "test/dist.test.mts", "src/modules.mts", "src/config.test.mts", "src/hooks.test.mts", "examples/config.json", "src/settings.test.mts"];
const GRAFT: ToolRule = { names: /graft/, files: ["src/plugins/graft.mts", "src/plugins/graft.test.mts"] };
const JEV: ToolRule = { names: /openrouter|jev/, files: ["src/plugins/jev.mts", "src/plugins/jev.test.mts"] };
const ORCA: ToolRule = { names: /orca/, files: ["src/plugins/orca.mts"] };
// The GitHub module is still spread over the git helpers and the retry wrapper;
// each later split shrinks the src/ part of this list, never grows it. The CI of this repo runs on GitHub.
const GITHUB: ToolRule = {
  names: /\bgh\b|github/,
  files: [
    "src/engine.test.mts", "src/gh.mts", "src/gh.test.mts", "src/git.mts", "src/git.test.mts", "src/plugins/graft.test.mts",
    "src/plugins/github-pr.mts", "src/plugins/github-pr.test.mts", "src/sources/github.mts", "src/sources/github.test.mts",
    ".github/workflows/ci.yml", ".github/workflows/publish.yml",
  ],
};
const BEADS: ToolRule = { names: /\bbd\b|beads/, files: ["src/sources/beads.mts", "src/sources/beads.test.mts"] };
const TOOLS: ToolRule[] = [GRAFT, JEV, ORCA, GITHUB, BEADS];

/** Tool names found outside the files of their module. */
function toolNamesOutside(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    if (LISTS_MODULES.includes(name)) continue;
    const lower = text.toLowerCase();
    for (const rule of TOOLS) {
      const hit = lower.match(rule.names);
      if (hit && !rule.files.includes(name)) found.push(`${name}: ${hit[0]}`);
    }
  }
  return found;
}

function sources(root: string): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout
    .split("\n")
    .filter((name) => name && !SKIPPED.includes(name) && /\.(mts|tsx|mjs|md|json|yml|example)$/.test(name))
    .map((name) => join(root, name))
    .filter((path) => existsSync(path));
}

describe("castle-keep stays generic", () => {
  const files: Record<string, string> = {};
  for (const path of sources(ROOT)) {
    if (basename(path) !== "purity.test.mts") files[relative(ROOT, path)] = readFileSync(path, "utf8");
  }

  it("reads its sources", () => {
    assert.ok(Object.keys(files).length > 20);
  });

  it("covers the prompts, the README, the self-hosting config, the CI and the scripts", () => {
    for (const name of ["README.md", "templates/plan-prompt.md", "templates/implement-prompt.md", "templates/review-prompt.md", "templates/merge-prompt.md", "templates/CODING_STANDARDS.md", ".sandcastle/config.json", ".sandcastle/implement-prompt.md", ".github/workflows/ci.yml", "scripts/snapshot.mjs", "test/dist.test.mts"]) {
      assert.ok(name in files, name);
    }
  });

  it("names a tool only in the module of that tool", () => {
    assert.deepEqual(toolNamesOutside(files), []);
  });
});

describe("the purity guard", () => {
  it("fails on a tool name outside its module", () => {
    assert.deepEqual(toolNamesOutside({ "loop.mts": "calls bd and graft", "src/plugins/orca.mts": "orca" }), [
      "loop.mts: graft",
      "loop.mts: bd",
    ]);
  });

  it("lets a module and the lists of modules name their tool", () => {
    assert.deepEqual(toolNamesOutside({ "src/sources/beads.mts": "bd list", "README.md": "graft, orca, jev, bd" }), []);
  });

  it("matches gh and bd as whole words only", () => {
    assert.deepEqual(toolNamesOutside({ "a.mts": "right, high, abdomen" }), []);
  });
});
