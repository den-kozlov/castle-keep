// The stop and wake commands of a run.
//
// A soft stop lets the work in hand finish: queued issues do not start, running
// agents end their turn, the merge runs, then the run exits. While the run
// waits or plans, a soft stop exits at once; the planner writes nothing, so
// aborting it costs nothing. A second soft stop takes the first one back.
//
// A hard stop aborts the agents through an AbortSignal. Their worktrees and
// branches stay, so the next run resumes them. A merge never takes the
// signal: a kill inside `git merge` leaves a conflicted tree.

export type StopRequest = "none" | "soft" | "hard";

type Listener = () => void;

export class Control {
  private request: StopRequest = "none";
  private readonly hard = new AbortController();
  private readonly listeners = new Set<Listener>();
  private wakeWaiters = new Set<() => void>();
  private planAbort: AbortController | undefined;

  get stop(): StopRequest {
    return this.request;
  }

  /** Aborts the running agents. Never given to the merger. */
  get hardSignal(): AbortSignal {
    return this.hard.signal;
  }

  /** Soft stop, or its cancel when one is pending. Returns the new state. */
  toggleSoft(): StopRequest {
    if (this.request === "hard") return this.request;
    this.request = this.request === "soft" ? "none" : "soft";
    if (this.request === "soft") {
      this.planAbort?.abort(new Error("stop requested"));
      this.release();
    }
    this.changed();
    return this.request;
  }

  /** Soft stop that a second call does not cancel. For SIGTERM. */
  requestSoft(): void {
    if (this.request === "none") this.toggleSoft();
  }

  hardStop(): void {
    if (this.request === "hard") return;
    this.request = "hard";
    this.hard.abort(new Error("hard stop"));
    this.planAbort?.abort(new Error("hard stop"));
    this.release();
    this.changed();
  }

  /** Ends the current pause early. */
  wake(): void {
    this.release();
  }

  /**
   * A signal for one planner call: aborted by any stop request, soft or hard.
   */
  planSignal(): AbortSignal {
    this.planAbort = new AbortController();
    if (this.request !== "none") this.planAbort.abort(new Error("stop requested"));
    return this.planAbort.signal;
  }

  /**
   * Sleeps for `ms`. A stop request or a wake ends it early. The deadline is
   * on the wall clock, so a host that slept through it wakes the run at once.
   */
  async sleep(ms: number): Promise<"elapsed" | "woken" | "stopped"> {
    if (this.request !== "none") return "stopped";
    const deadline = Date.now() + ms;
    let woken = false;

    await new Promise<void>((resolve) => {
      const done = () => {
        clearInterval(tick);
        this.wakeWaiters.delete(onWake);
        resolve();
      };
      const onWake = () => {
        woken = true;
        done();
      };
      // A short tick instead of one long timer: a timer does not run while
      // the host sleeps, the wall clock does.
      const tick = setInterval(() => {
        if (Date.now() >= deadline) done();
      }, Math.min(1_000, Math.max(10, ms)));
      this.wakeWaiters.add(onWake);
    });

    if (this.request !== "none") return "stopped";
    return woken ? "woken" : "elapsed";
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private release(): void {
    const waiters = [...this.wakeWaiters];
    this.wakeWaiters = new Set();
    for (const wake of waiters) wake();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
