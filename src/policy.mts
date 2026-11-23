// Pure decisions of the loop: how long to wait, and whether a poll is worth a
// planner call.
//
// An endless run polls the task source with one cheap call. The planner, an Opus call
// of one to three minutes, runs only when the ready set changed since the last
// iteration that made no progress. A failing issue stays ready, and without
// this rule the loop would replan and rerun it at once, forever.

/** Two modes, one loop. See ./engine.mts. */
export type Mode = "endless" | "batch";

/** First pause of the backoff. */
export const BACKOFF_FIRST_MS = 60_000;

/** The pause never grows above this. */
export const BACKOFF_MAX_MS = 60 * 60_000;

/** Exponential backoff: 1 min, 2, 4 … capped at 60 min. */
export class Backoff {
  private nextMs: number;

  constructor(
    private readonly firstMs = BACKOFF_FIRST_MS,
    private readonly maxMs = BACKOFF_MAX_MS,
  ) {
    this.nextMs = firstMs;
  }

  /** The pause to take now. The one after it is twice as long. */
  next(): number {
    const ms = this.nextMs;
    this.nextMs = Math.min(this.nextMs * 2, this.maxMs);
    return ms;
  }

  /** Back to the first pause, after an iteration that started work. */
  reset(): void {
    this.nextMs = this.firstMs;
  }
}

/**
 * A key of the ready set: every task id with its change key. A new task, a
 * closed one, an edit or a comment changes it.
 */
export function readySetKey(tasks: { id: string; changeKey: string }[]): string {
  return tasks
    .map((task) => `${task.id}@${task.changeKey}`)
    .sort()
    .join(",");
}

export type PollVerdict =
  | { plan: true }
  | { plan: false; why: "no ready issues" | "nothing changed since the last idle iteration" };

/** Whether a poll leads to a planner call. */
export function decidePoll(key: string, idleKey: string | undefined): PollVerdict {
  if (key === "") return { plan: false, why: "no ready issues" };
  if (key === idleKey) return { plan: false, why: "nothing changed since the last idle iteration" };
  return { plan: true };
}
