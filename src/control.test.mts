import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Control } from "./control.mts";

describe("Control", () => {
  it("takes a soft stop back on the second press", () => {
    const control = new Control();

    assert.equal(control.toggleSoft(), "soft");
    assert.equal(control.toggleSoft(), "none");
  });

  it("aborts the planner on a soft stop but not the agents", () => {
    const control = new Control();
    const plan = control.planSignal();

    control.toggleSoft();

    assert.equal(plan.aborted, true);
    assert.equal(control.hardSignal.aborted, false);
  });

  it("aborts the agents on a hard stop, and a soft press does not undo it", () => {
    const control = new Control();

    control.hardStop();
    control.toggleSoft();

    assert.equal(control.hardSignal.aborted, true);
    assert.equal(control.stop, "hard");
  });

  it("ends a pause on a stop request", async () => {
    const control = new Control();
    const pause = control.sleep(60_000);

    control.toggleSoft();

    assert.equal(await pause, "stopped");
  });

  it("ends a pause on a wake", async () => {
    const control = new Control();
    const pause = control.sleep(60_000);

    control.wake();

    assert.equal(await pause, "woken");
  });

  it("lets a short pause elapse", async () => {
    assert.equal(await new Control().sleep(20), "elapsed");
  });

  it("keeps SIGTERM from cancelling a pending stop", () => {
    const control = new Control();
    control.toggleSoft();

    control.requestSoft();

    assert.equal(control.stop, "soft");
  });
});
