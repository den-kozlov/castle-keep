// Retrying wrapper around the `gh` CLI.
//
// A short network hiccup used to end a whole sandcastle run. Sandcastle expands
// a !`...` block while it builds a prompt, throws PromptError on a non-zero
// exit, and nothing catches it. The fix keeps every `gh` call of the harness
// here instead: the source ./sources/github.mts reads the issues first, retries a failure a
// bounded number of times, and the run pauses with a clear message when
// GitHub stays unreachable.
//
// Every failure is retried. A permanent failure — a wrong label, no auth —
// costs a few seconds of pauses and then reports the same error it always did.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Attempts per call, including the first one. Three attempts are two retries. */
const GH_ATTEMPTS = 3;

/** Pause before the first retry. It doubles before each later retry. */
const GH_BASE_DELAY_MS = 2_000;

/** A single `gh` call can hold a large issue list. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Longest command line printed in a log message. A `--jq` filter is long. */
const MAX_PRINTED_COMMAND = 100;

export interface RetryOptions {
  /** Attempts in total, including the first one. */
  attempts: number;
  /** Pause before the first retry, in milliseconds. It doubles each time. */
  baseDelayMs: number;
  /** Replaced in tests so the pauses cost no time. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each failure that leads to a retry. */
  onRetry?: (attempt: number, error: Error, waitMs: number) => void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** Shortens a command so one failure fits on one line. */
export function describeCommand(args: string[]): string {
  const line = `gh ${args.join(" ")}`;
  return line.length <= MAX_PRINTED_COMMAND
    ? line
    : `${line.slice(0, MAX_PRINTED_COMMAND)}…`;
}

/**
 * The first line of what went wrong. `execFile` puts the command in `message`
 * and the reason in `stderr`, so prefer `stderr` when it carries text.
 */
export function describeFailure(reason: unknown): string {
  const error = asError(reason) as Error & { stderr?: string };
  const stderr = error.stderr?.trim();
  const text = stderr && stderr.length > 0 ? stderr : error.message;
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Runs `task` until it succeeds or the attempt count runs out. The pause grows
 * by a factor of two before each retry. Throws the error of the last attempt.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  let lastError: Error = new Error("no attempt ran");

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await task();
    } catch (reason) {
      lastError = asError(reason);
      if (attempt === options.attempts) break;

      const waitMs = options.baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, lastError, waitMs);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

/** Runs one `gh` call and returns its standard output. */
export type CommandRunner = (args: string[]) => Promise<string>;

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout;
}

export interface GhOptions extends Partial<RetryOptions> {
  /** Replaced in tests. Defaults to the real `gh` CLI. */
  run?: CommandRunner;
}

/**
 * Calls `gh` with the given arguments and returns its standard output.
 * Makes GH_ATTEMPTS attempts in total, then throws an error that names the
 * command, the attempt count and the last failure.
 */
export async function gh(args: string[], options: GhOptions = {}): Promise<string> {
  const run = options.run ?? runGh;
  const attempts = options.attempts ?? GH_ATTEMPTS;
  const printed = describeCommand(args);

  try {
    return await withRetry(() => run(args), {
      attempts,
      baseDelayMs: options.baseDelayMs ?? GH_BASE_DELAY_MS,
      sleep: options.sleep,
      onRetry:
        options.onRetry ??
        ((attempt, error, waitMs) => {
          console.log(
            `  ↻ ${printed} failed (attempt ${attempt}/${attempts}), ` +
              `retry in ${waitMs / 1000}s: ${describeFailure(error)}`,
          );
        }),
    });
  } catch (reason) {
    throw new Error(
      `\`${printed}\` failed after ${attempts} attempts: ${describeFailure(reason)}`,
    );
  }
}

