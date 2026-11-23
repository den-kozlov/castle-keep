// The `claude-limits` plugin: a usage-limit gate for the Claude subscription the
// agents run on. It closes every step of an agent on `claude-code`, `review` and
// `merge` too: a step the window may cut is not started.
//
// A Claude plan has two rolling windows: a 5-hour session window and a 7-day
// weekly window. The gate reads how much of each window is used and closes
// when either one reaches the stop threshold.
//
// Sources, tried in order:
//   1. GET https://api.anthropic.com/api/oauth/usage — free, but undocumented,
//      and it answers 429 when polled too often. After a 429 the gate skips it
//      for USAGE_API_BACKOFF_MS.
//   2. A one-turn `claude -p` call on Haiku with --output-format stream-json.
//      Claude Code emits a `rate_limit_event` whose `unifiedWindows` carries
//      both windows. Costs one tiny request.
//
// A token from `claude setup-token` lacks the `user:profile` scope, so source 1
// answers 403 for it and the probe does the work.
//
// Both sources also give the reset time of each window. A closed gate carries
// the time to wait until, so an endless run sleeps to the reset instead of
// polling the windows.
//
// If neither source answers, the gate stays closed: no data means no new work.
//
// The token comes from .sandcastle/.env, the same file the sandboxes use, so
// the gate measures the account the agents actually spend.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { ENV_FILE, readEnvFile } from "../env-file.mts";
import type { Plugin, UiElement } from "../plugin.mts";

const CLAUDE_AGENT = "claude-code";
const CACHE_MS = 60_000;
const USAGE_API_TIMEOUT_MS = 5_000;
const USAGE_API_BACKOFF_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 90_000;

/** One plan window: how full it is and when it rolls over. */
export interface LimitWindow {
  /** Percent used, 0–100 (can exceed 100). */
  percent: number;
  /** When the window resets; undefined when the source did not say. */
  resetsAt?: Date;
}

export interface LimitWindows {
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
  source: "usage-api" | "cli-probe";
}

/** The stop threshold of each window, in percent. */
export interface LimitThresholds {
  fiveHourPercent: number;
  sevenDayPercent: number;
}

/**
 * The gate. A closed gate carries `waitUntil` when every closed window named
 * its reset time: the latest reset plus RESET_MARGIN_MS. Without it the caller
 * falls back to its own backoff.
 */
export type LimitGate =
  | { ok: true; summary: string; windows?: LimitWindows }
  | { ok: false; reason: string; waitUntil?: Date; windows?: LimitWindows };

/** Slack after a reset time, so the next reading sees the new window. */
export const RESET_MARGIN_MS = 2 * 60_000;

type Reading = { windows: LimitWindows } | { error: string };

let cached: { at: number; reading: Reading } | undefined;
let inFlight: Promise<Reading> | undefined;
let usageApiBlockedUntil = 0;

/**
 * Reads both windows and decides the gate.
 * Concurrent callers share one lookup; results are cached for CACHE_MS.
 */
export async function checkLimits(thresholds: LimitThresholds): Promise<LimitGate> {
  const auth = readAuth();

  if (auth.kind === "api-key") {
    return { ok: true, summary: "ANTHROPIC_API_KEY in use; no plan windows apply" };
  }
  if (auth.kind === "none") {
    return { ok: false, reason: `no CLAUDE_CODE_OAUTH_TOKEN in ${ENV_FILE}` };
  }

  const reading = await readWindows(auth.token);
  if ("error" in reading) {
    return { ok: false, reason: `limit data unavailable: ${reading.error}` };
  }
  return evaluateGate(reading.windows, thresholds);
}

const hhmm = (at: Date) =>
  at.toLocaleString("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Decides the gate from a reading. Pure, so tests drive it with a clock. */
export function evaluateGate(
  windows: LimitWindows,
  thresholds: LimitThresholds,
  now: Date = new Date(),
): LimitGate {
  const checked = [
    { label: "5h", window: windows.fiveHour, stop: thresholds.fiveHourPercent },
    { label: "7d", window: windows.sevenDay, stop: thresholds.sevenDayPercent },
  ];
  const summary =
    checked
      .map(({ label, window, stop }) => `${label} ${window.percent.toFixed(0)}%/${stop}%`)
      .join(", ") + ` (via ${windows.source})`;

  const closed = checked.filter(({ window, stop }) => window.percent >= stop);
  if (closed.length === 0) return { ok: true, summary, windows };

  const resets = closed.map(({ window }) => window.resetsAt?.getTime());
  let waitUntil: Date | undefined;
  if (resets.every((at): at is number => at !== undefined)) {
    const at = Math.max(...resets) + RESET_MARGIN_MS;
    if (at > now.getTime()) waitUntil = new Date(at);
  }

  const names = closed
    .map(({ label, window }) =>
      window.resetsAt ? `${label} resets ${hhmm(window.resetsAt)}` : `${label} full`,
    )
    .join(", ");
  return { ok: false, reason: `${summary}; ${names}`, waitUntil, windows };
}

/** A reset time as epoch seconds or an ISO string; undefined otherwise. */
function toDate(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);
  if (typeof value === "string") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? undefined : at;
  }
  return undefined;
}

/**
 * Reads the body of /api/oauth/usage. It reports utilization in percent and
 * `resets_at` as an ISO string. Returns the reason when the body is unusable.
 */
export function parseUsageApi(body: unknown): LimitWindows | string {
  const b = body as {
    five_hour?: { utilization?: unknown; resets_at?: unknown };
    seven_day?: { utilization?: unknown; resets_at?: unknown };
  };
  const fiveHour = b?.five_hour?.utilization;
  const sevenDay = b?.seven_day?.utilization;
  if (typeof fiveHour !== "number" || typeof sevenDay !== "number") {
    return "response has no five_hour/seven_day utilization";
  }
  return {
    fiveHour: { percent: fiveHour, resetsAt: toDate(b.five_hour?.resets_at) },
    sevenDay: { percent: sevenDay, resetsAt: toDate(b.seven_day?.resets_at) },
    source: "usage-api",
  };
}

/**
 * Reads one stream-json message of `claude -p`. A `rate_limit_event` carries
 * `unifiedWindows`, with utilization as a fraction 0–1 and `resetsAt` in epoch
 * seconds. Any other message gives undefined.
 */
export function parseRateLimitEvent(message: any): LimitWindows | undefined {
  if (message?.type !== "rate_limit_event") return undefined;
  const windows = message.rate_limit_info?.unifiedWindows;
  const fiveHour = windows?.five_hour?.utilization;
  const sevenDay = windows?.seven_day?.utilization;
  if (typeof fiveHour !== "number" || typeof sevenDay !== "number") return undefined;
  return {
    fiveHour: { percent: fiveHour * 100, resetsAt: toDate(windows.five_hour.resetsAt) },
    sevenDay: { percent: sevenDay * 100, resetsAt: toDate(windows.seven_day.resetsAt) },
    source: "cli-probe",
  };
}

async function readWindows(token: string): Promise<Reading> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.reading;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const errors: string[] = [];

    const fromApi = await fetchUsageApi(token);
    if ("windows" in fromApi) return fromApi;
    errors.push(`usage-api: ${fromApi.error}`);

    const fromProbe = await probeViaCli(token);
    if ("windows" in fromProbe) return fromProbe;
    errors.push(`cli-probe: ${fromProbe.error}`);

    return { error: errors.join("; ") };
  })();

  try {
    const reading = await inFlight;
    cached = { at: Date.now(), reading };
    return reading;
  } finally {
    inFlight = undefined;
  }
}

async function fetchUsageApi(token: string): Promise<Reading> {
  if (Date.now() < usageApiBlockedUntil) {
    return { error: "skipped after a recent 429" };
  }

  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(USAGE_API_TIMEOUT_MS),
    });

    if (response.status === 429) {
      usageApiBlockedUntil = Date.now() + USAGE_API_BACKOFF_MS;
      return { error: "HTTP 429" };
    }
    if (!response.ok) return { error: `HTTP ${response.status}` };

    const windows = parseUsageApi(await response.json());
    return typeof windows === "string" ? { error: windows } : { windows };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function probeViaCli(token: string): Promise<Reading> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
    delete env.ANTHROPIC_API_KEY;

    // --restricted skips user, project and local settings, so no hooks run.
    // A temp cwd keeps the repo's CLAUDE.md out of the request.
    const child = spawn(
      "claude",
      [
        "-p",
        "Reply with OK.",
        "--model",
        "haiku",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "1",
        "--restricted",
        "--strict-mcp-config",
        "--no-session-persistence",
      ],
      { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let buffer = "";
    let lastResultText = "";

    const finish = (reading: Reading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(reading);
    };

    const timer = setTimeout(
      () => finish({ error: `no rate_limit_event within ${PROBE_TIMEOUT_MS} ms` }),
      PROBE_TIMEOUT_MS,
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.type === "result") {
          lastResultText = String(message.result ?? "");
        }

        const windows = parseRateLimitEvent(message);
        if (windows) {
          finish({ windows });
          return;
        }
      }
    });

    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (code) =>
      finish({
        error:
          `claude exited with code ${code} before a rate_limit_event` +
          (lastResultText ? ` (${lastResultText.slice(0, 120)})` : ""),
      }),
    );
  });
}

type Auth =
  | { kind: "oauth"; token: string }
  | { kind: "api-key" }
  | { kind: "none" };

function readAuth(): Auth {
  const fromFile = readEnvFile();
  const token =
    fromFile.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) return { kind: "oauth", token };

  const apiKey = fromFile.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { kind: "api-key" };

  return { kind: "none" };
}

export interface ClaudeLimitsOptions extends LimitThresholds {
  /** Reads the windows and decides the gate. Replaced in tests. */
  check?: (thresholds: LimitThresholds) => Promise<LimitGate>;
}

const meters = (windows: LimitWindows, thresholds: LimitThresholds): UiElement[] => [
  { kind: "meter", label: "5h", percent: windows.fiveHour.percent, warn: thresholds.fiveHourPercent - 15, stop: thresholds.fiveHourPercent, resetsAt: windows.fiveHour.resetsAt },
  { kind: "meter", label: "7d", percent: windows.sevenDay.percent, warn: thresholds.sevenDayPercent - 15, stop: thresholds.sevenDayPercent, resetsAt: windows.sevenDay.resetsAt },
];

/** The plugin: the plan-window gate of the agents on `claude-code`, with the 5h and 7d meters. */
export function claudeLimits(options: ClaudeLimitsOptions): Plugin {
  const thresholds: LimitThresholds = { fiveHourPercent: options.fiveHourPercent, sevenDayPercent: options.sevenDayPercent };
  const check = options.check ?? checkLimits;
  let last: LimitGate | undefined;
  let warned = false;
  return {
    name: "claude-limits",
    gate: {
      async check(event) {
        if (event.agent !== CLAUDE_AGENT) return { open: true };
        last = await check(thresholds);
        return last.ok ? { open: true } : { open: false, reason: last.reason, until: last.waitUntil };
      },
    },
    header: () => {
      if (last?.windows) return meters(last.windows, thresholds);
      return last?.ok ? [{ kind: "text", text: last.summary }] : [];
    },
    lifecycle: {
      iterationStart(context) {
        const used = Object.values(context.roles).some((role) => role.agent === CLAUDE_AGENT);
        if (!used && !warned) {
          warned = true;
          context.notice("claude-limits: no role uses claude-code, the plugin gates nothing", "warn");
        }
      },
    },
  };
}
