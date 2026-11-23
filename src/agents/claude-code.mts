// The `claude-code` agent: builds the `claude` command and reads its stream.
//
// Claude Code prints one JSON line per event in `--output-format stream-json`.
// Each `assistant` line carries the usage of the model turn that produced it:
// the tokens the model read fresh, the tokens it wrote into the prompt cache,
// and the tokens it read back from the cache. Their sum is the size of the
// context window at that turn, the same sum sandcastle prints as "Context
// window" after a run. Sandcastle hands every stdout line to the `raw` stream
// event, so the view can follow the size while the agent works.

import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentModule, StreamSignal } from "../agent.mts";

interface StreamUsage {
  readonly input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
}

/**
 * The context window size an `assistant` stream line reports, in tokens, or
 * undefined for every other line.
 */
export function contextTokens(line: string): number | undefined {
  if (!line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const event = parsed as { type?: unknown; message?: { usage?: StreamUsage } };
  if (event.type !== "assistant") return undefined;
  const usage = event.message?.usage;
  if (!usage) return undefined;
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  if (!parts.every((part) => typeof part === "number")) return undefined;
  return (parts as number[]).reduce((sum, part) => sum + part, 0);
}

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Merges settings fragments: objects by key, arrays by concatenation, else the later wins. */
export function mergeSettings(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (isRecord(a) && isRecord(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = key in a ? mergeSettings(a[key], value) : value;
    return out;
  }
  return b;
}

/** The `claudeCode.settings` fragments of the blocks, merged into one object; undefined when none. */
export function claudeSettings(blocks: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const fragments = blocks.flatMap((block) => {
    const settings = isRecord(block.claudeCode) ? block.claudeCode.settings : undefined;
    return isRecord(settings) ? [settings] : [];
  });
  return fragments.length ? (fragments.reduce((a, b) => mergeSettings(a, b) as Record<string, unknown>)) : undefined;
}

export const claudeCodeAgent: AgentModule = {
  id: "claude-code",
  authEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  provider({ model, effort, noSandbox, env, blocks }) {
    const base = sandcastle.claudeCode(model, effort ? { effort } : undefined);
    const settings = claudeSettings(blocks);
    const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`));
    return {
      ...base,
      buildPrintCommand: (options) => {
        const print = base.buildPrintCommand(noSandbox ? { ...options, dangerouslySkipPermissions: true } : options);
        let command = print.command;
        if (settings !== undefined) command = command.replace(/^claude /, `claude --settings ${shellQuote(JSON.stringify(settings))} `);
        if (assignments.length > 0) command = `env ${assignments.join(" ")} ${command}`;
        return { ...print, command };
      },
    };
  },
  signals(event) {
    const out: StreamSignal[] = [];
    if (event.type === "toolCall") out.push({ kind: "tool", text: `${event.name}(${event.formattedArgs})` });
    else if (event.type === "text") out.push({ kind: "text", text: event.message });
    else if (event.type === "raw") {
      const tokens = contextTokens(event.line);
      if (tokens !== undefined) out.push({ kind: "context", tokens });
    }
    return out;
  },
};
