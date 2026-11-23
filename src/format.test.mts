import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTokens } from "./format.mts";

describe("formatTokens", () => {
  it("shortens a count to a cell", () => {
    assert.equal(formatTokens(850), "850");
    assert.equal(formatTokens(12_400), "12k");
    assert.equal(formatTokens(999_499), "999k");
    assert.equal(formatTokens(1_240_000), "1.2M");
  });
});
