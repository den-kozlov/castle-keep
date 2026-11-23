import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { Control } from "./control.mts";
import { initialState, reduce } from "./events.mts";
import { App, ConfirmQueue, lineStyle, listItems, RunStore, taskLines } from "./tui.tsx";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("listItems", () => {
  it("puts the journal first, then the agents, then the history", () => {
    let state = initialState();
    state = reduce(state, { type: "phase", phase: "plan", iteration: 1 });
    state = reduce(state, { type: "agent-start", key: "planner", role: "planner", logPath: "/p", iteration: 1 });
    state = reduce(state, { type: "agent-end", key: "planner", outcome: "done" });
    state = reduce(state, { type: "phase", phase: "plan", iteration: 2 });
    state = reduce(state, { type: "agent-start", key: "planner", role: "planner", logPath: "/p2", iteration: 2 });

    const kinds = listItems(state, "/o").map((item) => item.kind);

    assert.deepEqual(kinds, ["orchestrator", "agent", "history-header", "history"]);
  });
});

describe("lineStyle", () => {
  it("colours a tool call and dims the harness lines", () => {
    assert.equal(lineStyle("Bash(ls -la)").color, "cyan");
    assert.equal(lineStyle("Agent started").dim, true);
    assert.deepEqual(lineStyle("I am updating the badge."), {});
  });
});

describe("taskLines", () => {
  it("folds blank runs", () => {
    assert.deepEqual(taskLines("\nA\r\n\n\nB\n\n"), ["A", "", "B"]);
  });
});

describe("App", () => {
  const mount = () => {
    const store = new RunStore();
    const control = new Control();
    const app = render(
      createElement(App, { store, control, orchestratorPath: "/o/orchestrator.log", confirmations: new ConfirmQueue() }),
    );
    return { store, control, app };
  };

  it("shows a running agent with its issue and role", async () => {
    const { store, app } = mount();
    store.apply({ type: "start", mode: "endless", base: "main", logDir: "l" });
    store.apply({ type: "phase", phase: "execute", iteration: 3 });
    store.apply({
      type: "agent-start",
      key: "#441",
      role: "implementer",
      issue: "441",
      model: "claude-sonnet-5",
      logPath: "/l/i.log",
      iteration: 3,
    });
    store.apply({ type: "agent-activity", key: "#441", kind: "tool", text: "Bash(npm test)" });
    store.apply({ type: "agent-context", key: "#441", tokens: 86_300 });
    await tick();

    const frame = app.lastFrame() ?? "";
    assert.match(frame, /SANDCASTLE/);
    assert.match(frame, /#441/);
    assert.match(frame, /implementer/);
    assert.match(frame, /CTX/);
    assert.match(frame, /86k/);
    assert.match(frame, /Bash\(npm test\)/);
    app.unmount();
  });

  it("shows a plugin meter and badge in the header, and a note on the agent row", async () => {
    const { store, app } = mount();
    store.apply({
      type: "header",
      plugin: "claude-limits",
      elements: [
        { kind: "meter", label: "5h", percent: 42, warn: 75, stop: 90 },
        { kind: "badge", text: "ok", level: "ok" },
      ],
    });
    store.apply({ type: "phase", phase: "execute", iteration: 1 });
    store.apply({ type: "agent-start", key: "#9", role: "implementer", issue: "9", logPath: "/dev/null", iteration: 1 });
    store.apply({ type: "agent-note", key: "#9", text: "P(hard) 0.05" });
    await tick();
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /5h █+░* +42%/);
    assert.match(frame, /\bok\b/);
    assert.match(frame, /\[P\(hard\) 0\.05\]/);
    app.unmount();
  });

  it("shows the start time, and the task above the implementer log", async () => {
    const { store, app } = mount();
    store.apply({ type: "phase", phase: "execute", iteration: 1 });
    store.apply({
      type: "agent-queued",
      key: "#9",
      issue: "9",
      title: "Badge colour",
      body: "Paint the badge green.",
      model: "m",
      iteration: 1,
    });
    store.apply({ type: "agent-start", key: "#9", role: "implementer", logPath: "/dev/null", iteration: 1 });
    await tick();
    assert.match(app.lastFrame() ?? "", /START/);
    assert.match(app.lastFrame() ?? "", /\d\d:\d\d/);

    app.stdin.write("j");
    await tick();
    app.stdin.write("\r");
    await tick();
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /#9 Badge colour/);
    assert.match(frame, /Paint the badge green\./);

    app.stdin.write("i");
    await tick();
    assert.doesNotMatch(app.lastFrame() ?? "", /Paint the badge green\./);
    app.unmount();
  });

  it("wraps the task, scrolls it after tab, and wraps the log on w", async () => {
    const { store, app } = mount();
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-tui-"));
    const logPath = join(dir, "i.log");
    const longLine = `${"tool ".repeat(30)}END`;
    writeFileSync(logPath, `first\n${longLine}\nlast\n`);
    const body = Array.from({ length: 100 }, (_, i) => `step ${i + 1}`).join("\n");
    store.apply({ type: "phase", phase: "execute", iteration: 1 });
    store.apply({
      type: "agent-queued",
      key: "#9",
      issue: "9",
      title: "A title that is long enough to wrap around the hundred columns of the test terminal twice over",
      body,
      model: "m",
      iteration: 1,
    });
    try {
      store.apply({ type: "agent-start", key: "#9", role: "implementer", logPath, iteration: 1 });
      await tick();
      app.stdin.write("j");
      await tick();
      app.stdin.write("\r");
      await tick();
      await tick();

      let frame = app.lastFrame() ?? "";
      assert.match(frame, /twice.*\n over/, "the title wraps instead of being cut");
      assert.match(frame, /step 1\n/);
      assert.match(frame, /1\/100/);
      assert.doesNotMatch(frame, /END/, "the long log line is cut by default");
      assert.match(frame, /…/);

      app.stdin.write("\t");
      await tick();
      app.stdin.write("\u001B[B");
      await tick();
      await tick();
      frame = app.lastFrame() ?? "";
      assert.match(frame, /2\/100/);
      assert.match(frame, /step 2\n/);
      assert.doesNotMatch(frame, /step 1\n/);

      app.stdin.write("w");
      await tick();
      await tick();
      frame = app.lastFrame() ?? "";
      assert.match(frame, /END/, "the long log line wraps after w");
      assert.match(frame, /last/);
    } finally {
      app.unmount();
    }
  });

  it("toggles a soft stop with s", async () => {
    const { control, app } = mount();
    await tick();

    app.stdin.write("s");
    await tick();
    assert.equal(control.stop, "soft");

    app.stdin.write("s");
    await tick();
    assert.equal(control.stop, "none");
    app.unmount();
  });

  it("asks before a hard stop", async () => {
    const { control, app } = mount();
    await tick();

    app.stdin.write("K");
    await tick();
    assert.equal(control.stop, "none");
    assert.match(app.lastFrame() ?? "", /Hard stop\?/);

    app.stdin.write("y");
    await tick();
    assert.equal(control.stop, "hard");
    app.unmount();
  });
});
