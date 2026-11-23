import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeCodeAgent, contextTokens } from "./claude-code.mts";

const assistant = (usage: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [], usage } });

describe("contextTokens", () => {
  it("sums the fresh, cached and written tokens of an assistant line", () => {
    const line = assistant({
      input_tokens: 12,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 40_000,
      output_tokens: 500,
    });
    assert.equal(contextTokens(line), 43_012);
  });

  it("ignores every other line", () => {
    assert.equal(contextTokens("Agent started"), undefined);
    assert.equal(contextTokens("{not json"), undefined);
    assert.equal(contextTokens(JSON.stringify({ type: "system", subtype: "init" })), undefined);
    assert.equal(contextTokens(JSON.stringify({ type: "assistant", message: {} })), undefined);
    assert.equal(contextTokens(assistant({ input_tokens: 1 })), undefined);
  });
});

describe("claudeCodeAgent", () => {
  const command = (blocks: Record<string, unknown>[], noSandbox = true) =>
    claudeCodeAgent.provider({ model: "m", noSandbox, env: {}, blocks }).buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: false }).command;

  it("merges the settings fragments of two plugins into one --settings", () => {
    const text = command([
      { claudeCode: { settings: { hooks: { PreToolUse: [{ matcher: "a" }] }, one: 1 } } },
      { claudeCode: { settings: { hooks: { PreToolUse: [{ matcher: "b" }] }, two: 2 } } },
      {},
    ]);
    assert.equal(text.match(/--settings/g)?.length, 1);
    const json = /--settings '(.*?)' /.exec(text)?.[1] ?? "";
    assert.deepEqual(JSON.parse(json), { hooks: { PreToolUse: [{ matcher: "a" }, { matcher: "b" }] }, one: 1, two: 2 });
  });

  it("adds no --settings without a fragment", () => {
    assert.doesNotMatch(command([{}]), /--settings/);
  });

  it("skips permission prompts only without a sandbox", () => {
    assert.match(command([], true), /--dangerously-skip-permissions/);
    assert.doesNotMatch(command([], false), /--dangerously-skip-permissions/);
  });

  it("sets its env on the command, not in the provider env", () => {
    const agent = claudeCodeAgent.provider({ model: "m", noSandbox: true, env: { A: "it's" }, blocks: [] });
    assert.deepEqual(agent.env, {});
    assert.match(agent.buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: false }).command, /^env 'A=it'\\''s' claude /);
  });

  it("reads the context size from a raw stream line", () => {
    const line = assistant({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
    assert.deepEqual(claudeCodeAgent.signals({ type: "raw", line } as never), [{ kind: "context", tokens: 6 }]);
  });
});
