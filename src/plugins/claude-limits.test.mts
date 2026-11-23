import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claudeLimits,
  evaluateGate,
  parseRateLimitEvent,
  parseUsageApi,
  RESET_MARGIN_MS,
  type LimitWindows,
} from "./claude-limits.mts";

const thresholds = { fiveHourPercent: 90, sevenDayPercent: 95 };
const now = new Date("2026-10-02T12:00:00Z");

const windows = (
  fiveHour: number,
  sevenDay: number,
  resets: { fiveHour?: string; sevenDay?: string } = {},
): LimitWindows => ({
  fiveHour: {
    percent: fiveHour,
    resetsAt: resets.fiveHour ? new Date(resets.fiveHour) : undefined,
  },
  sevenDay: {
    percent: sevenDay,
    resetsAt: resets.sevenDay ? new Date(resets.sevenDay) : undefined,
  },
  source: "cli-probe",
});

describe("parseRateLimitEvent", () => {
  it("reads both windows as percent with their reset times", () => {
    const parsed = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.11, resetsAt: 1790946600 },
          seven_day: { utilization: 0.81, resetsAt: 1791151200 },
        },
      },
    });

    assert.ok(parsed);
    assert.equal(Math.round(parsed.fiveHour.percent), 11);
    assert.equal(Math.round(parsed.sevenDay.percent), 81);
    assert.equal(parsed.fiveHour.resetsAt?.getTime(), 1790946600 * 1000);
    assert.equal(parsed.sevenDay.resetsAt?.getTime(), 1791151200 * 1000);
    assert.equal(parsed.source, "cli-probe");
  });

  it("keeps a window without a reset time", () => {
    const parsed = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.5 },
          seven_day: { utilization: 0.5 },
        },
      },
    });

    assert.equal(parsed?.fiveHour.resetsAt, undefined);
  });

  it("ignores any other message", () => {
    assert.equal(parseRateLimitEvent({ type: "result", result: "OK" }), undefined);
    assert.equal(parseRateLimitEvent({ type: "rate_limit_event" }), undefined);
  });
});

describe("parseUsageApi", () => {
  it("reads percent and ISO reset times", () => {
    const parsed = parseUsageApi({
      five_hour: { utilization: 42, resets_at: "2026-10-02T14:00:00Z" },
      seven_day: { utilization: 70, resets_at: "2026-10-05T09:00:00Z" },
    });

    assert.ok(typeof parsed !== "string");
    assert.equal(parsed.fiveHour.percent, 42);
    assert.equal(parsed.fiveHour.resetsAt?.toISOString(), "2026-10-02T14:00:00.000Z");
    assert.equal(parsed.sevenDay.resetsAt?.toISOString(), "2026-10-05T09:00:00.000Z");
    assert.equal(parsed.source, "usage-api");
  });

  it("names a body without utilization", () => {
    assert.equal(typeof parseUsageApi({}), "string");
  });

  it("drops a reset time that is not a date", () => {
    const parsed = parseUsageApi({
      five_hour: { utilization: 1, resets_at: "soon" },
      seven_day: { utilization: 1, resets_at: null },
    });

    assert.ok(typeof parsed !== "string");
    assert.equal(parsed.fiveHour.resetsAt, undefined);
    assert.equal(parsed.sevenDay.resetsAt, undefined);
  });
});

describe("evaluateGate", () => {
  it("opens below both thresholds", () => {
    const gate = evaluateGate(windows(89, 94), thresholds, now);

    assert.equal(gate.ok, true);
  });

  it("closes the 5-hour window at 90 % and waits for its reset plus the margin", () => {
    const gate = evaluateGate(
      windows(90, 10, { fiveHour: "2026-10-02T13:00:00Z" }),
      thresholds,
      now,
    );

    assert.equal(gate.ok, false);
    assert.equal(
      !gate.ok && gate.waitUntil?.getTime(),
      new Date("2026-10-02T13:00:00Z").getTime() + RESET_MARGIN_MS,
    );
    assert.match(!gate.ok ? gate.reason : "", /5h/);
  });

  it("keeps the 7-day window open at 94 % and closes it at 95 %", () => {
    assert.equal(evaluateGate(windows(10, 94), thresholds, now).ok, true);
    assert.equal(evaluateGate(windows(10, 95), thresholds, now).ok, false);
  });

  it("waits for the later reset when both windows are closed", () => {
    const gate = evaluateGate(
      windows(95, 99, {
        fiveHour: "2026-10-02T13:00:00Z",
        sevenDay: "2026-10-04T09:00:00Z",
      }),
      thresholds,
      now,
    );

    assert.equal(
      !gate.ok && gate.waitUntil?.getTime(),
      new Date("2026-10-04T09:00:00Z").getTime() + RESET_MARGIN_MS,
    );
  });

  it("gives no wait time when a closed window has no reset time", () => {
    const gate = evaluateGate(windows(95, 10), thresholds, now);

    assert.equal(gate.ok, false);
    assert.equal(!gate.ok && gate.waitUntil, undefined);
  });

  it("gives no wait time when the reset is already past", () => {
    const gate = evaluateGate(
      windows(95, 10, { fiveHour: "2026-10-02T11:00:00Z" }),
      thresholds,
      now,
    );

    assert.equal(!gate.ok && gate.waitUntil, undefined);
  });

  it("carries the windows for the status line", () => {
    const gate = evaluateGate(windows(12, 34), thresholds, now);

    assert.equal(gate.windows?.fiveHour.percent, 12);
  });
});

describe("the claude-limits plugin", () => {
  const plugin = (fiveHour: number) =>
    claudeLimits({ ...thresholds, check: async (t) => evaluateGate(windows(fiveHour, 10), t, now) });

  it("closes merge at 5h = 91 % and passes poll", async () => {
    const limits = plugin(91);
    const merge = await limits.gate!.check({ step: "merge", role: "merger", agent: "claude-code" });
    assert.equal(merge.open, false);
    assert.deepEqual(await limits.gate!.check({ step: "poll" }), { open: true });
  });

  it("closes review too, with no exception", async () => {
    const answer = await plugin(95).gate!.check({ step: "review", role: "reviewer", agent: "claude-code" });
    assert.equal(answer.open, false);
  });

  it("passes the steps of another agent and opens under the stop", async () => {
    assert.deepEqual(await plugin(99).gate!.check({ step: "implement", role: "implementer", agent: "other" }), { open: true });
    assert.deepEqual(await plugin(89).gate!.check({ step: "implement", role: "implementer", agent: "claude-code" }), { open: true });
  });

  it("shows the 5h and 7d meters after a check", async () => {
    const limits = plugin(50);
    assert.deepEqual(limits.header!(), []);
    await limits.gate!.check({ step: "plan", role: "planner", agent: "claude-code" });
    const elements = limits.header!();
    assert.deepEqual(elements.map((e) => (e.kind === "meter" ? [e.label, e.percent, e.stop] : [])), [["5h", 50, 90], ["7d", 10, 95]]);
  });

  it("warns once when no role uses claude-code", async () => {
    const notices: string[] = [];
    const context = { notice: (text: string) => notices.push(text), roles: { planner: { agent: "x", model: "m" } } } as never;
    const limits = plugin(0);
    await limits.lifecycle!.iterationStart!(context, { iteration: 1 });
    await limits.lifecycle!.iterationStart!(context, { iteration: 2 });
    assert.equal(notices.length, 1);
  });
});
