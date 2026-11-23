import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { architectureNote, architectureVerdict, needsHumanReason, reviewOutcome } from "./review.mts";

describe("architectureVerdict", () => {
  it("reads a sound verdict", () => {
    assert.equal(architectureVerdict("done\n<architecture>sound</architecture>\n"), "sound");
  });

  it("reads a blocked verdict", () => {
    assert.equal(architectureVerdict("<architecture>blocked</architecture>"), "blocked");
  });

  it("takes the last tag when the output quotes an earlier one", () => {
    const out =
      "I will answer <architecture>blocked</architecture> only for a wrong shape.\n" +
      "<architecture>sound</architecture>";
    assert.equal(architectureVerdict(out), "sound");
  });

  it("reports a missing tag", () => {
    assert.equal(architectureVerdict("<promise>COMPLETE</promise>"), "missing");
    assert.equal(architectureVerdict("<architecture>maybe</architecture>"), "missing");
  });
});

describe("architectureNote", () => {
  it("reads a note", () => {
    const out =
      "<architecture-note>Considered a new REST route; it rides the socket.</architecture-note>\n" +
      "<architecture>sound</architecture>";
    assert.equal(architectureNote(out), "Considered a new REST route; it rides the socket.");
  });

  it("takes the last note when the output quotes an earlier one", () => {
    const out =
      "Write <architecture-note>…</architecture-note> before the verdict.\n" +
      "<architecture-note>No shape question: test-only diff.</architecture-note>\n" +
      "<architecture>sound</architecture>";
    assert.equal(architectureNote(out), "No shape question: test-only diff.");
  });

  it("reports an empty string when the tag is missing", () => {
    assert.equal(architectureNote("<architecture>sound</architecture>"), "");
  });

  it("trims whitespace", () => {
    assert.equal(architectureNote("<architecture-note>\n  Weighed a new table.  \n</architecture-note>"), "Weighed a new table.");
  });
});

describe("reviewOutcome", () => {
  it("carries the note on a sound verdict", () => {
    const out =
      "<architecture-note>Weighed a new table; the existing one covers it.</architecture-note>\n" +
      "<architecture>sound</architecture>";
    assert.deepEqual(reviewOutcome(out), {
      outcome: "done",
      note: "Weighed a new table; the existing one covers it.",
      blocked: false,
    });
  });

  it("leaves the note empty on a sound verdict without one", () => {
    assert.deepEqual(reviewOutcome("<architecture>sound</architecture>"), {
      outcome: "done",
      note: undefined,
      blocked: false,
    });
  });

  it("keeps the blocked note", () => {
    const out = "<architecture-note>ignored</architecture-note>\n<architecture>blocked</architecture>";
    assert.deepEqual(reviewOutcome(out), {
      outcome: "blocked",
      note: "reviewer blocked the architecture",
      blocked: true,
    });
  });

  it("keeps the missing-verdict note", () => {
    assert.deepEqual(reviewOutcome("<architecture-note>stray</architecture-note>"), {
      outcome: "done",
      note: "reviewer gave no architecture verdict; treated as sound",
      blocked: false,
    });
  });
});

describe("needsHumanReason", () => {
  it("reads the last tag on one line", () => {
    const out =
      "I end with <needs-human>a quoted example</needs-human> only when stuck.\n" +
      "<needs-human>pick the cache policy:\n  absolute or none</needs-human>\n<promise>NEEDS-HUMAN</promise>";
    assert.equal(needsHumanReason(out), "pick the cache policy: absolute or none");
  });

  it("is empty without a tag", () => {
    assert.equal(needsHumanReason("<promise>NEEDS-HUMAN</promise>"), "");
  });
});
