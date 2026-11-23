// The public face of the orchestrator: what a project's entry file imports.

export { parseConfig, createConfigReader, ConfigError, CONFIG_FILE } from "./config.mts";
export type { Harness, SandboxProvider } from "./config.mts";
export type * from "./plugin.mts";
export type { AgentModule } from "./agent.mts";
export { claudeCodeAgent } from "./agents/claude-code.mts";
export { runSandcastle } from "./run.mts";
export { claudeLimits } from "./plugins/claude-limits.mts";
export { graftPlugin } from "./plugins/graft.mts";
export { jevPilot } from "./plugins/jev.mts";
export { orcaPlugin } from "./plugins/orca.mts";
export type { Handover, NewTask, Task, TaskSource, TaskState } from "./source.mts";
export { runTaskCommand } from "./cli.mts";
export { githubSource } from "./sources/github.mts";
export { githubPrPlugin } from "./plugins/github-pr.mts";
