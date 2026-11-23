// The source `github` against `gh` fixtures: the calls it makes, and the tasks it reads from the answers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BLOCKED_LABEL, READY_ISSUES_ARGS, READY_LABEL, githubSource, viewIssueArgs } from "./github.mts";

const noSleep = async () => {};

const listed = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `issue ${number}`,
  updatedAt: "2026-10-09T10:00:00Z",
  state: "OPEN",
  body: `body ${number}`,
  labels: [READY_LABEL],
  comments: [],
  blockedBy: [] as number[],
  ...extra,
});

/** A source whose `gh` answers from `answer` and records every call. */
const rig = (answer: (args: string[]) => string = () => "", settings = {}) => {
  const calls: string[][] = [];
  const source = githubSource(settings, {
    sleep: noSleep,
    attempts: 1,
    onRetry: () => {},
    run: async (args) => (calls.push(args), answer(args)),
  });
  return { source, calls };
};

describe("READY_ISSUES_ARGS", () => {
  it("asks GraphQL for the ready label and the open blockers", () => {
    const query = READY_ISSUES_ARGS.find((arg) => arg.startsWith("query="))!;

    assert.equal(READY_ISSUES_ARGS[1], "graphql");
    assert.match(query, new RegExp(`labels: \\["${READY_LABEL}"\\]`));
    assert.match(query, /blockedBy/);
    assert.match(READY_ISSUES_ARGS.at(-1)!, /select\(\.state == "OPEN"\)/);
  });
});

describe("the ready set", () => {
  it("drops a task with an open blocker and keeps the others", async () => {
    const { source } = rig(() => JSON.stringify([listed(1, { blockedBy: [2] }), listed(3, { parent: 9, comments: ["c"] })]));
    const tasks = await source.listReady();

    assert.deepEqual(tasks.map((t) => t.id), ["3"]);
    assert.deepEqual(tasks[0], {
      id: "3",
      title: "issue 3",
      body: "body 3",
      labels: [READY_LABEL],
      parent: "9",
      blockers: [],
      comments: ["c"],
      changeKey: "2026-10-09T10:00:00Z",
    });
  });

  it("asks for the configured ready label", async () => {
    const { source, calls } = rig(() => "[]", { ready: "go" });
    await source.listReady();
    assert.match(calls[0]!.join(" "), /labels: \["go"\]/);
  });

  it("throws when GitHub stays unreachable, so the loop can pause", async () => {
    const { source } = rig(() => {
      throw new Error("offline");
    });
    await assert.rejects(source.listReady(), /offline/);
  });
});

describe("the states of a task", () => {
  const stateOf = async (issue: object) => (await rig(() => JSON.stringify(issue)).source.view("1")).state;

  it("maps the labels and a closed issue to the common states", async () => {
    assert.equal(await stateOf(listed(1)), "ready");
    assert.equal(await stateOf(listed(1, { labels: [BLOCKED_LABEL] })), "needs-human");
    assert.equal(await stateOf(listed(1, { labels: ["needs-triage"] })), "needs-triage");
    assert.equal(await stateOf(listed(1, { state: "CLOSED" })), "done");
  });

  it("reads a task by its number", async () => {
    const { source, calls } = rig(() => JSON.stringify(listed(7)));
    assert.equal((await source.view("7")).title, "issue 7");
    assert.deepEqual(calls[0], viewIssueArgs("7"));
  });

  it("fails on a task that does not exist", async () => {
    await assert.rejects(rig(() => "null").source.view("7"), /no issue 7/);
  });
});

describe("handToHuman", () => {
  it("swaps the labels, then comments with the reason", async () => {
    const { source, calls } = rig();
    assert.deepEqual(await source.handToHuman("42", "needs a decision"), { ok: true });
    assert.deepEqual(calls[0], ["issue", "edit", "42", "--remove-label", READY_LABEL, "--add-label", BLOCKED_LABEL]);
    assert.deepEqual(calls[1], ["issue", "comment", "42", "--body", "sandcastle: needs a decision"]);
  });

  it("uses the configured labels", async () => {
    const { source, calls } = rig(() => "", { ready: "go", human: "stop" });
    await source.handToHuman("1", "r");
    assert.deepEqual(calls[0], ["issue", "edit", "1", "--remove-label", "go", "--add-label", "stop"]);
  });

  it("reports a failure instead of throwing", async () => {
    const { source } = rig(() => {
      throw new Error("no auth");
    });
    assert.equal((await source.handToHuman("42", "r")).ok, false);
  });
});

describe("close", () => {
  it("closes the issue", async () => {
    const { source, calls } = rig();
    await source.close("42");
    assert.deepEqual(calls, [["issue", "close", "42", "--comment", "Completed by Sandcastle"]]);
  });
});

describe("the writes of the CLI", () => {
  it("comments and replaces the body", async () => {
    const { source, calls } = rig();
    await source.comment("5", "hello");
    await source.edit("5", "new body");
    assert.deepEqual(calls, [
      ["issue", "comment", "5", "--body", "hello"],
      ["issue", "edit", "5", "--body", "new body"],
    ]);
  });

  it("creates a follow-up in a state, with its parent and the follow-up line", async () => {
    const { source, calls } = rig((args) => (args[0] === "issue" ? "https://github.com/o/r/issues/77\n" : "555\n"));
    const created = await source.create({ title: "t", body: "b", state: "ready", parent: "3", followUpOf: "9" });

    assert.deepEqual(created, { id: "77" });
    assert.deepEqual(calls[0], ["issue", "create", "--title", "t", "--body", "b\n\nFollow-up of #9\n", "--label", READY_LABEL]);
    assert.deepEqual(calls[2], ["api", "--method", "POST", "repos/{owner}/{repo}/issues/3/sub_issues", "-F", "sub_issue_id=555"]);
  });

  it("files a new task as needs-triage by default", async () => {
    const { source, calls } = rig(() => "https://github.com/o/r/issues/8");
    await source.create({ title: "t", body: "b" });
    assert.deepEqual(calls[0]!.slice(-2), ["--label", "needs-triage"]);
  });

  it("makes a task wait for a blocker by its database id", async () => {
    const { source, calls } = rig(() => "321\n");
    await source.block("10", "4");
    assert.deepEqual(calls[1], ["api", "--method", "POST", "repos/{owner}/{repo}/issues/10/dependencies/blocked_by", "-F", "issue_id=321"]);
  });
});
