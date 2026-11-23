import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Backoff, decidePoll, readySetKey } from "./policy.mts";

describe("Backoff", () => {
  it("doubles from one minute and stops at one hour", () => {
    const backoff = new Backoff();
    const minutes = Array.from({ length: 9 }, () => backoff.next() / 60_000);

    assert.deepEqual(minutes, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("starts again at one minute after a reset", () => {
    const backoff = new Backoff();
    backoff.next();
    backoff.next();
    backoff.reset();

    assert.equal(backoff.next(), 60_000);
  });
});

describe("readySetKey", () => {
  it("does not depend on the order of the list", () => {
    const a = [
      { id: "2", changeKey: "t2" },
      { id: "1", changeKey: "t1" },
    ];
    const b = [
      { id: "1", changeKey: "t1" },
      { id: "2", changeKey: "t2" },
    ];

    assert.equal(readySetKey(a), readySetKey(b));
  });

  it("changes when an issue is edited", () => {
    const before = [{ id: "1", changeKey: "t1" }];
    const after = [{ id: "1", changeKey: "t9" }];

    assert.notEqual(readySetKey(before), readySetKey(after));
  });

  it("is empty for an empty list", () => {
    assert.equal(readySetKey([]), "");
  });
});

describe("decidePoll", () => {
  it("skips the planner when nothing is ready", () => {
    assert.deepEqual(decidePoll("", undefined), { plan: false, why: "no ready issues" });
  });

  it("skips the planner when the set is the one of the last idle iteration", () => {
    assert.equal(decidePoll("1@t", "1@t").plan, false);
  });

  it("plans a changed set", () => {
    assert.equal(decidePoll("1@t2", "1@t").plan, true);
    assert.equal(decidePoll("1@t", undefined).plan, true);
  });
});
