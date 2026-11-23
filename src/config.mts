// The config file of a Sandcastle run, and the resolved harness.
//
// The project config is one JSON file, `.sandcastle/config.json`. `parseConfig`
// checks it against the schemas of the modules it names (./modules.mts) and
// `resolveHarness` turns it into the harness the loop reads. The reader reads
// the file again at the start of every iteration: an edit takes effect at the
// next one, and a broken file keeps the last good read.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readEnvFile } from "./env-file.mts";
import type { AgentModule, Effort } from "./agent.mts";
import { AGENT_IDS, agents as agentModules, plugins as pluginModules, sandboxes, sources, type AgentId, type SandboxProvider } from "./modules.mts";
import type { TaskSource } from "./source.mts";
import { hookCommand, hooksSchema, parseHooks, runHook, runHookSync, type HookContext, type HookEntry, type HookTable } from "./hooks.mts";
import type { GateAnswer, GateEvent, IssueText, Lifecycle, LifecycleContext, Listeners, Notice, PeriodicTask, Plugin, PreflightCheck, TaskResult, UiElement } from "./plugin.mts";

export type { SandboxProvider } from "./modules.mts";

// Package constants, not settings.
export const CONFIG_FILE = ".sandcastle/config.json";
export const MIRROR_BRANCH = "sandcastle/main";
export const BRANCH_PREFIX = "sandcastle/issue-";
export const CLAUDE_CONFIG_DIR = join(homedir(), ".claude-sandcastle");
/** No limit by default: the longest wait a timer takes (about 23 days, in seconds). */
export const NO_IDLE_LIMIT_SECONDS = 2_000_000;

export const ROLES = ["planner", "implementer", "reviewer", "merger"] as const;
export type RoleName = (typeof ROLES)[number];

const text = z.string().trim().min(1);
const moduleRef = z.object({ module: text }).loose();
export const roleSchema = z.object({
  agent: text.describe("The agent module that runs this role."),
  model: text.describe("The model the agent runs, as its CLI names it."),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("The reasoning effort; the agent's own default when not set."),
}).strict();

export const fileSchema = z
  .object({
    source: moduleRef.describe("The task tracker: where ready tasks come from and where their states go. Exactly one."),
    sandbox: moduleRef.describe("Where the agents run: on the host or in a Sandcastle sandbox provider. Exactly one."),
    roles: z.object({
      planner: roleSchema.describe("Picks the ready tasks of an iteration and orders them."),
      implementer: roleSchema.describe("Implements one task on its branch."),
      reviewer: roleSchema.describe("Reviews a task branch and runs the gates."),
      merger: roleSchema.describe("Merges the reviewed branches into the base branch."),
    }).strict(),
    prompts: z.object({ plan: text, implement: text, review: text, merge: text }).strict(),
    /** The checks the reviewer runs, one command per entry. */
    gates: z.array(text).min(1),
    env: z.record(z.string(), z.string()).default({}),
    copyToWorktree: z.array(text).default([]),
    hooks: hooksSchema,
    plugins: z.array(moduleRef).default([]),
    baseBranch: text.default("main"),
    remote: text.default("origin"),
    parallelism: z.number().int().min(1).default(3),
    commandTimeoutMs: z.number().int().min(1000).default(30 * 60 * 1000),
    idleTimeoutSeconds: z.number().int().min(1).optional(),
    maxPlannerFailures: z.number().int().min(1).default(3),
    batchIterations: z.number().int().min(1).default(10),
  })
  .strict();

export class ConfigError extends Error {}

const pathOf = (path: PropertyKey[]) => path.map(String).join(".") || "(config)";

/** The module of a `{ module, ...settings }` entry, its settings checked. Problems go to `errors`. */
function checkModule<M extends { settings: z.ZodType }>(
  registry: Record<string, M>,
  kind: string,
  where: string,
  ref: { module: string } & Record<string, unknown>,
  errors: string[],
): { module: string; settings: unknown; entry: M } | undefined {
  const entry = Object.hasOwn(registry, ref.module) ? registry[ref.module] : undefined;
  if (!entry) {
    errors.push(`${where}.module: unknown ${kind} "${ref.module}"; known: ${Object.keys(registry).join(", ")}`);
    return undefined;
  }
  const { module, ...rest } = ref;
  const parsed = entry.settings.safeParse(rest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${where}.${pathOf(issue.path)}: ${issue.message}`);
    return undefined;
  }
  return { module, settings: parsed.data, entry };
}

export interface ParsedConfig {
  file: z.infer<typeof fileSchema>;
  hooks: HookTable;
  source: { module: string; settings: unknown; build: () => TaskSource };
  sandbox: { module: string; build: () => (env: Record<string, string>) => SandboxProvider };
  plugins: { module: string; settings: unknown; build: () => Plugin }[];
}

/** Checks the text of the config file. Throws a ConfigError that names every wrong field. */
export function parseConfig(source: string): ParsedConfig {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(`invalid config: not JSON: ${(error as Error).message}`);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`invalid config: ${parsed.error.issues.map((i) => `${pathOf(i.path)}: ${i.message}`).join("; ")}`);
  }
  const file = parsed.data;
  const errors: string[] = [];

  const src = checkModule(sources, "task source", "source", file.source, errors);
  const sandbox = checkModule(sandboxes, "sandbox", "sandbox", file.sandbox, errors);
  for (const role of ROLES) {
    const agent = file.roles[role].agent;
    if (!AGENT_IDS.includes(agent as AgentId)) {
      errors.push(`roles.${role}.agent: unknown agent "${agent}"; known: ${AGENT_IDS.join(", ")}`);
    }
  }
  const plugins = file.plugins.map((ref, i) => checkModule(pluginModules, "plugin", `plugins.${i}`, ref, errors));
  const { table, errors: hookErrors } = parseHooks(file.hooks);
  errors.push(...hookErrors);
  if (errors.length > 0 || !src || !sandbox) throw new ConfigError(`invalid config: ${errors.join("; ")}`);

  return {
    file,
    hooks: table,
    source: { module: src.module, settings: src.settings, build: () => src.entry.build(src.settings as never) },
    sandbox: { module: sandbox.module, build: () => (sandbox.entry.build(sandbox.settings as never) as ReturnType<ParsedConfig["sandbox"]["build"]>) },
    plugins: plugins.map((p) => ({ module: p!.module, settings: p!.settings, build: () => p!.entry.build(p!.settings as never) })),
  };
}

export interface Role {
  agent: AgentId;
  model: string;
  effort?: Effort;
}

/** The options of one agent run after the pre-start hooks of the plugins. */
export interface StartPlan {
  model: string;
  effort?: Effort;
  idleTimeout: number;
  env: Record<string, string>;
  /** One line for the agent row. */
  note?: string;
  /** The agent-specific blocks of the plugins, one per plugin, in order. */
  blocks: Record<string, unknown>[];
}

/** The hooks option of sandcastle, built per agent run. */
export interface SandboxHooks {
  host?: { onWorktreeReady?: { command: string }[] };
  sandbox?: { onSandboxReady?: { command: string }[] };
}

export interface Harness {
  /** The task source of the config. */
  source: TaskSource;
  baseBranch: string;
  refs: { remote: string; mirror: string; branchPrefix: string };
  parallelism: number;
  commandTimeoutMs: number;
  idleTimeoutSeconds: number;
  maxPlannerFailures: number;
  batchIterations: number;
  claudeConfigDir: string;
  roles: Record<RoleName, Role>;
  /** The agent module of each role. */
  agents: Record<RoleName, AgentModule>;
  /** The id of the sandbox module; `no-sandbox` runs agents without a container. */
  sandboxModule: string;
  prompts: { plan: string; implement: string; review: string; merge: string };
  /** The gates as a markdown list, the `CHECKS` argument of the review prompt. */
  gates: string;
  sandbox: (env: Record<string, string>) => SandboxProvider;
  /** The environment of every agent. */
  env: Record<string, string>;
  /** The `hooks` option of sandcastle for the agent of a role on a task. */
  hooksFor: (context: HookContext) => SandboxHooks;
  /** `worktreeTeardown` hooks and the teardown of plugins, once the task is done. Never throws. */
  teardown: (context: HookContext, warn: (text: string) => void) => Promise<void>;
  /** `host.afterMerge` hooks. Never throws. */
  afterMerge: (warn: (text: string) => void) => Promise<void>;
  copyToWorktree: string[];
  preflight: PreflightCheck[];
  tasks: PeriodicTask[];
  /** Runs the pre-start hooks of the plugins in order. A failing hook is a warning. */
  preStart: (input: { role: RoleName; task?: IssueText }, notice: Notice) => Promise<StartPlan>;
  /** Asks the gate of every plugin. Any closed gate closes the step; a gate that throws counts as closed. */
  gate: (event: GateEvent) => Promise<GateAnswer>;
  /** The header slot of each plugin that has one. */
  header: () => { plugin: string; elements: UiElement[] }[];
  /** Runs a lifecycle hook of every plugin, in order. An error becomes a warning. */
  lifecycle: (hook: keyof Lifecycle, context: LifecycleContext, info?: object) => Promise<void>;
  /** Every listener, fanned out to the plugins in order. */
  listeners: Required<Listeners>;
  plugins: string[];
}

/** `${NAME}` in an env value: the environment of the harness, and NODE_DIR, the directory of its Node. */
const expandEnv = (value: string) =>
  value.replace(/\$\{(\w+)\}/g, (_, name: string) => (name === "NODE_DIR" ? dirname(process.execPath) : (process.env[name] ?? "")));

/** What lives through a re-read of the file: the plugins built at the start, and when a periodic hook last ran. */
export interface Carried {
  source: TaskSource;
  plugins: Plugin[];
  sandbox: (env: Record<string, string>) => SandboxProvider;
  lastRun: Map<string, number>;
}

/** Builds the modules. Refuses a plugin whose required source is not the configured one. */
export const carry = (parsed: ParsedConfig): Carried => {
  const plugins = parsed.plugins.map((p) => p.build());
  for (const plugin of plugins) {
    const need = plugin.requires?.source;
    if (need !== undefined && need !== parsed.file.source.module) {
      throw new ConfigError(`plugin ${plugin.name} requires the ${need} source, the config has ${parsed.file.source.module}`);
    }
  }
  return { source: parsed.source.build(), plugins, sandbox: parsed.sandbox.build(), lastRun: new Map() };
};

/** The result of an output line of a preflight hook: `error: …` and `warning: …`; other lines are warnings. */
function preflightFinding(code: number, output: string, run: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of output.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = /^(error|warning):\s*(.*)$/i.exec(line);
    if (m?.[1]?.toLowerCase() === "error") errors.push(m[2]!);
    else warnings.push(m ? m[2]! : line);
  }
  if (code !== 0 && errors.length === 0) errors.push(`preflight hook \`${run}\` failed (exit ${code})${warnings.length ? `: ${warnings.pop()}` : ""}`);
  return { errors, warnings };
}

/** Resolves a checked config. `cwd` is the checkout the hooks run in. */
export function resolveHarness(parsed: ParsedConfig, carried: Carried, cwd = process.cwd(), now = () => Date.now()): Harness {
  const c = parsed.file;
  const plugins = carried.plugins;

  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: CLAUDE_CONFIG_DIR,
    BASH_DEFAULT_TIMEOUT_MS: String(c.commandTimeoutMs),
    BASH_MAX_TIMEOUT_MS: String(c.commandTimeoutMs),
    ...Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, expandEnv(v)])),
  };
  // The keys the source needs reach the agents from the environment of the harness.
  const fileEnv = carried.source.env.length > 0 ? readEnvFile() : {};
  for (const key of carried.source.env) {
    const value = process.env[key] ?? fileEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const plugin of plugins) Object.assign(env, plugin.env);
  const hostEnv = () => ({ ...env });

  const roles = Object.fromEntries(ROLES.map((r) => [r, c.roles[r]])) as unknown as Record<RoleName, Role>;

  const agents = Object.fromEntries(ROLES.map((r) => [r, agentModules[roles[r].agent]!.build({})])) as Record<RoleName, AgentModule>;
  const idleTimeout = c.idleTimeoutSeconds ?? NO_IDLE_LIMIT_SECONDS;
  const listenersOf = plugins.flatMap((p) => (p.listeners ? [p.listeners] : []));

  const commandsOf = (entries: HookEntry[], context: HookContext) => entries.map((entry) => ({ command: hookCommand(entry, context) }));
  const hooksFor = (context: HookContext): SandboxHooks => {
    const host = commandsOf(parsed.hooks.host.worktreeBuildup, context);
    const sandbox = [...commandsOf(parsed.hooks.sandbox.worktreeBuildup, context), ...plugins.flatMap((p) => p.hooks?.onSandboxReady ?? [])];
    return { ...(host.length ? { host: { onWorktreeReady: host } } : {}), sandbox: { onSandboxReady: sandbox } };
  };

  // No sandbox provider has a teardown hook: both places run in the worktree on the host.
  const teardown: Harness["teardown"] = async (context, warn) => {
    for (const entry of [...parsed.hooks.host.worktreeTeardown, ...parsed.hooks.sandbox.worktreeTeardown]) {
      const done = await runHook(entry, context, { cwd: context.worktree, env: hostEnv() });
      if (done.code !== 0) warn(`teardown hook \`${entry.run}\` failed (exit ${done.code}): ${firstLine(done.stderr || done.stdout)}`);
    }
    for (const plugin of plugins) {
      for (const hook of plugin.hooks?.beforeClose ?? []) {
        try {
          await hook({ worktreePath: context.worktree ?? "" });
        } catch (error) {
          warn(`teardown of ${plugin.name} failed: ${firstLine(String(error))}`);
        }
      }
    }
  };

  const afterMerge: Harness["afterMerge"] = async (warn) => {
    for (const entry of parsed.hooks.host.afterMerge) {
      const done = await runHook(entry, { role: "merger" }, { cwd, env: hostEnv() });
      if (done.code !== 0) warn(`afterMerge hook \`${entry.run}\` failed (exit ${done.code}): ${firstLine(done.stderr || done.stdout)}`);
    }
  };

  const preflight: PreflightCheck[] = [
    ...parsed.hooks.host.preflight.map((entry): PreflightCheck => () => {
      const done = runHookSync(entry, {}, { cwd, env: hostEnv(), timeoutMs: 60_000 });
      return preflightFinding(done.code, done.stdout + done.stderr, entry.run);
    }),
    ...plugins.flatMap((p) => p.preflight ?? []),
  ];

  // A periodic hook that prints nothing did nothing; the last line it prints is its summary.
  const periodic = parsed.hooks.host.periodic.map((entry): PeriodicTask => ({
    name: entry.name ?? entry.run,
    run: async (): Promise<TaskResult> => {
      const last = carried.lastRun.get(entry.run);
      if (last !== undefined && now() - last < (entry.intervalMs ?? 0)) return { ran: false };
      carried.lastRun.set(entry.run, now());
      const done = await runHook(entry, { role: "periodic" }, { cwd, env: hostEnv(), timeoutMs: 30 * 60_000 });
      if (done.code !== 0) return { ran: true, ok: false, error: firstLine(done.stderr || done.stdout) || `exit ${done.code}` };
      const out = done.stdout.trim();
      return out ? { ran: true, ok: true, summary: out.split("\n").at(-1)! } : { ran: false };
    },
  }));

  const preStart: Harness["preStart"] = async ({ role, task }, notice) => {
    const plan: StartPlan = { model: roles[role].model, effort: roles[role].effort, idleTimeout, env: { ...env }, blocks: [] };
    for (const plugin of plugins) {
      if (!plugin.preStart) continue;
      try {
        const changes = await plugin.preStart({
          role,
          agent: roles[role].agent,
          task,
          proposed: { model: plan.model, effort: plan.effort, idleTimeout: plan.idleTimeout, env: { ...plan.env } },
          notice,
        });
        if (!changes) continue;
        const { model, effort, idleTimeout: idle, env: extra, note, ...block } = changes;
        if (model !== undefined) plan.model = model;
        if (effort !== undefined) plan.effort = effort;
        if (idle !== undefined) plan.idleTimeout = idle;
        if (extra) Object.assign(plan.env, extra);
        if (note !== undefined) plan.note = note;
        if (Object.keys(block).length > 0) plan.blocks.push(block);
      } catch (error) {
        notice(`${plugin.name} pre-start hook failed: ${firstLine(String(error))}`, "warn");
      }
    }
    return plan;
  };

  const gate: Harness["gate"] = async (event) => {
    const closed: { reason: string; until?: Date }[] = [];
    await Promise.all(
      plugins.map(async (plugin) => {
        if (!plugin.gate) return;
        try {
          const answer = await plugin.gate.check(event);
          if (!answer.open) closed.push({ reason: `${plugin.name}: ${answer.reason}`, until: answer.until });
        } catch (error) {
          closed.push({ reason: `${plugin.name} gate failed: ${firstLine(String(error))}` });
        }
      }),
    );
    if (closed.length === 0) return { open: true };
    const untils = closed.flatMap((c) => (c.until ? [c.until.getTime()] : []));
    // A closed gate without a time sets the pace: the next check is in a minute.
    const until = untils.length === closed.length ? new Date(Math.max(...untils)) : undefined;
    return { open: false, reason: closed.map((c) => c.reason).join("; "), until };
  };

  const header: Harness["header"] = () =>
    plugins.flatMap((plugin) => (plugin.header ? [{ plugin: plugin.name, elements: plugin.header() }] : []));

  const lifecycle: Harness["lifecycle"] = async (hook, context, info) => {
    for (const plugin of plugins) {
      const run = plugin.lifecycle?.[hook] as ((context: LifecycleContext, info?: object) => unknown) | undefined;
      if (!run) continue;
      try {
        await run.call(plugin.lifecycle, context, info);
      } catch (error) {
        context.notice(`${plugin.name} ${hook} failed: ${firstLine(String(error))}`, "warn");
      }
    }
  };

  return {
    source: carried.source,
    baseBranch: c.baseBranch,
    refs: { remote: c.remote, mirror: MIRROR_BRANCH, branchPrefix: BRANCH_PREFIX },
    parallelism: c.parallelism,
    commandTimeoutMs: c.commandTimeoutMs,
    idleTimeoutSeconds: idleTimeout,
    maxPlannerFailures: c.maxPlannerFailures,
    batchIterations: c.batchIterations,
    claudeConfigDir: CLAUDE_CONFIG_DIR,
    roles,
    agents,
    sandboxModule: parsed.sandbox.module,
    prompts: c.prompts,
    gates: c.gates.map((gate) => `- \`${gate}\``).join("\n"),
    sandbox: carried.sandbox,
    env,
    hooksFor,
    teardown,
    afterMerge,
    copyToWorktree: c.copyToWorktree.filter((file) => existsSync(join(cwd, file))),
    preflight,
    tasks: [...periodic, ...plugins.flatMap((p) => p.tasks ?? [])],
    preStart,
    gate,
    header,
    lifecycle,
    listeners: {
      onRunStart: async () => {
        for (const l of listenersOf) await l.onRunStart?.();
      },
      onAgentStart: async (agent) => {
        for (const l of listenersOf) await l.onAgentStart?.(agent);
      },
      onEvent: (event) => {
        for (const l of listenersOf) l.onEvent?.(event);
      },
    },
    plugins: plugins.map((p) => p.name),
  };
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

export type ConfigRead = { ok: true; harness: Harness } | { ok: false; reason: string; harness: Harness | undefined };

export interface ConfigReader {
  /** Reads the file again. A missing or broken file answers the last good harness with the reason. */
  read(): ConfigRead;
}

/**
 * The reader of the config file. The modules (source, sandbox, plugins) are built
 * by the first read and stay until a restart; everything else follows the file.
 */
export function createConfigReader(path: string, cwd = process.cwd()): ConfigReader {
  let carried: Carried | undefined;
  let last: Harness | undefined;
  return {
    read() {
      try {
        const parsed = parseConfig(readFileSync(path, "utf8"));
        carried ??= carry(parsed);
        last = resolveHarness(parsed, carried, cwd);
        return { ok: true, harness: last };
      } catch (error) {
        const reason = error instanceof ConfigError ? error.message : `${path}: ${(error as Error).message.split("\n")[0]}`;
        return { ok: false, reason, harness: last };
      }
    },
  };
}
