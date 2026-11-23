import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PreStartInput } from "../plugin.mts";
import { graftPlugin, guard } from "./graft.mts";

const DIRS = ["packages", "lib"];

const bash = (command: string) => guard({ tool_name: "Bash", tool_input: { command } }, DIRS);

describe("guard", () => {
  // Commands the agents ran in real runs.
  it("denies a search of the source", () => {
    for (const command of [
      'grep -rn "invoice::" packages/ --include=*.rs | grep -v "^packages/core/src/billing/invoice"',
      'grep -n "Invoice" packages/core/src/store/*.rs | head -20',
      'grep -n "pub struct PaymentPlan" -A40 packages/core/src/orders/*.rs',
      "sed -n 1,20p x.rs; grep -n route packages/core/src/billing/mod.rs",
      "rg -n Ledger",
      'grep -rn "Ledger::" .',
      "git grep -n INVOICE_LINES",
      "find packages -name '*.rs' | xargs grep -l Invoice",
      "cd packages && rg Invoice core/src/billing/invoice.rs",
    ]) {
      assert.notEqual(bash(command), undefined, command);
    }
  });

  it("lets text that is not source pass", () => {
    for (const command of [
      'npm run build 2>&1 | grep -E "^(error|warning)" -A8 | head -60',
      'gh issue view 226 --comments | grep -n "line"',
      "grep -n Invoice docs/design.md GLOSSARY.md",
      "grep -rn invoice docs/",
      'git log --oneline | grep -i "invoice"',
      'graft grep "Ledger::"',
      "sed -n 240,340p packages/core/src/billing/mod.rs",
    ]) {
      assert.equal(bash(command), undefined, command);
    }
  });

  it("lets a search past a graft miss run", () => {
    assert.equal(bash('rg -n "Invoice\\b" packages/ # graft-miss: a regex over identifiers'), undefined);
  });

  it("denies the Grep tool over the source and lets it read docs", () => {
    const grep = (tool_input: object) => guard({ cwd: "/repo", tool_name: "Grep", tool_input }, DIRS);
    assert.notEqual(grep({ pattern: "Invoice" }), undefined);
    assert.notEqual(grep({ pattern: "Invoice", path: "/repo/packages/core" }), undefined);
    assert.notEqual(grep({ pattern: "Invoice", path: "/repo", type: "rust" }), undefined);
    assert.equal(grep({ pattern: "Invoice", path: "/repo/docs" }), undefined);
  });

  it("ignores other tools", () => {
    assert.equal(guard({ tool_name: "Read", tool_input: { path: "packages/x.rs" } }, DIRS), undefined);
  });
});

describe("plugin", () => {
  const start = (agent: string, notices: string[] = []) =>
    ({ role: "implementer", agent, proposed: { model: "m", idleTimeout: 1, env: {} }, notice: (text: string) => notices.push(text) }) as PreStartInput;

  it("adds a PreToolUse hook that names its source directories to claude-code", async () => {
    const changes = await graftPlugin({ sourceDirs: DIRS }).preStart!(start("claude-code"));
    const hook = JSON.stringify(changes?.claudeCode);
    assert.match(hook, /PreToolUse/);
    assert.match(hook, /packages,lib/);
  });

  it("logs one warning and adds nothing for another agent", async () => {
    const notices: string[] = [];
    const plugin = graftPlugin({ sourceDirs: DIRS });
    assert.equal(await plugin.preStart!(start("other", notices)), undefined);
    assert.equal(await plugin.preStart!(start("other", notices)), undefined);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /graft/);
  });
});
