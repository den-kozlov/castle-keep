// Hooks of the config file: keys `host.<event>`, `sandbox.<event>`, `*.<event>`.
// An entry is a script, by extension, or a shell command.
// A script gets CASTLE_KEEP_WORKTREE, CASTLE_KEEP_TASK and CASTLE_KEEP_ROLE.

import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";

export const HOOK_EVENTS = ["worktreeBuildup", "worktreeTeardown", "preflight", "periodic", "afterMerge"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
const HOST_ONLY: HookEvent[] = ["preflight", "periodic", "afterMerge"];
const PLACES = ["host", "sandbox", "*"] as const;

export interface HookEntry {
  run: string;
  /** What a notice calls the hook; the `run` string when left out. */
  name?: string;
  /** Periodic hooks only: the least time between two runs. */
  intervalMs?: number;
}

/** The entries of each place and event, `*` already spread over both places. */
export type HookTable = Record<"host" | "sandbox", Record<HookEvent, HookEntry[]>>;

export interface HookContext {
  /** Absolute path; left out, the shell command takes its own working directory. */
  worktree?: string;
  task?: string;
  role?: string;
}

export const emptyHooks = (): HookTable => {
  const place = () => Object.fromEntries(HOOK_EVENTS.map((e) => [e, [] as HookEntry[]])) as Record<HookEvent, HookEntry[]>;
  return { host: place(), sandbox: place() };
};

const INTERVAL = /^(\d+)\s*(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const entrySchema = z.union([
  z.string().trim().min(1),
  z.object({ run: z.string().trim().min(1), name: z.string().trim().min(1).optional(), interval: z.string().regex(INTERVAL, "must look like 30s, 10m, 1h or 1d").optional() }).strict(),
]);

/** The `hooks` object of the file: keys not checked yet. */
export const hooksSchema = z.record(z.string(), z.array(entrySchema)).default({});

/** Turns the raw `hooks` object into a table; the problems are `path: message` lines. */
export function parseHooks(raw: z.infer<typeof hooksSchema>): { table: HookTable; errors: string[] } {
  const table = emptyHooks();
  const errors: string[] = [];
  for (const [key, entries] of Object.entries(raw)) {
    const [place, event, ...extra] = key.split(".");
    if (!PLACES.includes(place as never) || !HOOK_EVENTS.includes(event as never) || extra.length) {
      errors.push(`hooks.${key}: key must be host.<event>, sandbox.<event> or *.<event>, with an event of ${HOOK_EVENTS.join(", ")}`);
      continue;
    }
    const hookEvent = event as HookEvent;
    if (place !== "host" && HOST_ONLY.includes(hookEvent)) {
      errors.push(`hooks.${key}: ${hookEvent} runs on the host only; use host.${hookEvent}`);
      continue;
    }
    entries.forEach((entry, i) => {
      const run = typeof entry === "string" ? entry : entry.run;
      const interval = typeof entry === "string" ? undefined : entry.interval;
      if (hookEvent === "periodic" && interval === undefined) {
        errors.push(`hooks.${key}.${i}: a periodic hook needs an interval`);
        return;
      }
      const match = interval === undefined ? undefined : INTERVAL.exec(interval);
      const name = typeof entry === "string" ? undefined : entry.name;
      const hook: HookEntry = { run, ...(name ? { name } : {}), ...(match ? { intervalMs: Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] } : {}) };
      for (const target of place === "*" ? (["host", "sandbox"] as const) : [place as "host" | "sandbox"]) table[target][hookEvent].push(hook);
    });
  }
  return { table, errors };
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Interpreter of a script by its extension; undefined for a shell command. */
function interpreter(word: string): string | undefined {
  if (/\.(mjs|js)$/.test(word)) return quote(process.execPath);
  if (/\.m?ts$/.test(word)) return `${quote(process.execPath)} --import tsx`;
  if (/\.sh$/.test(word)) return "sh";
  return undefined;
}

/** The shell line that runs an entry with the environment of the context. */
export function hookCommand(entry: HookEntry, context: HookContext): string {
  const env = [
    `CASTLE_KEEP_WORKTREE=${context.worktree === undefined ? '"$(pwd -P)"' : quote(context.worktree)}`,
    `CASTLE_KEEP_TASK=${quote(context.task ?? "")}`,
    `CASTLE_KEEP_ROLE=${quote(context.role ?? "")}`,
  ].map((v) => `export ${v}`).join("; ");
  const first = entry.run.split(/\s+/, 1)[0] ?? "";
  const runner = interpreter(first);
  return `${env}; ${runner ? `${runner} ${entry.run}` : entry.run}`;
}

export interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an entry on the host and waits. Never throws. */
export function runHook(entry: HookEntry, context: HookContext, options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", hookCommand(entry, context)], { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The same, blocking: for the preflight, which is synchronous. */
export function runHookSync(entry: HookEntry, context: HookContext, options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): HookRun {
  const out = spawnSync("sh", ["-c", hookCommand(entry, context)], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  return { code: out.status ?? 1, stdout: out.stdout ?? "", stderr: out.stderr ?? out.error?.message ?? "" };
}
