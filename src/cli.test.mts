// The `castle-keep task` commands against an in-memory source.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTaskCommand } from "./cli.mts";
import { memorySource } from "./memory-source.mts";

const run = async (argv: string[], files: Record<string, string> = {}) => {
  const source = memorySource([{ id: "1", title: "the task", body: "- [ ] a", comments: ["first"] }, { id: "2" }]);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTaskCommand(argv, source, { out: (t) => out.push(t), err: (t) => err.push(t), readFile: (p) => files[p] ?? "" });
  return { source, code, out: out.join("\n"), err: err.join("\n") };
};

describe("castle-keep task", () => {
  it("view prints the task with its body and comments", async () => {
    const r = await run(["view", "1"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /#1 \[ready\] the task/);
    assert.match(r.out, /- \[ \] a/);
    assert.match(r.out, /first/);
  });

  it("view --json prints the task as JSON", async () => {
    const r = await run(["view", "1", "--json"]);
    assert.equal(JSON.parse(r.out).title, "the task");
  });

  it("comment adds a comment from --body or --body-file", async () => {
    assert.deepEqual((await run(["comment", "1", "--body", "hi"])).source.log, ["comment 1 hi"]);
    assert.deepEqual((await run(["comment", "1", "--body-file", "f"], { f: "from file" })).source.log, ["comment 1 from file"]);
  });

  it("edit replaces the body, which ticks a criterion", async () => {
    const r = await run(["edit", "1", "--body-file", "f"], { f: "- [x] a" });
    assert.equal(r.source.tasks.get("1")!.body, "- [x] a");
  });

  it("create makes a follow-up in a state with its parent", async () => {
    const r = await run(["create", "--title", "next", "--body", "do it", "--state", "ready", "--parent", "2", "--follow-up-of", "1"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /created #100/);
    const made = r.source.tasks.get("100")!;
    assert.equal(made.state, "ready");
    assert.equal(made.parent, "2");
    assert.match(made.body, /Follow-up of #1$/);
  });

  it("create files needs-triage by default", async () => {
    assert.equal((await run(["create", "--title", "t", "--body", "b"])).source.tasks.get("100")!.state, "needs-triage");
  });

  it("block makes a task wait for another", async () => {
    const r = await run(["block", "1", "2"]);
    assert.deepEqual(r.source.tasks.get("1")!.blockers, ["2"]);
  });

  it("needs-human hands the task over with the reason", async () => {
    const r = await run(["needs-human", "1", "--reason", "a decision"]);
    assert.equal(r.source.tasks.get("1")!.state, "needs-human");
    assert.deepEqual(r.source.log, ["needs-human 1 a decision"]);
  });

  it("answers a usage error with 2 and the usage", async () => {
    for (const argv of [[], ["nope"], ["view"], ["comment", "1"], ["create", "--body", "b"], ["create", "--title", "t", "--body", "b", "--state", "x"], ["block", "1"], ["needs-human", "1"]]) {
      const r = await run(argv);
      assert.equal(r.code, 2, argv.join(" "));
      assert.match(r.err, /usage: castle-keep task/);
    }
  });

  it("answers a failing source with 1 and its reason", async () => {
    const r = await run(["view", "99"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /failed: no task 99/);
  });
});
