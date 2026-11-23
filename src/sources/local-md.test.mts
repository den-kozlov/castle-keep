// The source `local_md` on a temp directory: the ready set, every CLI command, a broken file.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTaskCommand } from "../cli.mts";
import { localMdSource } from "./local-md.mts";

const rig = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "local-md-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const warnings: string[] = [];
  const source = localMdSource({ dir }, { warn: (m) => warnings.push(m), now: () => new Date("2026-11-23T10:00:00Z") });
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTaskCommand(argv, source, { out: (t) => out.push(t), err: (t) => err.push(t), readFile: (p) => readFileSync(p, "utf8") });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { dir, source, warnings, cli };
};

const task = (status: string, extra = "", body = "the body") => `---\ntitle: "t"\nstatus: ${status}\nlabels: []\n${extra}---\n${body}\n`;

describe("the ready set", () => {
  it("honours status and blocked_by; a done blocker unblocks", async () => {
    const { source } = rig({
      "1-a.md": task("done"),
      "2-b.md": task("ready", "blocked_by: [1]\n"),
      "3-c.md": task("ready", "blocked_by: [4]\n"),
      "4-d.md": task("ready"),
      "5-e.md": task("needs-human"),
      "6-f.md": task("ready", "blocked_by: [99]\n"),
      "notes.md": "not a task",
    });
    assert.deepEqual((await source.listReady()).map((t) => t.id), ["2", "4"]);
  });

  it("reads parent, labels, comments and a content-hash change key", async () => {
    const { source, dir } = rig({
      "7-x.md": `---\ntitle: "x"\nstatus: ready\nlabels: ["a"]\nparent: 3\n---\nbody\n\n<!-- comments -->\n\n### 2026-11-01T00:00:00Z\nhello\n`,
    });
    const [t] = await source.listReady();
    assert.equal(t!.parent, "3");
    assert.deepEqual(t!.labels, ["a"]);
    assert.deepEqual(t!.comments, ["hello"]);
    const key = t!.changeKey;
    await source.comment("7", "more");
    assert.notEqual((await source.listReady())[0]!.changeKey, key);
    assert.ok(readdirSync(dir).includes("7-x.md"));
  });
});

describe("a broken frontmatter", () => {
  it("warns naming the file and skips that task", async () => {
    const { source, warnings } = rig({ "1-ok.md": task("ready"), "2-bad.md": "no frontmatter", "3-bad.md": task("sleeping") });
    assert.deepEqual((await source.listReady()).map((t) => t.id), ["1"]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /2-bad\.md/);
    assert.match(warnings[1]!, /3-bad\.md/);
  });
});

describe("castle-keep task on local_md", () => {
  it("view prints the task and --json its fields", async () => {
    const { cli } = rig({ "1-a.md": task("ready") });
    assert.match((await cli(["view", "1"])).out, /#1 \[ready\] t/);
    assert.equal(JSON.parse((await cli(["view", "1", "--json"])).out).body, "the body");
    assert.equal((await cli(["view", "9"])).code, 1);
  });

  it("comment appends under the separator", async () => {
    const { cli, dir } = rig({ "1-a.md": task("ready") });
    await cli(["comment", "1", "--body", "first"]);
    await cli(["comment", "1", "--body", "second"]);
    const text = readFileSync(join(dir, "1-a.md"), "utf8");
    assert.match(text, /<!-- comments -->\n\n### 2026-11-23T10:00:00.000Z\nfirst\n\n### 2026-11-23T10:00:00.000Z\nsecond\n$/);
  });

  it("edit replaces the body and keeps the frontmatter and comments", async () => {
    const { cli, source, dir } = rig({ "1-a.md": task("ready", "parent: 5\nblocked_by: [2]\n") });
    await cli(["comment", "1", "--body", "c"]);
    writeFileSync(join(dir, "body.md"), "new body\n- [x] done\n");
    assert.equal((await cli(["edit", "1", "--body-file", join(dir, "body.md")])).code, 0);
    const t = await source.view("1");
    assert.equal(t.body, "new body\n- [x] done");
    assert.equal(t.parent, "5");
    assert.equal(t.state, "ready");
    assert.deepEqual(t.comments, ["c"]);
    assert.deepEqual(t.blockers, ["2"]);
  });

  it("create takes the next number, a slug, the parent and the follow-up line", async () => {
    const { cli, source, dir } = rig({ "4-a.md": task("ready") });
    const made = await cli(["create", "--title", "Fix the Thing!", "--body", "do it", "--state", "ready", "--parent", "4", "--follow-up-of", "4"]);
    assert.equal(made.code, 0);
    assert.ok(readdirSync(dir).includes("5-fix-the-thing.md"));
    const t = await source.view("5");
    assert.equal(t.title, "Fix the Thing!");
    assert.equal(t.parent, "4");
    assert.equal(t.body, "do it\n\nFollow-up of #4");
    assert.equal(t.state, "ready");
    await cli(["create", "--title", "u", "--body", "b"]);
    assert.equal((await source.view("6")).state, "needs-triage");
  });

  it("create makes the directory when it is missing", async () => {
    const { source, dir } = rig();
    const nested = localMdSource({ dir: join(dir, "new") });
    assert.deepEqual(await nested.create({ title: "a", body: "b" }), { id: "1" });
    assert.equal((await source.listReady()).length, 0);
  });

  it("block makes a task wait; closing the blocker frees it", async () => {
    const { cli, source } = rig({ "1-a.md": task("ready"), "2-b.md": task("ready") });
    assert.equal((await cli(["block", "1", "2"])).code, 0);
    assert.deepEqual((await source.listReady()).map((t) => t.id), ["2"]);
    await source.close("2");
    assert.deepEqual((await source.listReady()).map((t) => t.id), ["1"]);
  });

  it("needs-human hands the task over with the reason", async () => {
    const { cli, source } = rig({ "1-a.md": task("ready") });
    assert.equal((await cli(["needs-human", "1", "--reason", "decide"])).code, 0);
    const t = await source.view("1");
    assert.equal(t.state, "needs-human");
    assert.deepEqual(t.comments, ["sandcastle: decide"]);
    assert.deepEqual(await source.listReady(), []);
    assert.equal((await source.handToHuman("9", "r")).ok, false);
  });
});
