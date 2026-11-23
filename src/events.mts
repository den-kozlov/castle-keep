// What the loop tells its viewers.
//
// The engine never prints. It emits events; the batch view turns them into
// plain lines, the TUI folds them into a RunState, and both write the plain
// lines into orchestrator.log. A test drives the fold without a terminal.

import type { UiElement } from "./plugin.mts";
import type { StopRequest } from "./control.mts";
import type { Mode } from "./policy.mts";

export type Phase =
  | "start"
  | "poll"
  | "plan"
  | "execute"
  | "merge"
  | "wait"
  | "done";

export type Role = "planner" | "implementer" | "reviewer" | "merger";

export type AgentOutcome = "done" | "failed" | "blocked" | "aborted" | "no-commits" | "needs-human";

export type RunEvent =
  | { type: "start"; mode: Mode; base: string; logDir: string; maxIterations?: number }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "phase"; phase: Phase; iteration?: number }
  | { type: "wait"; until: Date; reason: string }
  /** The header slot of a plugin, shown as it stands; sent when it changes. */
  | { type: "header"; plugin: string; elements: UiElement[] }
  /** The one note of an agent row, for example why its model was chosen. */
  | { type: "agent-note"; key: string; text: string }
  | { type: "stop"; request: StopRequest }
  | {
      type: "agent-start";
      key: string;
      role: Role;
      issue?: string;
      title?: string;
      model?: string;
      logPath: string;
      iteration: number;
    }
  | {
      type: "agent-queued";
      key: string;
      issue: string;
      title: string;
      body?: string;
      model: string;
      iteration: number;
    }
  | { type: "agent-activity"; key: string; kind: "tool" | "text"; text: string }
  | { type: "agent-commits"; key: string; commits: number }
  /** The context window of the agent's newest model turn, in tokens (`AgentModule.signals`). */
  | { type: "agent-context"; key: string; tokens: number }
  | { type: "agent-end"; key: string; outcome: AgentOutcome; note?: string };

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export interface AgentRow {
  key: string;
  role: Role | "queued";
  issue?: string;
  title?: string;
  /** The issue body, for the header of the log view. */
  body?: string;
  model?: string;
  logPath?: string;
  iteration: number;
  /** When the current role started. */
  startedAt?: number;
  /** When the first role on this row started; a reviewer keeps it. */
  taskStartedAt?: number;
  endedAt?: number;
  tools: number;
  commits: number;
  /** One line from a plugin, shown on the row. */
  note?: string;
  /** Tokens in the context window at the newest model turn; unset until the first turn. */
  context?: number;
  last?: string;
  outcome?: AgentOutcome;
}

export interface RunState {
  mode: Mode;
  base: string;
  logDir: string;
  maxIterations?: number;
  phase: Phase;
  iteration: number;
  waitUntil?: number;
  waitReason?: string;
  /** The header slot of each plugin, by plugin name. */
  header: Record<string, UiElement[]>;
  stop: StopRequest;
  /** Agents of the current iteration, in start order. */
  agents: AgentRow[];
  /** Finished agents of earlier iterations, newest first. */
  history: AgentRow[];
  /** The newest notices, newest last. */
  notices: { at: number; level: "info" | "warn" | "error"; text: string }[];
}

export const HISTORY_SIZE = 20;
const NOTICES_SIZE = 50;

export const initialState = (): RunState => ({
  mode: "endless",
  base: "",
  logDir: "",
  phase: "start",
  iteration: 0,
  stop: "none",
  header: {},
  agents: [],
  history: [],
  notices: [],
});

const touch = (
  state: RunState,
  key: string,
  change: (row: AgentRow) => AgentRow,
): RunState => ({
  ...state,
  agents: state.agents.map((row) => (row.key === key ? change(row) : row)),
});

/** One line of an agent's activity, short enough for a table cell. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

export function reduce(state: RunState, event: RunEvent, now = Date.now()): RunState {
  switch (event.type) {
    case "start":
      return {
        ...state,
        mode: event.mode,
        base: event.base,
        logDir: event.logDir,
        maxIterations: event.maxIterations,
      };
    case "notice":
      return {
        ...state,
        notices: [...state.notices, { at: now, level: event.level, text: event.text }].slice(
          -NOTICES_SIZE,
        ),
      };
    case "phase": {
      const iteration = event.iteration ?? state.iteration;
      // A new iteration moves the finished rows of the last one into history.
      if (iteration !== state.iteration) {
        const finished = state.agents.filter((row) => row.outcome !== undefined).reverse();
        return {
          ...state,
          phase: event.phase,
          iteration,
          waitUntil: undefined,
          waitReason: undefined,
          agents: [],
          history: [...finished, ...state.history].slice(0, HISTORY_SIZE),
        };
      }
      return { ...state, phase: event.phase, waitUntil: undefined, waitReason: undefined };
    }
    case "wait":
      return { ...state, phase: "wait", waitUntil: event.until.getTime(), waitReason: event.reason };
    case "header":
      return { ...state, header: { ...state.header, [event.plugin]: event.elements } };
    case "agent-note":
      return touch(state, event.key, (row) => ({ ...row, note: oneLine(event.text) }));
    case "stop":
      return { ...state, stop: event.request };
    case "agent-queued":
      return {
        ...state,
        agents: [
          ...state.agents,
          {
            key: event.key,
            role: "queued",
            issue: event.issue,
            title: event.title,
            body: event.body,
            model: event.model,
            iteration: event.iteration,
            tools: 0,
            commits: 0,
          },
        ],
      };
    case "agent-start": {
      const row: AgentRow = {
        key: event.key,
        role: event.role,
        issue: event.issue,
        title: event.title,
        model: event.model,
        logPath: event.logPath,
        iteration: event.iteration,
        startedAt: now,
        taskStartedAt: now,
        tools: 0,
        commits: 0,
      };
      const known = state.agents.some((existing) => existing.key === event.key);
      if (!known) return { ...state, agents: [...state.agents, row] };
      return touch(state, event.key, (old) => ({
        ...old,
        ...row,
        issue: row.issue ?? old.issue,
        title: row.title ?? old.title,
        taskStartedAt: old.taskStartedAt ?? now,
        commits: old.commits,
      }));
    }
    case "agent-activity":
      return touch(state, event.key, (row) => ({
        ...row,
        tools: row.tools + (event.kind === "tool" ? 1 : 0),
        last: oneLine(event.text),
      }));
    case "agent-commits":
      return touch(state, event.key, (row) => ({ ...row, commits: event.commits }));
    case "agent-context":
      return touch(state, event.key, (row) => ({ ...row, context: event.tokens }));
    case "agent-end":
      return touch(state, event.key, (row) => ({
        ...row,
        outcome: event.outcome,
        endedAt: now,
        last: event.note ? oneLine(event.note) : row.last,
      }));
  }
}

// ---------------------------------------------------------------------------
// The tab title: the run in a few characters
// ---------------------------------------------------------------------------

/** The prefix that marks the sandcastle tab among the others. */
const TAB_PREFIX = "SC";

const PHASE_LETTER: Record<Phase, string> = {
  start: "·",
  poll: "·",
  plan: "p",
  execute: "w",
  merge: "m",
  wait: "z",
  done: "✓",
};

/** "12m", "1h05": the time left in a pause, in the width of a tab. */
const shortDuration = (ms: number) => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
};

/**
 * The title of the terminal tab that runs the loop: a prefix, a stop mark, one
 * letter for the phase, and the detail of the phase. During the execute phase
 * the detail is `[active/left]`: the issues of the iteration not finished yet,
 * at work or in the queue, and how many of them have an agent at work right
 * now. A finished issue leaves both counts. During a pause the detail is the
 * time left.
 */
export function tabTitle(state: RunState, now = Date.now()): string {
  const stop = state.stop === "none" ? "" : "■";
  let detail = "";
  if (state.phase === "execute") {
    const left = state.agents.filter((row) => row.issue !== undefined && row.outcome === undefined);
    const active = left.filter((row) => row.role !== "queued");
    detail = `[${active.length}/${left.length}]`;
  } else if (state.phase === "wait" && state.waitUntil !== undefined) {
    detail = ` ${shortDuration(state.waitUntil - now)}`;
  }
  return `${TAB_PREFIX} ${stop}${PHASE_LETTER[state.phase]}${detail}`;
}

// ---------------------------------------------------------------------------
// Plain lines, for batch mode and orchestrator.log
// ---------------------------------------------------------------------------

const clock = (at: Date) =>
  at.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

const OUTCOME_MARK: Record<AgentOutcome, string> = {
  done: "✓",
  failed: "✗",
  blocked: "⛔",
  aborted: "■",
  "no-commits": "∅",
  "needs-human": "?",
};

/** The elements of a header slot as one line: a meter as `5h 11% (stop 90%)`, a badge as its text. */
export function describeElements(elements: UiElement[]): string {
  return elements
    .map((element) => {
      if (element.kind === "text" || element.kind === "badge") return element.text;
      const percent = element.percent === undefined ? "--%" : `${element.percent.toFixed(0)}%`;
      const reset = element.resetsAt ? `, resets ${clock(new Date(element.resetsAt))}` : "";
      return `${element.label} ${percent}${element.stop === undefined ? "" : ` (stop ${element.stop}%${reset})`}`;
    })
    .join(" · ");
}

/** The plain line of an event, or undefined for an event too busy to print. */
export function formatLine(event: RunEvent): string | undefined {
  switch (event.type) {
    case "start":
      return (
        `Sandcastle ${event.mode} run on ${event.base}` +
        (event.maxIterations ? `, up to ${event.maxIterations} iterations` : "") +
        `. Logs: ${event.logDir}`
      );
    case "notice":
      return event.level === "info" ? event.text : `${event.level === "warn" ? "!" : "✗"} ${event.text}`;
    case "phase":
      if (event.phase === "plan") return `\n=== Iteration ${event.iteration} ===`;
      if (event.phase === "done") return "\nAll done.";
      return undefined;
    case "wait":
      return `  ⏸ ${event.reason}; next check ${clock(event.until)}`;
    case "header":
      return event.elements.length ? `[${event.plugin}] ${describeElements(event.elements)}` : undefined;
    case "agent-note":
      return `  ${event.key}: ${event.text}`;
    case "stop":
      return event.request === "none"
        ? "Stop cancelled."
        : event.request === "soft"
          ? "Stop requested: running agents finish, then the merge, then exit."
          : "Hard stop: aborting the agents.";
    case "agent-queued":
      return `  ${event.issue}: ${event.title} (implementer ${event.model})`;
    case "agent-start":
      return `  → ${event.role}${event.issue ? ` ${event.issue}` : ""}${event.model ? ` on ${event.model}` : ""}: ${event.logPath}`;
    case "agent-activity":
    case "agent-commits":
    case "agent-context":
      return undefined;
    case "agent-end":
      return `  ${OUTCOME_MARK[event.outcome]} ${event.key} ${event.outcome}${event.note ? `: ${event.note}` : ""}`;
  }
}
