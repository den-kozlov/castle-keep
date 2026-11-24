import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plugin } from "./plugin.mts";
import { carry, parseConfig, resolveHarness } from "./config.mts";
import { sandboxOf, startAgent } from "./engine.mts";

const ROLES = ["planner", "implementer", "reviewer", "merger"] as const;

const harness = () => {
  const parsed = parseConfig(
    JSON.stringify({
      source: { module: "github" },
      sandbox: { module: "no-sandbox" },
      roles: Object.fromEntries(ROLES.map((role) => [role, { agent: "claude-code", model: "m" }])),
      prompts: { plan: "p", implement: "i", review: "r", merge: "m" },
      gates: ["npm test"],
      env: { PATH: "/project/bin:${PATH}", KEEP: "same" },
    }),
  );
  const carried = carry(parsed);
  const plugin: Plugin = {
    name: "env-test",
    preStart: ({ proposed }) => ({ env: { PATH: `/hook/bin:${proposed.env?.PATH}`, HOOK_KEY: "added", KEEP: "same" } }),
  };
  carried.plugins = [plugin];
  return resolveHarness(parsed, carried);
};

describe("the env that reaches each agent after the pre-start hooks", () => {
  for (const role of ROLES) {
    it(`${role}: the changed PATH and the new key reach the command, no key is in both envs`, async () => {
      const h = harness();
      const sandboxEnv = sandboxOf(h).env;
      assert.ok(sandboxEnv.PATH.startsWith("/project/bin:"));
      const { agent } = await startAgent(h, role, () => {}, { id: "1", title: "t", body: "b" });

      // What mergeProviderEnv of Sandcastle 0.12 refuses.
      assert.deepEqual(Object.keys(agent.env).filter((key) => key in sandboxEnv), []);

      const { command } = agent.buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: false });
      assert.ok(command.includes(`'PATH=/hook/bin:${sandboxEnv.PATH}'`), command);
      assert.ok(command.includes("'HOOK_KEY=added'"), command);
      assert.equal(command.split("KEEP=").length - 1, 0, "an equal key is not set again");
    });
  }
});
