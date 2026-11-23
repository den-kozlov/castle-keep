// The agent module interface. A role names an agent by id; the agent
// builds the sandcastle provider of one run and reads its stream. `claude-code`
// (./agents/claude-code.mts) is the first.

import type * as sandcastle from "@ai-hero/sandcastle";

export type AgentProvider = ReturnType<typeof sandcastle.claudeCode>;
export type StreamEvent = sandcastle.AgentStreamEvent;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What the view takes from one stream event. */
export type StreamSignal =
  | { kind: "tool" | "text"; text: string }
  /** The size of the context window at the newest model turn. */
  | { kind: "context"; tokens: number };

export interface AgentModule {
  id: string;
  /** The environment variables that hold the credentials of the agent. */
  authEnv: string[];
  /**
   * The provider of one run. `blocks` are the agent-specific blocks the
   * plugins returned from their pre-start hooks, one per plugin, in order;
   * the module merges the ones it knows.
   */
  provider(options: {
    model: string;
    effort?: Effort;
    /** No container around the agent: it must not stop at a permission prompt. */
    noSandbox: boolean;
    /**
     * What this run sets over the environment of the sandbox (engine.mts `sandboxOf`).
     * The module sets it on the agent's command, never in the provider env.
     */
    env: Record<string, string>;
    blocks: Record<string, unknown>[];
  }): AgentProvider;
  signals(event: StreamEvent): StreamSignal[];
}
