// Parallel Planner with Review — the orchestration loop
//
// One iteration runs four phases:
//   Plan:             An agent analyzes open issues, builds a dependency
//                     graph, and outputs a <plan> JSON listing unblocked issues
//                     with branch names.
//   Execute + Review: For each issue, a git worktree is created via
//                     createSandbox(). The implementer runs first (100
//                     iterations). If its branch is ahead of the base, a
//                     reviewer runs in the same worktree on the same branch (1
//                     iteration). A worker pool runs the issue pipelines,
//                     `parallelism` at a time. A reviewer that blocks the
//                     architecture keeps its branch out of the merge
//                     (./review.mts).
//   Merge:            A single agent merges all completed branches into the
//                     current branch. The harness deletes the merged branches.
//
// The orchestrator closes a merged task through the task source (./source.mts),
// not the merger agent. A mirror or pull requests of the remote belong to a
// plugin, at the lifecycle hooks (./plugin.mts).
//
// Two modes share the loop (./policy.mts):
//   endless  polls the tracker, waits with a backoff when there is no work, sleeps
//            to the reset when a limit window is full, and stops only on a
//            stop command (./control.mts).
//   batch    runs up to maxIterations and exits where endless would wait.
//
// The loop never prints. It emits events (./events.mts); the TUI or the plain
// view shows them.
//
// Every agent runs on the host, in its own git worktree under
// `.sandcastle/worktrees/`. Plugins may watch the run (./plugin.mts).
//
// Nothing of the project is a constant here: the loop reads the resolved
// harness (./config.mts). The reader of the config file hands a fresh harness
// at the start of each iteration: roles, gates and hooks follow the file.

import { mkdirSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";
import type { AgentModule } from "./agent.mts";
import type { ConfigReader, Harness, RoleName } from "./config.mts";
import type { Control, StopRequest } from "./control.mts";
import type { Phase, RunEvent } from "./events.mts";
import {
  checkCheckout,
  commitsAhead,
  deleteMergedBranch,
  deleteRemoteBranch,
  isContainedIn,
  pushBranch,
  pushedBranches,
  pushedRef,
  pushMirror,
  readCheckout,
  realGit,
  retryPush,
} from "./git.mts";
import type { IterationLogs, LogRun } from "./logs.mts";
import { Backoff, decidePoll, readySetKey, type Mode } from "./policy.mts";
import { needsHumanReason, reviewOutcome } from "./review.mts";
import type { GateAnswer, GateEvent, HostGit, IssueText, LifecycleContext, Notice } from "./plugin.mts";
import type { Task } from "./source.mts";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema.
const planSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Constants of the loop itself
// ---------------------------------------------------------------------------

// The implementer ends its loop with one of two signals. COMPLETE: the issue is
// done. NEEDS_HUMAN: only a human can go on (a decision, data, an action no agent
// may take); the branch still merges, but the issue moves to `ready-for-human`
// instead of `done`, with the reason from the `<needs-human>` tag. Without the
// second signal an agent that cannot finish reruns until maxIterations, and its
// question ends up only in a comment of a closed issue.
const COMPLETE = "<promise>COMPLETE</promise>";
const NEEDS_HUMAN = "<promise>NEEDS-HUMAN</promise>";

// A closed gate (./plugin.mts) holds its step: new work (`poll`, `plan`,
// `implement`) and `review` and `merge` wait in an endless run and end a batch
// run. Issues already running finish, and the merge phase still runs.

// How often a dirty base checkout is checked again before the merge.
const CHECKOUT_RECHECK_MS = 60_000;

// How often the commit count of a running issue is read for the view.
const COMMITS_POLL_MS = 20_000;

// How long a closed gate without a time is left alone before it is asked again.
const GATE_RECHECK_MS = 60_000;

/**
 * Runs the pre-start hooks of the plugins for one agent and builds its
 * provider. A sandbox without a container may leave out
 * --dangerously-skip-permissions, so an agent would stop at its first
 * permission prompt: the agent module forces the flag on, agents run AFK.
 */
export async function startAgent(
  h: Harness,
  role: RoleName,
  notice: Notice,
  task?: IssueText,
): Promise<{ plan: Awaited<ReturnType<Harness["preStart"]>>; agent: sandcastle.AgentProvider; runOptions: { idleTimeoutSeconds?: number } }> {
  const plan = await h.preStart({ role, task }, notice);
  const agent = h.agents[role].provider({
    model: plan.model,
    effort: plan.effort,
    noSandbox: h.sandboxModule === "no-sandbox",
    env: envOverSandbox(plan.env, h.env),
    blocks: plan.blocks,
  });
  return { plan, agent, runOptions: { idleTimeoutSeconds: plan.idleTimeout } };
}

/**
 * The sandbox of every agent: the project env, which the worktree hooks need too.
 * Sandcastle 0.12 throws on a key in both the sandbox and the agent provider env, and
 * a sandbox from createSandbox ignores the provider env, so the agent's command sets the rest.
 */
export const sandboxOf = (h: Harness) => h.sandbox(h.env);

/** The variables of `env` that `sandboxEnv` lacks or holds with another value. */
export const envOverSandbox = (env: Record<string, string>, sandboxEnv: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).filter(([key, value]) => sandboxEnv[key] !== value));

/** The seams of the loop that touch the world; a test replaces them. */
export interface LoopDeps {
  sandcastle: Pick<typeof sandcastle, "run" | "createSandbox">;
  commitsAhead: typeof commitsAhead;
  isContainedIn: typeof isContainedIn;
  deleteMergedBranch: typeof deleteMergedBranch;
  readCheckout: typeof readCheckout;
  /** Makes the config directory of the agents. */
  makeDir: (path: string) => void;
}

const realDeps = (): LoopDeps => ({
  sandcastle,
  commitsAhead,
  isContainedIn,
  deleteMergedBranch,
  readCheckout,
  makeDir: (path) => void mkdirSync(path, { recursive: true }),
});

type Issue = z.infer<typeof planSchema>["issues"][number];

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** A notice line of the run, as an event for the view. */
const noticeOf =
  (emit: (event: RunEvent) => void): Notice =>
  (text, level = "info") =>
    emit({ type: "notice", level, text });

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface LoopOptions {
  /** The harness of the first read of the config file. */
  harness: Harness;
  /** Reads the file again at the start of each iteration. */
  reader: ConfigReader;
  mode: Mode;
  /** Iterations of a batch run; ignored by an endless run. */
  maxIterations: number;
  base: string;
  control: Control;
  logRun: LogRun;
  emit: (event: RunEvent) => void;
  deps?: Partial<LoopDeps>;
}

/** What the phases need of the loop: the gates and the context of the lifecycle hooks. */
interface Hold {
  deps: LoopDeps;
  /** Asks the gates once. */
  check: (event: GateEvent) => Promise<GateAnswer>;
  /**
   * Waits at a closed gate in an endless run, until it opens or a stop comes.
   * A batch run does not wait: "closed". `resume` is the phase to show again after a wait.
   */
  wait: (event: GateEvent, what: string, resume?: Phase) => Promise<"open" | "closed" | "stopped">;
  context: () => LifecycleContext;
  gateEvent: (step: GateEvent["step"], role?: RoleName, issue?: string) => GateEvent;
}

export async function runLoop(options: LoopOptions): Promise<void> {
  const { mode, base, control, logRun, emit } = options;
  const deps: LoopDeps = { ...realDeps(), ...options.deps };
  let h = options.harness;
  const endless = mode === "endless";
  const notice = noticeOf(emit);

  deps.makeDir(h.claudeConfigDir);

  const backoff = new Backoff();
  let iteration = 0;
  let plannerFailures = 0;
  let configError: string | undefined;
  // The ready set of the last iteration that made no progress. The planner
  // does not run again on the same set; see ./policy.mts.
  let idleKey: string | undefined;

  // Waits in endless mode. Returns false when the run must end: batch mode, or
  // a stop request during the pause.
  const pause = async (reason: string, until?: Date): Promise<boolean> => {
    if (!endless) {
      notice(`${reason}. Exiting.`);
      return false;
    }
    const ms = until ? Math.max(0, until.getTime() - Date.now()) : backoff.next();
    emit({ type: "wait", until: new Date(Date.now() + ms), reason });
    const woke = await control.sleep(ms);
    if (woke === "stopped") return false;
    if (woke === "woken") {
      // "Check now": the next poll plans even an unchanged set.
      backoff.reset();
      idleKey = undefined;
    }
    return true;
  };

  // The header slot of each plugin is sent when it changes, so a batch run
  // prints a line only when a figure moved.
  const shown = new Map<string, string>();
  const check = async (event: GateEvent): Promise<GateAnswer> => {
    const answer = await h.gate(event);
    const slots = h.header();
    // The slot of a plugin that is gone from the harness is emptied.
    for (const plugin of [...shown.keys()]) {
      if (slots.some((slot) => slot.plugin === plugin)) continue;
      shown.delete(plugin);
      emit({ type: "header", plugin, elements: [] });
    }
    for (const { plugin, elements } of slots) {
      const key = JSON.stringify(elements);
      if (shown.get(plugin) === key) continue;
      shown.set(plugin, key);
      emit({ type: "header", plugin, elements });
    }
    return answer;
  };

  const wait: Hold["wait"] = async (event, what, resume) => {
    while (true) {
      const answer = await check(event);
      if (answer.open) return "open";
      const reason = `${what} held by a gate: ${answer.reason}`;
      if (!endless) {
        notice(`${reason}. Exiting.`);
        return "closed";
      }
      const ms = answer.until ? Math.max(0, answer.until.getTime() - Date.now()) : GATE_RECHECK_MS;
      emit({ type: "wait", until: new Date(Date.now() + ms), reason });
      if ((await control.sleep(ms)) === "stopped") return "stopped";
      if (resume) emit({ type: "phase", phase: resume, iteration });
    }
  };

  const git: HostGit = { commitsAhead: deps.commitsAhead, isContainedIn: deps.isContainedIn, run: realGit };
  const context = (): LifecycleContext => ({
    base,
    git,
    notice,
    source: h.source,
    refs: h.refs,
    roles: Object.fromEntries(Object.entries(h.roles).map(([role, r]) => [role, { agent: r.agent, model: r.model }])) as LifecycleContext["roles"],
  });
  const gateEvent: Hold["gateEvent"] = (step, role, issue) => ({
    step,
    ...(role ? { role, agent: h.roles[role].agent, model: h.roles[role].model } : {}),
    ...(issue ? { issue } : {}),
  });
  const hold = (): Hold => ({ deps, check, wait, context, gateEvent });

  // Reads the config again. A broken file keeps the last good read; the same
  // error is told once. A plugin that is off in the file is gone from the new
  // harness, which is told once too.
  const refresh = () => {
    const configRead = options.reader.read();
    if (configRead.ok) {
      for (const name of h.plugins) {
        if (!configRead.harness.plugins.includes(name)) notice(`plugin ${name} is off in the config: it runs no more`);
      }
      h = configRead.harness;
      configError = undefined;
    } else if (configRead.reason !== configError) {
      configError = configRead.reason;
      notice(`config not read, the last good one stays: ${configRead.reason}`, "warn");
    }
  };

  try {
    while (control.stop === "none") {
      if (!endless && iteration >= options.maxIterations) {
        notice(`Reached ${options.maxIterations} iterations.`);
        break;
      }

      // Before every poll, so a run without work follows the file too.
      refresh();
      emit({ type: "phase", phase: "poll" });

      // The periodic tasks of the config; each decides whether it is due.
      // A closed `periodic` gate skips them this poll.
      if ((await check(gateEvent("periodic"))).open) {
        for (const task of h.tasks) {
          const done = await task.run();
          if (done.ran) {
            notice(done.ok ? `${task.name}: ${done.summary}` : `${task.name} failed: ${done.error}`, done.ok ? "info" : "warn");
          }
        }
      }

      if ((await wait(gateEvent("poll"), "polling")) !== "open") break;
      if ((await wait(gateEvent("plan", "planner"), "planning")) !== "open") break;

      // Read the issues here, not in a !`...` block inside the prompt file: a
      // failure inside such a block throws PromptError and ends the run. The
      // task source may retry a transient failure; one that stays unreachable pauses the run.
      let ready: Task[];
      try {
        ready = await h.source.listReady();
      } catch (error) {
        if (!(await pause(`cannot read the issues: ${message(error)}`))) break;
        continue;
      }

      const issuesJson = JSON.stringify(ready);
      const key = readySetKey(ready);
      const poll = endless ? decidePoll(key, idleKey) : { plan: true as const };
      if (!poll.plan) {
        if (!(await pause(poll.why))) break;
        continue;
      }

      iteration++;
      const logs = logRun.startIteration(iteration);
      // The config of this iteration: the gates above may have held the loop for hours.
      refresh();
      await h.lifecycle("iterationStart", context(), { iteration });
      try {
        emit({ type: "phase", phase: "plan", iteration });

        // -----------------------------------------------------------------------
        // Phase 1: Plan
        // -----------------------------------------------------------------------
        let issues: Issue[];
        const planSignal = control.planSignal();
        const plannerLog = logs.file(base, "planner");
        const planner = await startAgent(h, "planner", notice);
        emit({
          type: "agent-start",
          key: "planner",
          role: "planner",
          model: planner.plan.model,
          logPath: plannerLog.path,
          iteration,
        });
        try {
          const plan = await deps.sandcastle.run({
            // No hooks: the planner only reads issues and builds nothing. It
            // runs in the host checkout.
            sandbox: sandboxOf(h),
            name: "planner",
            // Structured output requires maxIterations: 1.
            maxIterations: 1,
            agent: planner.agent,
            promptFile: h.prompts.plan,
            promptArgs: { ISSUES_JSON: issuesJson },
            logging: streamTo(plannerLog.path, "planner", emit, h.agents.planner),
            output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
            signal: planSignal,
          });
          issues = plan.output.issues;
          plannerFailures = 0;
          emit({ type: "agent-end", key: "planner", outcome: "done", note: `${issues.length} issue(s)` });
        } catch (error) {
          if (planSignal.aborted) {
            emit({ type: "agent-end", key: "planner", outcome: "aborted" });
            break;
          }
          plannerFailures++;
          emit({ type: "agent-end", key: "planner", outcome: "failed", note: message(error) });
          if (plannerFailures >= h.maxPlannerFailures) {
            notice(`planner failed ${plannerFailures} times in a row. Exiting.`, "error");
            break;
          }
          if (!(await pause(`planner failed (${plannerFailures}/${h.maxPlannerFailures})`))) break;
          continue;
        }

        if (issues.length === 0) {
          idleKey = key;
          if (!(await pause("no unblocked issues to work on"))) break;
          continue;
        }

        // The implementer model is the plugins' to change, when each agent starts.
        const bodies = new Map(ready.map((task) => [task.id, task.body]));
        const texts = issues.map((issue): IssueText => ({ id: issue.id, title: issue.title, body: bodies.get(issue.id) ?? "" }));
        const tasks = new Map(texts.map((text) => [text.id, text]));

        notice(
          `Planning complete. ${issues.length} issue(s) to work, ` +
            `${Math.min(h.parallelism, issues.length)} at a time.`,
        );
        for (const issue of issues) {
          emit({
            type: "agent-queued",
            key: `#${issue.id}`,
            issue: issue.id,
            title: issue.title,
            body: tasks.get(issue.id)?.body,
            model: h.roles.implementer.model,
            iteration,
          });
        }

        // -----------------------------------------------------------------------
        // Phase 2: Execute + Review
        // -----------------------------------------------------------------------
        emit({ type: "phase", phase: "execute", iteration });
        const outcome = await execute({
          harness: h,
          issues,
          base,
          logs,
          iteration,
          control,
          emit,
          tasks,
          hold: hold(),
        });

        // A stop can arrive during any await above; TypeScript still narrows the
        // getter to the loop condition, so read it as a plain StopRequest.
        if ((control.stop as StopRequest) === "hard") {
          notice("Hard stop: no merge. The branches stay for the next run.", "warn");
          break;
        }

        // -----------------------------------------------------------------------
        // Phase 3: Merge
        // -----------------------------------------------------------------------
        const merged = await mergePhase({
          ...outcome,
          harness: h,
          base,
          logs,
          iteration,
          control,
          emit,
          endless,
          hold: hold(),
        });
        if (merged === "stopped") break;

        // An iteration that merged nothing made no progress. Without this, an
        // issue that keeps failing would be replanned and rerun at once.
        if (merged === "merged") {
          idleKey = undefined;
          backoff.reset();
        } else {
          idleKey = key;
        }

        if (outcome.heldReason !== undefined && !endless) {
          notice(`A gate closed during the iteration: ${outcome.heldReason}. Exiting.`);
          break;
        }
      } finally {
        await h.lifecycle("iterationEnd", context(), { iteration });
      }
    }
  } finally {
    // Every exit lands here: a stop, the iteration cap, a batch exit, a planner
    // error. Only a kill skips it.
    emit({ type: "phase", phase: "done" });
    await h.lifecycle("runEnd", context());
  }
}

// ---------------------------------------------------------------------------
// Agent output
// ---------------------------------------------------------------------------

/**
 * The `logging` option of one agent: sandcastle writes the log file, and every
 * tool call and text chunk also goes to the view, with the context size of
 * each model turn.
 */
function streamTo(path: string, key: string, emit: (event: RunEvent) => void, agent: AgentModule) {
  return {
    type: "file" as const,
    path,
    onAgentStreamEvent: (event: sandcastle.AgentStreamEvent) => {
      for (const signal of agent.signals(event)) {
        if (signal.kind === "context") emit({ type: "agent-context", key, tokens: signal.tokens });
        else emit({ type: "agent-activity", key, kind: signal.kind, text: signal.text });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2
// ---------------------------------------------------------------------------

interface IssueResult {
  branchAhead: number;
  blocked: boolean;
  /** The implementer's reason when it ended with NEEDS_HUMAN. */
  needsHuman?: string;
  /** A gate held the review: the branch and its worktree stay, the merge skips it. */
  held?: string;
}

interface ExecuteOutcome {
  issues: Issue[];
  settled: (PromiseSettledResult<IssueResult> | undefined)[];
  /** Set when a gate held new work or a review during the phase. */
  heldReason?: string;
}

async function execute(args: {
  harness: Harness;
  issues: Issue[];
  base: string;
  logs: IterationLogs;
  iteration: number;
  control: Control;
  emit: (event: RunEvent) => void;
  tasks: Map<string, IssueText>;
  hold: Hold;
}): Promise<ExecuteOutcome> {
  const { harness: h, issues, base, logs, iteration, control, emit, tasks, hold } = args;
  const { deps } = hold;
  const signal = control.hardSignal;
  const notice = noticeOf(emit);

  // Branches of the running issues, for the commit count in the view.
  const running = new Map<string, string>();
  const commitsTimer = setInterval(() => {
    for (const [key, branch] of running) {
      emit({ type: "agent-commits", key, commits: deps.commitsAhead(base, branch) });
    }
  }, COMMITS_POLL_MS);

  // For each issue, create a sandbox via createSandbox() so the implementer and
  // reviewer share the same sandbox instance per branch.
  const runIssue = async (issue: Issue): Promise<IssueResult> => {
    const key = `#${issue.id}`;
    signal.throwIfAborted();
    const task = tasks.get(issue.id) ?? { id: issue.id, title: issue.title, body: "" };
    const sandbox = await deps.sandcastle.createSandbox({
      branch: issue.branch,
      sandbox: sandboxOf(h),
      hooks: h.hooksFor({ task: issue.id, role: "implementer" }),
      copyToWorktree: h.copyToWorktree,
    });

    // Plugins may show the worktree and its agent logs elsewhere.
    const implementerLog = logs.file(issue.branch, "implementer");
    const reviewerLog = logs.file(issue.branch, "reviewer");
    await h.listeners.onAgentStart({
      role: "implementer",
      worktreePath: sandbox.worktreePath,
      issue: { id: issue.id, title: issue.title },
      logPath: implementerLog.path,
    });

    running.set(key, issue.branch);
    // A held review leaves the branch and its worktree as they are.
    let keepWorktree = false;
    try {
      const implementer = await startAgent(h, "implementer", notice, task);
      emit({
        type: "agent-start",
        key,
        role: "implementer",
        issue: issue.id,
        model: implementer.plan.model,
        logPath: implementerLog.path,
        iteration,
      });
      if (implementer.plan.note) emit({ type: "agent-note", key, text: implementer.plan.note });
      const implemented = await sandbox.run({
        ...implementer.runOptions,
        name: "implementer",
        logging: streamTo(implementerLog.path, key, emit, h.agents.implementer),
        maxIterations: 100,
        agent: implementer.agent,
        promptFile: h.prompts.implement,
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
        completionSignal: [COMPLETE, NEEDS_HUMAN],
        signal,
      });
      const needsHuman =
        implemented.completionSignal === NEEDS_HUMAN ? needsHumanReason(implemented.stdout) : undefined;

      // Review when the branch is ahead of the base, whether the commits came
      // from this run or an earlier one. A resumed branch whose implementer
      // finds the work already done still gets reviewed and merged.
      const ahead = deps.commitsAhead(base, issue.branch);
      emit({ type: "agent-commits", key, commits: ahead });
      if (ahead === 0) {
        if (needsHuman !== undefined) {
          emit({ type: "agent-end", key, outcome: "needs-human", note: needsHuman });
        } else {
          emit({ type: "agent-end", key, outcome: "no-commits" });
        }
        return { branchAhead: 0, blocked: false, needsHuman };
      }

      const gate = await hold.wait(hold.gateEvent("review", "reviewer", issue.id), `review of #${issue.id}`, "execute");
      if (gate !== "open") {
        keepWorktree = true;
        const reason = gate === "stopped" ? "stop requested" : "gate closed";
        emit({ type: "agent-end", key, outcome: "aborted", note: `review not started: ${reason}; branch ${issue.branch} kept` });
        return { branchAhead: ahead, blocked: false, needsHuman, held: `review of #${issue.id}: ${reason}` };
      }

      await h.listeners.onAgentStart({
        role: "reviewer",
        worktreePath: sandbox.worktreePath,
        issue: { id: issue.id, title: issue.title },
        logPath: reviewerLog.path,
      });
      const reviewer = await startAgent(h, "reviewer", notice, task);
      emit({
        type: "agent-start",
        key,
        role: "reviewer",
        issue: issue.id,
        model: reviewer.plan.model,
        logPath: reviewerLog.path,
        iteration,
      });
      if (reviewer.plan.note) emit({ type: "agent-note", key, text: reviewer.plan.note });
      const review = await sandbox.run({
        ...reviewer.runOptions,
        name: "reviewer",
        logging: streamTo(reviewerLog.path, key, emit, h.agents.reviewer),
        maxIterations: 1,
        agent: reviewer.agent,
        promptFile: h.prompts.review,
        promptArgs: {
          TASK_ID: issue.id,
          BRANCH: issue.branch,
          CHECKS: h.gates,
        },
        signal,
      });

      const { outcome, note, blocked } = reviewOutcome(review.stdout);
      const branchAhead = deps.commitsAhead(base, issue.branch);
      emit({ type: "agent-commits", key, commits: branchAhead });
      await h.lifecycle("branchReady", hold.context(), { issue: { id: issue.id, title: issue.title }, branch: issue.branch, review: { outcome, note, blocked } });
      if (!blocked && needsHuman !== undefined) {
        emit({ type: "agent-end", key, outcome: "needs-human", note: needsHuman });
      } else {
        emit({ type: "agent-end", key, outcome, note });
      }
      return { branchAhead, blocked, needsHuman };
    } catch (error) {
      emit({
        type: "agent-end",
        key,
        outcome: signal.aborted ? "aborted" : "failed",
        note: message(error),
      });
      throw error;
    } finally {
      running.delete(key);
      if (!keepWorktree) {
        // The hooks of the config run here, once the issue is done: the reviewer
        // reuses what the implementer built, so nothing goes before.
        await h.teardown(
          { worktree: sandbox.worktreePath, task: issue.id, role: "implementer" },
          (text) => notice(`#${issue.id}: ${text}`, "warn"),
        );
        // close() removes a clean worktree. A dirty one stays on disk. The logs stay.
        await sandbox.close();
      }
    }
  };

  // An entry stays undefined when the issue never started: a gate closed, or a
  // stop came first.
  const settled: (PromiseSettledResult<IssueResult> | undefined)[] = Array.from(
    { length: issues.length },
    () => undefined,
  );

  // Indexes of the issues not started yet, in plan order. Changing it is safe:
  // JavaScript runs one task at a time up to the next await.
  const pending: number[] = issues.map((_, i) => i);

  // Takes the next pending issue, in plan order.
  const takeNext = (): number | undefined => pending.shift();

  // Set once the `implement` gate closes. Every worker then stops taking issues.
  let heldReason: string | undefined;

  const worker = async () => {
    while (true) {
      // A stop request of either kind keeps queued issues from starting.
      if (control.stop !== "none") return;
      if (heldReason !== undefined || pending.length === 0) return;

      const next = issues[pending[0]!]!;
      const gate = await hold.check(hold.gateEvent("implement", "implementer", next.id));
      if (!gate.open) {
        if (heldReason === undefined) {
          heldReason = gate.reason;
          notice(`gate closed, no new issues start: ${heldReason}`, "warn");
        }
        return;
      }

      // Re-check after the await: another worker may have taken the last issue
      // or closed the gate meanwhile.
      if (heldReason !== undefined || control.stop !== "none") return;
      const index = takeNext();
      if (index === undefined) return;

      const issue = issues[index]!;
      try {
        settled[index] = { status: "fulfilled", value: await runIssue(issue) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(h.parallelism, issues.length) }, worker));
  } finally {
    clearInterval(commitsTimer);
  }

  for (const [i, outcome] of settled.entries()) {
    if (outcome === undefined) {
      emit({
        type: "agent-end",
        key: `#${issues[i]!.id}`,
        outcome: "aborted",
        note: control.stop !== "none" ? "not started: stop requested" : "not started: gate closed",
      });
    }
  }

  // A held review counts like a closed implement gate: a batch run exits after the merge.
  const heldReview = settled.map((entry) => (entry?.status === "fulfilled" ? entry.value.held : undefined)).find(Boolean);
  return { issues, settled, heldReason: heldReason ?? heldReview };
}

// ---------------------------------------------------------------------------
// Phase 3
// ---------------------------------------------------------------------------

async function mergePhase(args: ExecuteOutcome & {
  harness: Harness;
  base: string;
  logs: IterationLogs;
  iteration: number;
  control: Control;
  emit: (event: RunEvent) => void;
  endless: boolean;
  hold: Hold;
}): Promise<"merged" | "nothing" | "stopped"> {
  const { harness: h, issues, settled, base, logs, iteration, control, emit, endless, hold } = args;
  const { deps } = hold;
  const notice = noticeOf(emit);

  // Split the completed work into what still needs merging and what an earlier,
  // killed run already merged. A branch already contained in the base is
  // dropped from the merge — git already holds the answer, so no state file is
  // needed — but its issue may still be open, so it goes to the merger to close.
  // A branch equal to the base (base is not ahead of it) did no work: skip it.
  const fulfilled = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter((entry) => entry.outcome?.status === "fulfilled" && !entry.outcome.value.held);

  // A branch whose reviewer blocked its architecture stays out of the merge.
  // The reviewer left the reason in a comment on the issue; the label change
  // keeps the next planner from taking the issue again. The branch stays for
  // the human.
  const handOver = async (issue: Issue, reason: string) => {
    const marked = await h.source.handToHuman(issue.id, reason);
    if (!marked.ok) notice(`${issue.id}: not handed to a human, do it by hand: ${marked.reason}`, "warn");
  };
  const blockedIssues = fulfilled
    .filter(
      (entry) => entry.outcome?.status === "fulfilled" && entry.outcome.value.blocked,
    )
    .map((entry) => entry.issue);
  for (const issue of blockedIssues) {
    await handOver(
      issue,
      `the reviewer blocked the architecture (see its comment); the branch ${issue.branch} stays for a human`,
    );
  }

  const fulfilledIssues = fulfilled
    .map((entry) => entry.issue)
    .filter((issue) => !blockedIssues.includes(issue));

  // Issues whose implementer ended with NEEDS_HUMAN: their branches merge like
  // any other, but the merger does not close them; the harness moves them to
  // `ready-for-human` once the merge is over (`markHuman`).
  const humanReasons = new Map<string, string>();
  for (const entry of fulfilled) {
    const value = entry.outcome?.status === "fulfilled" ? entry.outcome.value : undefined;
    if (value && !value.blocked && value.needsHuman !== undefined) {
      humanReasons.set(entry.issue.id, value.needsHuman);
    }
  }
  const isHuman = (issue: Issue) => humanReasons.has(issue.id);
  const markHuman = async (only: (issue: Issue) => boolean) => {
    for (const issue of fulfilledIssues.filter((i) => isHuman(i) && only(i))) {
      const reason = `the implementer needs a human: ${humanReasons.get(issue.id) || "see the comments above"}`;
      await handOver(issue, reason);
    }
  };

  const toMergeIssues: Issue[] = [];
  const alreadyMergedIssues: Issue[] = [];
  for (const issue of fulfilledIssues) {
    if (deps.commitsAhead(base, issue.branch) > 0) {
      toMergeIssues.push(issue);
    } else if (deps.isContainedIn(base, issue.branch)) {
      // Contained in the base. Only genuinely merged work counts, not a branch
      // that never moved off the base: require the base to be ahead of it.
      if (deps.commitsAhead(issue.branch, base) > 0) {
        alreadyMergedIssues.push(issue);
      }
    }
  }

  const toMergeBranches = toMergeIssues.map((i) => i.branch);

  // A needs-human issue with nothing to merge goes to the human at once.
  await markHuman((issue) => !toMergeIssues.includes(issue));

  const issueLine = (i: Issue) => `- #${i.id}: ${i.title}`;
  notice(
    `Execution complete. ${toMergeBranches.length} branch(es) to merge` +
      (toMergeBranches.length ? `: ${toMergeBranches.join(", ")}` : "") +
      `; ${alreadyMergedIssues.length} already merged.`,
  );

  if (toMergeBranches.length === 0 && alreadyMergedIssues.length === 0) {
    notice("No commits produced. Nothing to merge.");
    return "nothing";
  }

  // Refuse a dirty start. A kill during a conflicting `git merge` leaves
  // MERGE_HEAD, and merging on top of it corrupts the tree. Never clean the
  // checkout — the user decides. An endless run waits for the user; a batch
  // run stops.
  while (true) {
    const checkout = checkCheckout(deps.readCheckout());
    if (checkout.ok) break;
    if (!endless) {
      notice(`Merge phase stopped, base checkout is not clean: ${checkout.reason}`, "error");
      return "stopped";
    }
    emit({
      type: "wait",
      until: new Date(Date.now() + CHECKOUT_RECHECK_MS),
      reason: `merge waits for a clean checkout: ${checkout.reason}`,
    });
    if ((await control.sleep(CHECKOUT_RECHECK_MS)) === "stopped") return "stopped";
  }

  // A batch run that finds the gate closed ends here: the branches stay.
  if ((await hold.wait(hold.gateEvent("merge", "merger"), "merge")) !== "open") return "stopped";

  emit({ type: "phase", phase: "merge", iteration });

  // The merger runs in the base checkout. It never takes the stop signal: a
  // kill inside `git merge` leaves a conflicted tree.
  const mergerLog = logs.file(base, "merger");
  const merger = await startAgent(h, "merger", notice);
  emit({ type: "agent-start", key: "merger", role: "merger", model: merger.plan.model, logPath: mergerLog.path, iteration });
  if (merger.plan.note) emit({ type: "agent-note", key: "merger", text: merger.plan.note });
  try {
    await deps.sandcastle.run({
      ...merger.runOptions,
      hooks: h.hooksFor({ role: "merger" }),
      sandbox: sandboxOf(h),
      name: "merger",
      logging: streamTo(mergerLog.path, "merger", emit, h.agents.merger),
      maxIterations: 1,
      agent: merger.agent,
      promptFile: h.prompts.merge,
      promptArgs: {
        // A markdown list of branch names, one per line.
        BRANCHES: toMergeBranches.map((b) => `- ${b}`).join("\n") || "- (none)",
        // A markdown list of issue numbers and titles, one per line.
        ISSUES: toMergeIssues.filter((i) => !isHuman(i)).map(issueLine).join("\n") || "- (none)",
        // Merged, but left open: the harness hands them to the human.
        HUMAN_ISSUES: toMergeIssues.filter(isHuman).map(issueLine).join("\n") || "- (none)",
        // Branches already merged by an earlier run; close only, never merge.
        MERGED_ISSUES: alreadyMergedIssues.filter((i) => !isHuman(i)).map(issueLine).join("\n") || "- (none)",
      },
    });
  } catch (error) {
    emit({ type: "agent-end", key: "merger", outcome: "failed", note: message(error) });
    await markHuman((issue) => toMergeIssues.includes(issue));
    return "nothing";
  }

  // After the merge, so the merger cannot close the issue on top of the label.
  // A branch that did not land is marked too: the issue still needs the human.
  await markHuman((issue) => toMergeIssues.includes(issue));

  // Report what went in and what did not. Re-read the base: a branch now
  // contained in it was merged.
  const landed = toMergeBranches.filter((branch) => deps.isContainedIn(base, branch));
  const missing = toMergeBranches.filter((branch) => !landed.includes(branch));

  // A merged branch has done its job; its worktree went with sandbox.close().
  // `git branch -d` keeps a branch that is not in the base, or that a kept
  // (dirty) worktree still holds. Blocked and failed branches never get here.
  const done = [...landed, ...alreadyMergedIssues.map((issue) => issue.branch)];
  const kept = done.filter((branch) => !deps.deleteMergedBranch(branch));
  if (kept.length > 0) {
    notice(`merged branch(es) kept, git refused to delete: ${kept.join(", ")}`, "warn");
  }
  emit({
    type: "agent-end",
    key: "merger",
    outcome: "done",
    note:
      `merged ${landed.length}/${toMergeBranches.length}` +
      (missing.length ? `; NOT in: ${missing.join(", ")}` : ""),
  });
  // The orchestrator closes a merged task, not the merger: it works the same for every source.
  const landedIssues = [...toMergeIssues.filter((i) => landed.includes(i.branch)), ...alreadyMergedIssues];
  for (const issue of landedIssues.filter((i) => !isHuman(i))) {
    try {
      await h.source.close(issue.id);
    } catch (error) {
      notice(`${issue.id}: not closed after the merge, do it by hand: ${message(error)}`, "warn");
    }
  }
  if (landed.length > 0) await h.afterMerge((text) => notice(text, "warn"));
  await h.lifecycle("mergeDone", hold.context(), { merged: done });
  return landed.length > 0 || alreadyMergedIssues.length > 0 ? "merged" : "nothing";
}
