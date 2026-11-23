// What the settings window and the wizard edit, as `zod` object schemas,
// and the one write of the config file.

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigError, fileSchema, parseConfig, roleSchema, type RoleName } from "./config.mts";
import { AGENT_IDS, plugins as pluginModules, sandboxes, sources } from "./modules.mts";

export type Kind = "source" | "sandbox";
const registry = { source: sources, sandbox: sandboxes } as const;

/** The config key stays `source`; people know the module as the task tracker. */
export const KIND_LABEL: Record<Kind, string> = { source: "task tracker", sandbox: "sandbox" };

export const moduleNames = (kind: Kind) => Object.keys(registry[kind]);

/** The help line of a module: the description of its settings schema. */
export const moduleHelp = (kind: Kind, module: string) =>
  (registry[kind] as Record<string, { settings: z.ZodType }>)[module]?.settings.description;

export const kindHelp = (kind: Kind) => fileSchema.shape[kind].description;
export const roleHelp = (role: RoleName) => fileSchema.shape.roles.shape[role].description;
export const pluginHelp = (name: string) => pluginModules[name]?.settings.description;

/** The settings schema of a module, when it is an object the form can draw. */
export function settingsSchema(kind: Kind, module: string): z.ZodObject | undefined {
  const entry = (registry[kind] as Record<string, { settings: z.ZodType }>)[module];
  return entry?.settings instanceof z.ZodObject ? entry.settings : undefined;
}

/** The plugins the window offers under a source: those whose `requires` is met. */
export const visiblePlugins = (source: string) =>
  Object.entries(pluginModules)
    .filter(([, entry]) => !entry.requires || entry.requires.source === source)
    .map(([name]) => name);

/** A plugin's form: an `enabled` switch, and every setting shown only while it is on. */
export function pluginSchema(name: string): z.ZodObject {
  const settings = pluginModules[name]?.settings;
  const shape = settings instanceof z.ZodObject ? settings.shape : {};
  const dependent = Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, (field as z.ZodType).meta({ dependsOn: "enabled" })]));
  return z.object({ enabled: z.boolean().describe("On: the plugin runs. Off: the file drops its entry."), ...dependent });
}

/** The form of one role: the agent picked from the known ones. */
export const roleFormSchema = roleSchema.extend({
  agent: z.enum(AGENT_IDS as [string, ...string[]]).describe(roleSchema.shape.agent.description!),
});

/** Reads the config file, lets `change` edit it, checks the whole result and writes it. Returns the problem, if any. */
export function editConfig(path: string, change: (config: Record<string, any>) => void): string | undefined {
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    change(config);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    parseConfig(text);
    writeFileSync(path, text);
    return undefined;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof SyntaxError) return error.message.replace(/^invalid config: /, "");
    throw error;
  }
}

/** Sets or removes the plugin entry of `name`; `settings` undefined removes it. */
export function setPlugin(config: Record<string, any>, name: string, settings: Record<string, unknown> | undefined) {
  const rest = ((config.plugins ?? []) as { module: string }[]).filter((p) => p.module !== name);
  config.plugins = settings ? [...rest, { module: name, ...settings }] : rest;
}

/** Drops the plugins the source of the config does not suit. */
export function dropMismatched(config: Record<string, any>) {
  const keep = visiblePlugins(config.source?.module);
  config.plugins = ((config.plugins ?? []) as { module: string }[]).filter((p) => keep.includes(p.module));
}

/**
 * What a change of the module of `kind` to `choice` drops: the old module's settings that hold a value
 * and the plugins the new source no longer suits. Empty when the module stays.
 */
export function dropsOf(config: Record<string, any>, kind: Kind, choice: { module: string }): string[] {
  const old = (config[kind] ?? {}) as { module?: string } & Record<string, unknown>;
  if (old.module === choice.module) return [];
  const { module: _, ...settings } = old;
  const lines = Object.entries(settings)
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `setting ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  if (kind === "source") {
    const keep = visiblePlugins(choice.module);
    for (const plugin of (config.plugins ?? []) as { module: string }[]) {
      if (!keep.includes(plugin.module)) lines.push(`plugin ${plugin.module}`);
    }
  }
  return lines;
}
