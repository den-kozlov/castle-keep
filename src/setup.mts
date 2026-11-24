// The one setup function of `castle-keep init` and of the first-run wizard:
// both turn their choices into SetupChoices and call `writeSetup`, so the same choices give the same files.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, parseConfig, ROLES, type RoleName } from "./config.mts";
import { agents } from "./modules.mts";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
export const PROMPTS = { plan: "plan-prompt.md", implement: "implement-prompt.md", review: "review-prompt.md", merge: "merge-prompt.md" } as const;
export const STANDARDS = "CODING_STANDARDS.md";
/** The files setup copies from ./templates into `.sandcastle/`. */
const COPIED = [...Object.values(PROMPTS), STANDARDS];
export const ENV_EXAMPLE = ".sandcastle/.env.example";
/** The local files of a run: setup adds the missing ones to `.gitignore`, since a run needs a clean checkout. */
export const GITIGNORED = [".sandcastle/.env", ".sandcastle/logs/", ".sandcastle/worktrees/", ".sandcastle/run.pid"];

const DEFAULT_MODELS: Record<RoleName, string> = {
  planner: "claude-haiku-5-5",
  implementer: "claude-sonnet-5-5",
  reviewer: "claude-opus-5-5",
  merger: "claude-haiku-5-5",
};

export interface ModuleChoice {
  module: string;
  [setting: string]: unknown;
}

export interface RoleChoice {
  agent: string;
  model: string;
  effort?: string;
}

export interface SetupChoices {
  source: ModuleChoice;
  sandbox: ModuleChoice;
  roles: Record<RoleName, RoleChoice>;
  gates: string[];
  plugins: ModuleChoice[];
  baseBranch?: string;
  /** Hook commands by key, for example `{ "sandbox.worktreeBuildup": ["npm ci"] }`. */
  hooks?: Record<string, string[]>;
  /** Copy the generic prompts into `.sandcastle/`; default true. */
  copyPrompts?: boolean;
}

/** The same agent for every role, each with its default model. */
export function defaultRoles(agent = "claude-code"): Record<RoleName, RoleChoice> {
  return Object.fromEntries(ROLES.map((role) => [role, { agent, model: DEFAULT_MODELS[role] }])) as Record<RoleName, RoleChoice>;
}

/** The text of the config file for the choices. */
function configText(choices: SetupChoices): string {
  const config = {
    source: choices.source,
    sandbox: choices.sandbox,
    roles: choices.roles,
    prompts: Object.fromEntries(Object.entries(PROMPTS).map(([key, file]) => [key, `./.sandcastle/${file}`])),
    gates: choices.gates,
    hooks: choices.hooks ?? {},
    plugins: choices.plugins,
    ...(choices.baseBranch ? { baseBranch: choices.baseBranch } : {}),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export type SetupResult = { ok: true; files: string[] } | { ok: false; existing: string[] };

/** Writes the config, `.env.example` and, unless told not to, the prompts. Refuses to overwrite without `force`; throws a ConfigError on invalid choices. */
export function writeSetup(cwd: string, choices: SetupChoices, force = false): SetupResult {
  const text = configText(choices);
  const parsed = parseConfig(text);
  const copy = choices.copyPrompts !== false;
  const targets = [CONFIG_FILE, ...(copy ? COPIED.map((file) => `.sandcastle/${file}`) : [])];
  const existing = targets.filter((t) => existsSync(join(cwd, t)));
  if (existing.length > 0 && !force) return { ok: false, existing };

  mkdirSync(join(cwd, ".sandcastle"), { recursive: true });
  writeFileSync(join(cwd, CONFIG_FILE), text);
  if (copy) for (const file of COPIED) copyFileSync(join(TEMPLATES, file), join(cwd, ".sandcastle", file));
  const keys = [...new Set([...Object.values(choices.roles).flatMap((r) => agents[r.agent]?.build({}).authEnv ?? []), ...parsed.source.build().env])];
  writeFileSync(join(cwd, ENV_EXAMPLE), `${keys.map((k) => `${k}=`).join("\n")}\n`);
  const ignored = ignoreLocalFiles(cwd);
  return { ok: true, files: [...targets, ENV_EXAMPLE, ...(ignored ? [".gitignore"] : [])] };
}

/** Appends the missing lines of GITIGNORED to `.gitignore`. Returns whether the file changed. */
function ignoreLocalFiles(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(text.split("\n").map((line) => line.trim()));
  const missing = GITIGNORED.filter((line) => !present.has(line));
  if (missing.length === 0) return false;
  const gap = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  appendFileSync(path, `${gap}# castle-keep: secrets, logs, worktrees and the run lock stay local.\n${missing.join("\n")}\n`);
  return true;
}

/** What a person does after setup, before the first `castle-keep run`. */
export function nextSteps(): string {
  const steps = [
    `Put the keys of ${ENV_EXAMPLE} with their values in .sandcastle/.env.`,
    "Commit .gitignore and .sandcastle/: a run starts only from a clean checkout.",
    "Start the loop: npx castle-keep run",
  ];
  return ["Next:", ...steps.map((step, i) => `  ${i + 1}. ${step}`)].join("\n");
}
