// The plugin interface. A plugin is a plain object with optional contributions;
// the bundled plugins (./plugins/) use this interface only, so an outside plugin
// is written the same way. ./config.mts merges the contributions in plugin order.

import type { Effort } from "./agent.mts";
import type { Role, RunEvent } from "./events.mts";
import type { GitRunner, Refs } from "./git.mts";
import type { TaskSource } from "./source.mts";

/** A hook the sandbox runs in the worktree before an agent starts. */
export interface ShellHook {
  command: string;
}

export interface WorktreeHooks {
  /** Shell commands run in the worktree before the agent starts, every iteration. */
  onSandboxReady?: ShellHook[];
  /** Run once an issue is done, before its worktree closes. Never throws into the run. */
  beforeClose?: ((context: { worktreePath: string }) => void | Promise<void>)[];
}

/** What a preflight check found. Errors refuse the start; warnings are shown. */
export interface PreflightFinding {
  errors?: string[];
  warnings?: string[];
}

export type PreflightCheck = (context: { base: string; refs: Refs }) => PreflightFinding;

/** What a periodic task did when the loop asked it. */
export type TaskResult =
  | { ran: false }
  | { ran: true; ok: true; summary: string }
  | { ran: true; ok: false; error: string };

/** Work the loop offers once per poll; the task decides whether it is due. Never throws. */
export interface PeriodicTask {
  name: string;
  run: () => Promise<TaskResult>;
}

export interface IssueText {
  id: string;
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Pre-start hook
// ---------------------------------------------------------------------------

/** The options of one agent run the core proposes and a plugin may change. */
export interface StartOptions {
  model: string;
  effort?: Effort;
  /** Seconds without output before the run is cut. */
  idleTimeout: number;
  env: Record<string, string>;
}

export interface PreStartInput {
  role: Role;
  /** The id of the agent module of the role. */
  agent: string;
  /** The issue of an implementer or a reviewer; none for the planner and the merger. */
  task?: IssueText;
  proposed: StartOptions;
  notice: Notice;
}

/** What a pre-start hook changes. The core merges the answers of all plugins, in plugin order. */
export interface StartChanges extends Partial<StartOptions> {
  /** One line on the agent row. The last note of the plugins wins. */
  note?: string;
  /** An agent-specific block, for example `{ claudeCode: { settings } }`; the agent module merges them. */
  [block: string]: unknown;
}

export type PreStart = (input: PreStartInput) => StartChanges | undefined | Promise<StartChanges | undefined>;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type Step = "poll" | "plan" | "implement" | "review" | "merge" | "periodic";

export interface GateEvent {
  step: Step;
  /** Set for a step that starts an agent. */
  role?: Role;
  /** The id of the agent module of the role. */
  agent?: string;
  model?: string;
  issue?: string;
}

/** Closed holds the step. Without `until` the core checks again in a minute. */
export type GateAnswer = { open: true } | { open: false; reason: string; until?: Date };

export interface Gate {
  check(event: GateEvent): GateAnswer | Promise<GateAnswer>;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export type Notice = (text: string, level?: "info" | "warn" | "error") => void;

/** The host git helpers a lifecycle hook may use. */
export interface HostGit {
  commitsAhead(base: string, branch: string): number;
  isContainedIn(base: string, branch: string): boolean;
  run: GitRunner;
}

export interface LifecycleContext {
  base: string;
  git: HostGit;
  notice: Notice;
  source: TaskSource;
  /** The names of the record on the remote. */
  refs: Refs;
  /** The agent module of each role, from the config of this iteration. */
  roles: Record<Role, { agent: string; model: string }>;
}

export interface ReviewReport {
  outcome: string;
  note?: string;
  /** The reviewer blocked the architecture: the branch stays out of the merge. */
  blocked: boolean;
}

/** Awaited by the core, in plugin order. An error becomes a warning; the run goes on. Never gated. */
export interface Lifecycle {
  iterationStart?(context: LifecycleContext, info: { iteration: number }): void | Promise<void>;
  branchReady?(context: LifecycleContext, info: { issue: { id: string; title: string }; branch: string; review: ReviewReport }): void | Promise<void>;
  mergeDone?(context: LifecycleContext, info: { merged: string[] }): void | Promise<void>;
  iterationEnd?(context: LifecycleContext, info: { iteration: number }): void | Promise<void>;
  runEnd?(context: LifecycleContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// UI elements
// ---------------------------------------------------------------------------

/** What a plugin shows in its header slot. The TUI draws them, batch mode prints them as one line. */
export type UiElement =
  | {
      kind: "meter";
      label: string;
      /** 0-100; undefined while unknown. */
      percent?: number;
      /** The meter turns yellow here. */
      warn?: number;
      /** The meter turns red here. */
      stop?: number;
      resetsAt?: Date;
    }
  | { kind: "text"; text: string }
  | { kind: "badge"; text: string; level: "ok" | "warn" | "error" };

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export interface AgentStart {
  role: "implementer" | "reviewer";
  worktreePath: string;
  issue: { id: string; title: string };
  logPath: string;
}

export interface Listeners {
  /** Once, before the first event of the run. */
  onRunStart?: () => void | Promise<void>;
  /** An implementer or a reviewer starts in its worktree. */
  onAgentStart?: (agent: AgentStart) => void | Promise<void>;
  /** Every event of the run, `agent-end` and the status events included. */
  onEvent?: (event: RunEvent) => void;
}

export interface Plugin {
  name: string;
  /** A source module the plugin works with only; any other source refuses the start. */
  requires?: { source: string };
  /** Extra environment variables of every agent. */
  env?: Record<string, string>;
  hooks?: WorktreeHooks;
  preflight?: PreflightCheck[];
  tasks?: PeriodicTask[];
  preStart?: PreStart;
  gate?: Gate;
  lifecycle?: Lifecycle;
  /** The elements of the header slot of this plugin; read after every gate check. */
  header?: () => UiElement[];
  listeners?: Listeners;
}
