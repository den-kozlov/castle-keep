import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeElements, formatLine, initialState, reduce, tabTitle, type RunEvent, type RunState } from "./events.mts";

const fold = (events: RunEvent[], start: RunState = initialState()) =>
  events.reduce((state, event) => reduce(state, event, 1_000), start);

const queued: RunEvent = {
  type: "agent-queued",
  key: "#7",
  issue: "7",
  title: "Fix",
  model: "sonnet",
  iteration: 1,
};

describe("reduce", () => {
  it("turns a queued issue into a running implementer, then a reviewer", () => {
    const state = fold([
      { type: "phase", phase: "plan", iteration: 1 },
      queued,
      { type: "agent-start", key: "#7", role: "implementer", logPath: "/l/i", iteration: 1 },
      { type: "agent-activity", key: "#7", kind: "tool", text: "Bash(ls)" },
      { type: "agent-activity", key: "#7", kind: "text", text: "Thinking\n now" },
      { type: "agent-commits", key: "#7", commits: 2 },
      { type: "agent-start", key: "#7", role: "reviewer", logPath: "/l/r", iteration: 1 },
    ]);

    const row = state.agents[0]!;
    assert.equal(row.role, "reviewer");
    assert.equal(row.title, "Fix");
    assert.equal(row.commits, 2);
    assert.equal(row.tools, 0);
    assert.equal(row.logPath, "/l/r");
  });

  it("keeps the body and the task start time when the reviewer takes over", () => {
    let state = reduce(initialState(), { ...queued, body: "Do it." } as RunEvent, 1_000);
    state = reduce(state, { type: "agent-start", key: "#7", role: "implementer", logPath: "/l/i", iteration: 1 }, 2_000);
    state = reduce(state, { type: "agent-start", key: "#7", role: "reviewer", logPath: "/l/r", iteration: 1 }, 9_000);

    const row = state.agents[0]!;
    assert.equal(row.body, "Do it.");
    assert.equal(row.taskStartedAt, 2_000);
    assert.equal(row.startedAt, 9_000);
  });

  it("counts tool calls and keeps the last action on one line", () => {
    const state = fold([
      { type: "agent-start", key: "planner", role: "planner", logPath: "/p", iteration: 1 },
      { type: "agent-activity", key: "planner", kind: "tool", text: "Read(a)" },
      { type: "agent-activity", key: "planner", kind: "text", text: "a\n  b" },
    ]);

    assert.equal(state.agents[0]!.tools, 1);
    assert.equal(state.agents[0]!.last, "a b");
  });

  it("keeps the newest context size of an agent", () => {
    const state = fold([
      { type: "agent-start", key: "#7", role: "implementer", logPath: "/l/i", iteration: 1 },
      { type: "agent-context", key: "#7", tokens: 12_000 },
      { type: "agent-context", key: "#7", tokens: 48_500 },
    ]);

    assert.equal(state.agents[0]!.context, 48_500);
  });

  it("moves finished agents into history when a new iteration starts", () => {
    const state = fold([
      { type: "phase", phase: "plan", iteration: 1 },
      { type: "agent-start", key: "planner", role: "planner", logPath: "/p", iteration: 1 },
      { type: "agent-end", key: "planner", outcome: "done" },
      { type: "phase", phase: "plan", iteration: 2 },
    ]);

    assert.deepEqual(state.agents, []);
    assert.equal(state.history[0]!.key, "planner");
    assert.equal(state.iteration, 2);
  });

  it("holds a wait until the next phase", () => {
    const waiting = fold([{ type: "wait", until: new Date(5_000), reason: "no ready issues" }]);
    assert.equal(waiting.phase, "wait");
    assert.equal(waiting.waitUntil, 5_000);

    const polling = reduce(waiting, { type: "phase", phase: "poll" });
    assert.equal(polling.waitUntil, undefined);
  });
});

describe("tabTitle", () => {
  it("counts the issues at work and the issues left during the execute phase", () => {
    let state = fold([
      { type: "phase", phase: "plan", iteration: 1 },
      { type: "agent-start", key: "planner", role: "planner", logPath: "/p", iteration: 1 },
      { type: "agent-end", key: "planner", outcome: "done" },
      queued,
      { ...queued, key: "#8", issue: "8" },
      { ...queued, key: "#9", issue: "9" },
      { type: "phase", phase: "execute", iteration: 1 },
      { type: "agent-start", key: "#7", role: "implementer", logPath: "/l/i", iteration: 1 },
    ]);
    assert.equal(tabTitle(state), "SC w[1/3]");

    state = fold([{ type: "agent-end", key: "#7", outcome: "done" }], state);
    assert.equal(tabTitle(state), "SC w[0/2]");

    state = fold([{ type: "agent-start", key: "#8", role: "implementer", logPath: "/l/j", iteration: 1 }], state);
    assert.equal(tabTitle(state), "SC w[1/2]");
    assert.equal(tabTitle(reduce(state, { type: "stop", request: "soft" })), "SC ■w[1/2]");
  });

  it("shows the phase letter, and the time left in a pause", () => {
    assert.equal(tabTitle(initialState()), "SC ·");
    assert.equal(tabTitle(fold([{ type: "phase", phase: "merge" }])), "SC m");
    assert.equal(tabTitle(fold([{ type: "phase", phase: "done" }])), "SC ✓");
    const paused = fold([{ type: "wait", until: new Date(90 * 60_000), reason: "no ready issues" }]);
    assert.equal(tabTitle(paused, 0), "SC z 1h30");
    assert.equal(tabTitle(paused, 80 * 60_000), "SC z 10m");
  });
});

describe("formatLine", () => {
  it("prints an iteration header and an agent outcome", () => {
    assert.match(formatLine({ type: "phase", phase: "plan", iteration: 3 }) ?? "", /Iteration 3/);
    assert.equal(
      formatLine({ type: "agent-end", key: "#7", outcome: "failed", note: "boom" }),
      "  ✗ #7 failed: boom",
    );
  });

  it("keeps the busy events out of the plain log", () => {
    assert.equal(formatLine({ type: "agent-activity", key: "#7", kind: "tool", text: "x" }), undefined);
    assert.equal(formatLine({ type: "agent-context", key: "#7", tokens: 1 }), undefined);
  });
});

describe("header elements", () => {
  it("fold into the state by plugin and print as one line in batch mode", () => {
    const elements = [
      { kind: "meter" as const, label: "5h", percent: 91.2, stop: 90, resetsAt: new Date("2026-10-02T12:00:00Z") },
      { kind: "meter" as const, label: "7d" },
      { kind: "text" as const, text: "via api" },
      { kind: "badge" as const, text: "ok", level: "ok" as const },
    ];
    const state = reduce(initialState(), { type: "header", plugin: "claude-limits", elements });
    assert.deepEqual(state.header["claude-limits"], elements);
    assert.match(formatLine({ type: "header", plugin: "claude-limits", elements }) ?? "", /^\[claude-limits\] 5h 91% \(stop 90%, resets .*\) · 7d --% · via api · ok$/);
    assert.equal(describeElements([]), "");
    assert.equal(formatLine({ type: "header", plugin: "x", elements: [] }), undefined);
  });

  it("keeps one note per agent row", () => {
    let state = reduce(initialState(), { type: "agent-start", key: "#1", role: "implementer", logPath: "/l", iteration: 1 });
    state = reduce(state, { type: "agent-note", key: "#1", text: "first" });
    state = reduce(state, { type: "agent-note", key: "#1", text: "second" });
    assert.equal(state.agents[0]?.note, "second");
  });
});
