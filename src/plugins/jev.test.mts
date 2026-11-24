import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EASY_QUESTION, EASY_THRESHOLD, assignTiers, jevPilot, pickTier, pilotOn } from "./jev.mts";

const STRONG = "strong";
const CHEAP = "cheap";

describe("pickTier", () => {
  it("picks the cheap model at and above the threshold of P(yes), 0.9 by default", () => {
    assert.equal(EASY_THRESHOLD, 0.9);
    assert.equal(pickTier(EASY_THRESHOLD, STRONG, CHEAP).model, CHEAP);
    assert.equal(pickTier(0.97, STRONG, CHEAP).model, CHEAP);
  });

  it("keeps the strong model below the threshold", () => {
    assert.equal(pickTier(0.89, STRONG, CHEAP).model, STRONG);
    assert.equal(pickTier(0.1, STRONG, CHEAP).model, STRONG);
  });

  it("keeps the strong model without a usable answer", () => {
    assert.equal(pickTier(undefined, STRONG, CHEAP).model, STRONG);
    assert.equal(pickTier(Number.NaN, STRONG, CHEAP).model, STRONG);
  });
});

describe("assignTiers", () => {
  const issues = [
    { id: "1", title: "small", body: "" },
    { id: "2", title: "big", body: "" },
    { id: "3", title: "broken", body: "" },
  ];

  it("routes each issue by its own answer and survives a failed question", async () => {
    const tiers = await assignTiers(issues, {
      strongModel: STRONG,
      cheapModel: CHEAP,
      ask: async (issue) => {
        if (issue.id === "3") throw new Error("HTTP 500");
        return issue.id === "1" ? 0.95 : 0.6;
      },
    });

    assert.equal(tiers.get("1")?.model, CHEAP);
    assert.equal(tiers.get("2")?.model, STRONG);
    assert.equal(tiers.get("3")?.model, STRONG);
    assert.match(tiers.get("3")?.note ?? "", /Jev failed: HTTP 500/);
  });
});

describe("pilotOn", () => {
  it("is off without a cheap model or with the same model", () => {
    assert.equal(pilotOn("i", null), false);
    assert.equal(pilotOn("i", "i"), false);
    assert.equal(pilotOn("i", "c"), true);
  });
});

describe("jevPilot", () => {
  const start = (role: "implementer" | "reviewer") => ({
    role,
    agent: "claude-code",
    task: { id: "7", title: "small", body: "" },
    proposed: { model: "strong", idleTimeout: 1, env: {} },
    notice: () => {},
  });

  it("changes the implementer model of an easy issue and adds a row note", async () => {
    const plugin = jevPilot({ project: "a project", cheapModel: "cheap", ask: async () => 0.93 });
    const changes = await plugin.preStart!(start("implementer"));
    assert.equal(changes?.model, "cheap");
    assert.equal(changes?.note, "P(easy) 0.93");
  });

  it("keeps the strong model of a hard issue and follows the threshold setting", async () => {
    const hard = jevPilot({ cheapModel: "cheap", ask: async () => 0.6 });
    assert.equal((await hard.preStart!(start("implementer")))?.model, "strong");
    const lenient = jevPilot({ cheapModel: "cheap", easyThreshold: 0.5, ask: async () => 0.6 });
    assert.equal((await lenient.preStart!(start("implementer")))?.model, "cheap");
  });

  it("leaves the other roles alone", async () => {
    const asked: number[] = [];
    const plugin = jevPilot({ cheapModel: "cheap", ask: async () => (asked.push(1), 1) });
    assert.equal(await plugin.preStart!(start("reviewer")), undefined);
    assert.equal(asked.length, 0);
  });

  it("has no hook without a cheap model: it never runs and writes no note", () => {
    assert.deepEqual(Object.keys(jevPilot({})), ["name"]);
    assert.deepEqual(Object.keys(jevPilot({ cheapModel: null })), ["name"]);
  });

  it("asks nothing and changes nothing when the implementer already runs on the cheap model", async () => {
    const asked: number[] = [];
    const same = jevPilot({ cheapModel: "strong", ask: async () => (asked.push(1), 1) });
    assert.equal(await same.preStart!(start("implementer")), undefined);
    assert.equal(asked.length, 0);
  });
});

describe("the question to Jev", () => {
  const issue = { id: "9", title: "small", body: "fix a typo" };
  const withJev = async (answer: unknown, project?: string) => {
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    const realKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    try {
      const tiers = await assignTiers([issue], { strongModel: STRONG, cheapModel: CHEAP, project });
      return { tier: tiers.get("9")!, sent };
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = realKey;
    }
  };

  it("asks the yes/no question with the project in front and reads P(yes)", async () => {
    const { tier, sent } = await withJev({ answers: { easy: { probabilities: { yes: 0.95, no: 0.05 } } } }, "A web shop.");
    const [question] = Object.values(sent[0].questions) as any[];
    assert.equal(question.type, "choice");
    assert.equal(question.instructions, `A web shop. ${EASY_QUESTION}`);
    assert.deepEqual(Object.keys(question.criteria), ["yes", "no"]);
    assert.equal(tier.model, CHEAP);
    assert.equal(tier.note, "P(easy) 0.95");
  });

  it("asks the bare question without a project, and keeps the strong model on an odd answer", async () => {
    const { tier, sent } = await withJev({ answers: { easy: { probabilities: { hard: 0.1 } } } });
    const [question] = Object.values(sent[0].questions) as any[];
    assert.equal(question.instructions, EASY_QUESTION);
    assert.equal(tier.model, STRONG);
    assert.match(tier.note, /Jev failed: answer has no P\(yes\)/);
  });
});
