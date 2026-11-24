// The loop with a fake source, agent and sandbox: what a closed gate does to
// each step, and the order of the lifecycle hooks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carry, parseConfig, resolveHarness, type Harness } from "./config.mts";
import { Control } from "./control.mts";
import { runLoop, type LoopDeps } from "./engine.mts";
import type { RunEvent } from "./events.mts";
import { memorySource, type MemorySource } from "./memory-source.mts";
import type { Plugin, Step } from "./plugin.mts";
import { githubPrPlugin } from "./plugins/github-pr.mts";

const config = {
  source: { module: "github" },
  sandbox: { module: "no-sandbox" },
  roles: {
    planner: { agent: "claude-code", model: "p" },
    implementer: { agent: "claude-code", model: "i" },
    reviewer: { agent: "claude-code", model: "r" },
    merger: { agent: "claude-code", model: "m" },
  },
  prompts: { plan: "p", implement: "i", review: "r", merge: "m" },
  gates: ["true"],
};

const harnessWith = (plugins: Plugin[], source: MemorySource): Harness => {
  const parsed = parseConfig(JSON.stringify(config));
  const carried = carry(parsed);
  carried.plugins = plugins;
  carried.source = source;
  return resolveHarness(parsed, carried);
};

/** A run on fakes. `calls` lists the agents that started, in order. */
function rig(plugins: Plugin[], mode: "batch" | "endless", opts: { signal?: string; later?: Plugin[] } = {}) {
  const source = memorySource([{ id: "1", title: "t", body: "b" }]);
  const harness = harnessWith(plugins, source);
  // `later`: the plugins the config names from its second read on.
  const laterHarness = opts.later ? harnessWith(opts.later, source) : harness;
  let reads = 0;
  const control = new Control();
  const events: RunEvent[] = [];
  const calls: string[] = [];
  let closed = 0;
  const deps: Partial<LoopDeps> = {
    sandcastle: {
      run: async (options: any) => {
        calls.push(options.name);
        return options.name === "planner"
          ? { output: { issues: [{ id: "1", title: "t", branch: "sandcastle/issue-1" }] }, stdout: "" }
          : { stdout: "" };
      },
      createSandbox: async () => ({
        worktreePath: "/w",
        run: async (options: any) => {
          calls.push(options.name);
          return {
            stdout: opts.signal ? `<promise>NEEDS-HUMAN</promise>\n${opts.signal}` : "",
            completionSignal: opts.signal ? "<promise>NEEDS-HUMAN</promise>" : "<promise>COMPLETE</promise>",
          };
        },
        close: async () => void closed++,
      }),
    } as unknown as LoopDeps["sandcastle"],
    commitsAhead: (base) => (base === "main" ? 1 : 0),
    isContainedIn: () => true,
    deleteMergedBranch: () => true,
    readCheckout: () => ({ unfinished: null, dirty: [] }),
    makeDir: () => {},
  };
  const logRun = {
    dir: "/l",
    orchestratorPath: "/l/o.log",
    startIteration: (iteration: number) => ({
      iteration,
      dir: "/l/1",
      file: (_branch: string, name: string) => ({ type: "file" as const, path: `/l/${name}.log` }),
    }),
  };
  const run = () =>
    runLoop({
      harness,
      reader: { read: () => ({ ok: true, harness: reads++ === 0 ? harness : laterHarness }) },
      mode,
      maxIterations: 1,
      base: "main",
      control,
      logRun,
      emit: (event) => events.push(event),
      deps,
    });
  return { run, control, events, calls, source, closed: () => closed };
}

/** A plugin whose gate closes `step` for the first `times` checks. */
const closing = (step: Step, times: number, until?: () => Date): Plugin & { asked: Step[] } => {
  let left = times;
  const asked: Step[] = [];
  return {
    name: "fake-gate",
    asked,
    gate: {
      check: (event) => {
        asked.push(event.step);
        if (event.step !== step || left <= 0) return { open: true };
        left--;
        return { open: false, reason: `${step} is full`, until: until?.() };
      },
    },
  };
};

const notices = (events: RunEvent[]) => events.flatMap((e) => (e.type === "notice" ? [e.text] : []));

describe("a closed gate in the loop", () => {
  it("makes a batch run exit on review with the branch and worktree kept", async () => {
    const r = rig([closing("review", Infinity)], "batch");
    await r.run();
    assert.deepEqual(r.calls, ["planner", "implementer"]);
    assert.equal(r.closed(), 0, "the worktree stays");
    assert.ok(notices(r.events).some((text) => /review of #1 held by a gate: fake-gate: review is full/.test(text)));
    assert.ok(r.events.some((e) => e.type === "agent-end" && e.outcome === "aborted" && /sandcastle\/issue-1 kept/.test(e.note ?? "")));
  });

  it("makes an endless run wait on review until the gate opens", async () => {
    const gate = closing("review", 1, () => new Date(Date.now() + 20));
    const r = rig([gate, { name: "stopper", lifecycle: { iterationEnd: () => r.control.requestSoft() } }], "endless");
    await r.run();
    assert.deepEqual(r.calls, ["planner", "implementer", "reviewer", "merger"]);
    assert.equal(r.events.filter((e) => e.type === "wait" && /review of #1 held/.test(e.reason)).length, 1);
    assert.equal(r.closed(), 1);
  });

  it("makes a batch run exit on implement before the agent starts", async () => {
    const r = rig([closing("implement", Infinity)], "batch");
    await r.run();
    assert.deepEqual(r.calls, ["planner"]);
    assert.equal(r.closed(), 0);
    assert.ok(notices(r.events).some((text) => /no new issues start: fake-gate: implement is full/.test(text)));
  });

  it("makes a batch run exit on merge, with the merger never started", async () => {
    const r = rig([closing("merge", Infinity)], "batch");
    await r.run();
    assert.deepEqual(r.calls, ["planner", "implementer", "reviewer"]);
    assert.ok(notices(r.events).some((text) => /merge held by a gate/.test(text)));
  });

  it("holds the plan step before the planner runs", async () => {
    const r = rig([closing("plan", Infinity)], "batch");
    await r.run();
    assert.deepEqual(r.calls, []);
  });

  it("skips the periodic tasks while the periodic gate is closed", async () => {
    let ran = 0;
    const task: Plugin = { name: "tasks", tasks: [{ name: "t", run: async () => (ran++, { ran: false }) }] };
    await rig([closing("periodic", Infinity), task], "batch").run();
    assert.equal(ran, 0);
    await rig([task], "batch").run();
    assert.equal(ran, 1);
  });

  it("stops a wait on a stop request", async () => {
    const r = rig([closing("poll", Infinity)], "endless");
    const done = r.run();
    setTimeout(() => r.control.requestSoft(), 30);
    await done;
    assert.deepEqual(r.calls, []);
  });
});

describe("a plugin that is off in the config", () => {
  it("runs no more from the next read: no gate, no pre-start hook, no lifecycle hook, and its header slot is emptied", async () => {
    const asked: string[] = [];
    const off: Plugin = {
      name: "off",
      gate: { check: (event) => (asked.push(`gate ${event.step}`), { open: true }) },
      preStart: ({ role }) => (asked.push(`preStart ${role}`), undefined),
      lifecycle: { iterationStart: () => void asked.push("iterationStart"), runEnd: () => void asked.push("runEnd") },
      header: () => [{ kind: "text", text: "on" }],
    };
    // The first read still names the plugin; the read at the start of the iteration does not.
    const r = rig([off], "batch", { later: [] });
    await r.run();
    assert.deepEqual(r.calls, ["planner", "implementer", "reviewer", "merger"]);
    assert.deepEqual([...new Set(asked)], ["gate periodic", "gate poll", "gate plan"], "nothing of the plugin runs after the read without it");
    assert.equal(notices(r.events).filter((text) => /plugin off is off in the config: it runs no more/.test(text)).length, 1);
    const slots = r.events.flatMap((e) => (e.type === "header" && e.plugin === "off" ? [e.elements.length] : []));
    assert.deepEqual(slots, [1, 0]);
  });
});

describe("lifecycle hooks in the loop", () => {
  it("run in order, and a throwing hook is a warning, not a stop", async () => {
    const order: string[] = [];
    const note = (name: string) => () => void order.push(name);
    const plugin: Plugin = {
      name: "life",
      lifecycle: {
        iterationStart: note("iterationStart"),
        branchReady: () => {
          order.push("branchReady");
          throw new Error("boom");
        },
        mergeDone: note("mergeDone"),
        iterationEnd: note("iterationEnd"),
        runEnd: note("runEnd"),
      },
    };
    const r = rig([plugin], "batch");
    await r.run();
    assert.deepEqual(order, ["iterationStart", "branchReady", "mergeDone", "iterationEnd", "runEnd"]);
    assert.ok(notices(r.events).some((text) => /life branchReady failed: Error: boom/.test(text)));
    assert.deepEqual(r.calls, ["planner", "implementer", "reviewer", "merger"]);
  });

  it("are not gated", async () => {
    const order: string[] = [];
    const plugin: Plugin = { name: "life", lifecycle: { iterationStart: () => void order.push("start"), runEnd: () => void order.push("end") } };
    const r = rig([closing("merge", Infinity), plugin], "batch");
    await r.run();
    assert.deepEqual(order, ["start", "end"]);
  });

  it("get the review outcome and the merged branches", async () => {
    const seen: unknown[] = [];
    const plugin: Plugin = {
      name: "life",
      lifecycle: {
        branchReady: (_c, info) => void seen.push(info),
        mergeDone: (_c, info) => void seen.push(info),
      },
    };
    await rig([plugin], "batch").run();
    assert.deepEqual(seen, [
      { issue: { id: "1", title: "t" }, branch: "sandcastle/issue-1", review: { outcome: "done", note: "reviewer gave no architecture verdict; treated as sound", blocked: false } },
      { merged: ["sandcastle/issue-1"] },
    ]);
  });
});

describe("the pre-start hook in the loop", () => {
  it("runs for every agent role and puts the plugin's model and row note on the agent", async () => {
    const roles: string[] = [];
    const plugin: Plugin = {
      name: "pick",
      preStart: ({ role, task }) => {
        roles.push(role);
        return role === "implementer" ? { model: "cheap", note: `task ${task?.id}` } : undefined;
      },
    };
    const r = rig([plugin], "batch");
    await r.run();
    assert.deepEqual(roles, ["planner", "implementer", "reviewer", "merger"]);
    assert.ok(r.events.some((e) => e.type === "agent-start" && e.role === "implementer" && e.model === "cheap"));
    assert.ok(r.events.some((e) => e.type === "agent-note" && e.key === "#1" && e.text === "task 1"));
  });
});

describe("the task source in the loop", () => {
  it("closes a merged task: the orchestrator, not the merger agent", async () => {
    const r = rig([], "batch");
    await r.run();
    assert.deepEqual(r.source.log, ["close 1"]);
    assert.equal(r.source.tasks.get("1")!.state, "done");
  });

  it("hands a NEEDS-HUMAN task to the human with the reason, and does not close it", async () => {
    const r = rig([], "batch", { signal: "<needs-human>pick a name</needs-human>" });
    await r.run();
    const task = r.source.tasks.get("1")!;
    assert.equal(task.state, "needs-human");
    assert.match(r.source.log.join("\n"), /needs-human 1 the implementer needs a human: pick a name/);
    assert.ok(!r.source.log.includes("close 1"));
  });

  it("reads the ready tasks of the source for the planner and the plan key", async () => {
    const r = rig([], "batch");
    await r.run();
    assert.ok(r.calls.includes("planner"));
  });
});

describe("the record on the remote in the loop", () => {
  /** github-pr on a recording git; a push is any `git push`. */
  const recording = () => {
    const pushes: string[] = [];
    const plugin = githubPrPlugin({
      git: (args) => (args[0] === "push" && pushes.push(args.join(" ")), { status: 0, stdout: "" }),
      gh: { sleep: async () => {}, run: async (args) => (args[1] === "list" ? "\n" : "https://example.test/pull/1\n") },
    });
    return { plugin, pushes };
  };

  it("pushes the mirror and the branch with the plugin", async () => {
    const { plugin, pushes } = recording();
    await rig([plugin], "batch").run();
    assert.ok(pushes.some((p) => /sandcastle\/main/.test(p)), "mirror");
    assert.ok(pushes.some((p) => /force-with-lease .*sandcastle\/issue-1/.test(p)), "branch");
  });

  it("pushes nothing without the plugin", async () => {
    const { pushes } = recording();
    const r = rig([], "batch");
    await r.run();
    assert.deepEqual(pushes, []);
    assert.ok(r.calls.includes("merger"), "the run itself went through");
  });
});
