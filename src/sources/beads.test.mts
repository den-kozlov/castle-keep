// The source `beads` against `bd --json` fixtures recorded from Beads 1.3.4: the calls it makes, and the tasks it reads.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTaskCommand } from "../cli.mts";
import { beadsSource } from "./beads.mts";

const dep = (id: string, type: string, status = "open") => ({ id, title: id, status, priority: 2, issue_type: "task", dependency_type: type });

const shown = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  description: `body ${id}`,
  status: "open",
  priority: 2,
  issue_type: "task",
  created_at: "2026-11-23T19:26:37Z",
  updated_at: "2026-11-23T19:26:37Z",
  labels: [] as string[],
  dependencies: [] as unknown[],
  comments: [] as unknown[],
  ...extra,
});

/** `bd ready --json` lists neither labels nor text. */
const readyRow = (id: string) => ({ id, title: `title ${id}`, status: "open", priority: 2, issue_type: "task", updated_at: "2026-11-23T19:26:37Z" });

/** A source whose `bd` answers from `answer` and records every call. */
const rig = (answer: (args: string[]) => string = () => "", installed = true) => {
  const calls: string[][] = [];
  const source = beadsSource({ run: async (args) => (calls.push(args), answer(args)), installed: () => installed });
  return { source, calls };
};

describe("the ready set", () => {
  it("asks bd ready, then reads each issue whole, and drops one with an open blocker", async () => {
    const { source, calls } = rig((args) => {
      if (args[0] === "ready") return JSON.stringify([readyRow("p-1"), readyRow("p-2"), readyRow("p-3")]);
      return JSON.stringify([
        shown("p-1", { dependencies: [dep("p-9", "blocks")] }),
        shown("p-2", { labels: ["needs-triage"] }),
        shown("p-3", { dependencies: [dep("p-8", "blocks", "closed"), dep("p-7", "parent-child")], comments: [{ text: "c" }], parent: "p-7" }),
      ]);
    });
    const tasks = await source.listReady();

    assert.deepEqual(calls[0], ["ready", "--json", "--limit", "0", "--exclude-type", "epic", "--exclude-label", "needs-human,needs-triage"]);
    assert.deepEqual(calls[1], ["show", "p-1", "p-2", "p-3", "--json", "--include-comments"]);
    assert.deepEqual(tasks, [
      { id: "p-3", title: "title p-3", body: "body p-3", labels: [], parent: "p-7", blockers: [], comments: ["c"], changeKey: "2026-11-23T19:26:37Z/1" },
    ]);
  });

  it("reads nothing more when nothing is ready", async () => {
    const { source, calls } = rig(() => "[]");
    assert.deepEqual(await source.listReady(), []);
    assert.equal(calls.length, 1);
  });

  it("throws when bd fails, so the loop can pause", async () => {
    const { source } = rig(() => {
      throw new Error("no beads database found");
    });
    await assert.rejects(source.listReady(), /no beads database/);
  });
});

describe("a task", () => {
  const view = async (issue: object) => (await rig(() => JSON.stringify([issue])).source.view("p-1"));

  it("maps status and labels to the common states", async () => {
    assert.equal((await view(shown("p-1"))).state, "ready");
    assert.equal((await view(shown("p-1", { labels: ["needs-human"] }))).state, "needs-human");
    assert.equal((await view(shown("p-1", { labels: ["needs-triage"] }))).state, "needs-triage");
    assert.equal((await view(shown("p-1", { status: "closed", labels: ["needs-human"] }))).state, "done");
  });

  it("reads the open blockers and the parent from the dependencies", async () => {
    const task = await view(shown("p-1", { dependencies: [dep("p-2", "blocks"), dep("p-3", "blocks", "closed"), dep("p-4", "parent-child"), dep("p-5", "discovered-from")] }));
    assert.deepEqual(task.blockers, ["p-2"]);
    assert.equal(task.parent, "p-4");
  });

  it("fails on an unknown id", async () => {
    await assert.rejects(rig(() => "[]").source.view("p-9"), /no issue p-9/);
  });
});

describe("preflight", () => {
  it("fails with a clear message when bd is missing", () => {
    assert.match(rig(() => "", false).source.preflight!().errors![0]!, /bd is not installed/);
  });

  it("passes when bd is installed", () => {
    assert.deepEqual(rig().source.preflight!(), {});
  });
});

describe("the task commands through a fake bd", () => {
  const cli = async (argv: string[], answer: (args: string[]) => string = () => "") => {
    const { source, calls } = rig(answer);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTaskCommand(argv, source, { out: (t) => out.push(t), err: (t) => err.push(t), readFile: () => "from file" });
    return { code, calls, out: out.join("\n"), err: err.join("\n") };
  };

  it("view shows the task", async () => {
    const r = await cli(["view", "p-1"], () => JSON.stringify([shown("p-1")]));
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls, [["show", "p-1", "--json", "--include-comments"]]);
    assert.match(r.out, /#p-1 \[ready\] title p-1/);
  });

  it("comment passes the body after --", async () => {
    const r = await cli(["comment", "p-1", "--body", "dash"]);
    assert.deepEqual(r.calls, [["comment", "p-1", "--", "dash"]]);
  });

  it("edit replaces the description", async () => {
    const r = await cli(["edit", "p-1", "--body-file", "f"]);
    assert.deepEqual(r.calls, [["update", "p-1", "--description", "from file"]]);
  });

  it("create passes state label, parent and the follow-up line, and prints the new id", async () => {
    const r = await cli(["create", "--title", "next", "--body", "do it", "--state", "needs-human", "--parent", "p-2", "--follow-up-of", "p-1"], () => "p-5\n");
    assert.deepEqual(r.calls, [["create", "next", "--description", "do it\n\nFollow-up of #p-1\n", "--silent", "--labels", "needs-human", "--parent", "p-2"]]);
    assert.match(r.out, /created #p-5/);
  });

  it("create in state ready adds no label", async () => {
    const r = await cli(["create", "--title", "t", "--body", "b", "--state", "ready"], () => "p-6");
    assert.deepEqual(r.calls, [["create", "t", "--description", "b", "--silent"]]);
  });

  it("create files needs-triage by default", async () => {
    const r = await cli(["create", "--title", "t", "--body", "b"], () => "p-6");
    assert.deepEqual(r.calls[0]!.slice(-2), ["--labels", "needs-triage"]);
  });

  it("block adds a blocks dependency", async () => {
    const r = await cli(["block", "p-1", "p-2"]);
    assert.deepEqual(r.calls, [["dep", "add", "p-1", "p-2"]]);
  });

  it("needs-human swaps the label and comments the reason", async () => {
    const r = await cli(["needs-human", "p-1", "--reason", "a decision"]);
    assert.deepEqual(r.calls, [
      ["update", "p-1", "--add-label", "needs-human", "--remove-label", "needs-triage"],
      ["comment", "p-1", "--", "sandcastle: a decision"],
    ]);
  });

  it("needs-human answers 1 when bd fails", async () => {
    const r = await cli(["needs-human", "p-1", "--reason", "x"], () => {
      throw new Error("bd down");
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /bd down/);
  });

  it("close, which the host does after the merge", async () => {
    const { source, calls } = rig();
    await source.close("p-1");
    assert.deepEqual(calls, [["close", "p-1", "--reason", "Completed by Sandcastle"]]);
  });
});
