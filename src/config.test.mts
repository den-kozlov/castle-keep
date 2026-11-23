import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Plugin } from "./plugin.mts";
import { ConfigError, carry, createConfigReader, parseConfig, resolveHarness, type Harness } from "./config.mts";
import { sandboxOf, startAgent } from "./engine.mts";
import { daytonaOptions, vercelOptions } from "./modules.mts";

const base = () => ({
  source: { module: "github" },
  sandbox: { module: "no-sandbox" },
  roles: {
    planner: { agent: "claude-code", model: "p" },
    implementer: { agent: "claude-code", model: "i", effort: "high" },
    reviewer: { agent: "claude-code", model: "r" },
    merger: { agent: "claude-code", model: "m" },
  },
  prompts: { plan: "p", implement: "i", review: "r", merge: "m" },
  gates: ["npm test", "npm run lint"],
});
const resolve = (extra: Record<string, unknown> = {}, cwd = process.cwd()): Harness => {
  const parsed = parseConfig(JSON.stringify({ ...base(), ...extra }));
  return resolveHarness(parsed, carry(parsed), cwd);
};

describe("resolveHarness defaults", () => {
  const h = resolve();

  it("keeps today's values, no idle limit", () => {
    assert.equal(h.baseBranch, "main");
    assert.deepEqual(h.refs, { remote: "origin", mirror: "sandcastle/main", branchPrefix: "sandcastle/issue-" });
    assert.equal(h.parallelism, 3);
    assert.equal(h.commandTimeoutMs, 30 * 60 * 1000);
    assert.ok(h.idleTimeoutSeconds > 30 * 24 * 3600 / 100);
    assert.deepEqual(h.roles.implementer, { agent: "claude-code", model: "i", effort: "high" });
    assert.equal(h.roles.planner.effort, undefined);
  });

  it("lists the gates as markdown and sets the agent environment", () => {
    assert.equal(h.gates, "- `npm test`\n- `npm run lint`");
    assert.deepEqual(Object.keys(h.env).sort(), ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "CLAUDE_CONFIG_DIR"]);
  });

  it("has no agent blocks, gate or hooks without plugins", async () => {
    const plan = await h.preStart({ role: "implementer" }, () => {});
    assert.deepEqual(plan.blocks, []);
    assert.equal(plan.model, "i");
    assert.deepEqual(await h.gate({ step: "poll" }), { open: true });
    assert.deepEqual(h.header(), []);
    assert.deepEqual(h.hooksFor({ task: "1", role: "implementer" }), { sandbox: { onSandboxReady: [] } });
    assert.deepEqual(h.plugins, []);
    await h.listeners.onRunStart();
    assert.equal(h.sandboxModule, "no-sandbox");
    assert.equal(h.agents.planner.id, "claude-code");
  });
});

describe("resolveHarness plugins and env", () => {
  it("builds plugins in order and expands ${NAME} in env", () => {
    const h = resolve({
      env: { X: "${HOME}/x" },
      plugins: [{ module: "orca" }, { module: "jev", project: "c" }, { module: "claude-limits" }],
    });
    assert.deepEqual(h.plugins, ["orca", "jev", "claude-limits"]);
    assert.equal(h.env.X, `${process.env.HOME}/x`);
  });
});

describe("parseConfig validation", () => {
  const fails = (extra: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => parseConfig(JSON.stringify({ ...base(), ...extra })), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, pattern);
      return true;
    });

  it("names the field of a wrong value", () => {
    fails({ parallelism: 0 }, /parallelism/);
    fails({ gates: [] }, /gates/);
    fails({ source: { module: "github", repo: "no-slash" } }, /source\.repo/);
    fails({ roles: { ...base().roles, merger: { agent: "claude-code", model: "m", effort: "huge" } } }, /roles\.merger\.effort/);
    fails({ unknown: 1 }, /unknown/);
  });

  it("names an unknown module", () => {
    fails({ plugins: [{ module: "nope" }] }, /plugins\.0\.module: unknown plugin "nope"/);
    fails({ sandbox: { module: "docker-nope" } }, /sandbox\.module/);
    fails({ roles: { ...base().roles, planner: { agent: "other", model: "p" } } }, /roles\.planner\.agent: unknown agent/);
    fails({ plugins: [{ module: "jev", easyThreshold: 2 }] }, /plugins\.0\.easyThreshold/);
    // The old key bounded P(hard); read as a P(yes) bound it would send most tasks to the cheap model.
    fails({ plugins: [{ module: "jev", threshold: 0.1 }] }, /threshold/);
    fails({ plugins: [{ module: "jev", context: "the old key" }] }, /context/);
  });

  it("refuses a host-only hook under sandbox and under *", () => {
    fails({ hooks: { "sandbox.preflight": ["x.sh"] } }, /hooks\.sandbox\.preflight/);
    fails({ hooks: { "*.afterMerge": ["x.sh"] } }, /hooks\.\*\.afterMerge/);
    fails({ hooks: { "host.periodic": ["x.sh"] } }, /hooks\.host\.periodic\.0: .*interval/);
    fails({ hooks: { "host.nowhen": ["x.sh"] } }, /hooks\.host\.nowhen/);
  });

  it("refuses text that is not JSON", () => {
    assert.throws(() => parseConfig("{"), /not JSON/);
  });
});

describe("the reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "castle-keep-config-"));
  const path = join(dir, "config.json");
  const write = (roles: Record<string, string>) =>
    writeFileSync(
      path,
      JSON.stringify({
        ...base(),
        roles: Object.fromEntries(Object.entries(base().roles).map(([k, v]) => [k, { ...v, model: roles[k] ?? v.model }])),
      }),
    );

  it("refuses a broken first read, naming the field", () => {
    writeFileSync(path, JSON.stringify({ ...base(), parallelism: 0 }));
    const read = createConfigReader(path, dir).read();
    assert.equal(read.ok, false);
    assert.match(read.ok ? "" : read.reason, /parallelism/);
    assert.equal(read.harness, undefined);
  });

  it("follows an edit at the next read and keeps the last good one when the edit is broken", () => {
    const reader = createConfigReader(path, dir);
    write({ implementer: "first" });
    const a = reader.read();
    assert.ok(a.ok);
    assert.equal(a.harness.roles.implementer.model, "first");

    write({ implementer: "second" });
    const b = reader.read();
    assert.ok(b.ok);
    assert.equal(b.harness.roles.implementer.model, "second");

    writeFileSync(path, "{ broken");
    const c = reader.read();
    assert.equal(c.ok, false);
    assert.equal(c.harness?.roles.implementer.model, "second");

    write({ implementer: "third" });
    const d = reader.read();
    assert.ok(d.ok);
    assert.equal(d.harness.roles.implementer.model, "third");
  });
});

describe("the plugin seams of the harness", () => {
  const withPlugins = (plugins: Plugin[]) => {
    const parsed = parseConfig(JSON.stringify(base()));
    const carried = carry(parsed);
    carried.plugins = plugins;
    return resolveHarness(parsed, carried);
  };

  it("refuses a plugin whose required source is not the configured one", () => {
    const parsed = parseConfig(JSON.stringify(base()));
    parsed.plugins = [{ module: "x", settings: {}, build: () => ({ name: "x", requires: { source: "beads" } }) }];
    assert.throws(() => carry(parsed), /plugin x requires the beads source, the config has github/);
    parsed.plugins = [{ module: "x", settings: {}, build: () => ({ name: "x", requires: { source: "github" } }) }];
    assert.doesNotThrow(() => carry(parsed));
  });

  it("merges the pre-start answers of the plugins in order, the later one winning a field", async () => {
    const h = withPlugins([
      { name: "a", preStart: ({ proposed }) => ({ model: "from-a", env: { A: "1" }, claudeCode: { settings: { a: 1 } }, note: proposed.model }) },
      { name: "b", preStart: ({ proposed }) => ({ idleTimeout: 5, env: { B: "2" }, note: `saw ${proposed.model}`, claudeCode: { settings: { b: 2 } } }) },
      { name: "c", preStart: () => undefined },
      { name: "d", preStart: () => { throw new Error("broken"); } },
    ]);
    const notices: string[] = [];
    const plan = await h.preStart({ role: "implementer" }, (text) => notices.push(text));
    assert.equal(plan.model, "from-a");
    assert.equal(plan.effort, "high");
    assert.equal(plan.idleTimeout, 5);
    assert.equal(plan.env.A, "1");
    assert.equal(plan.env.B, "2");
    assert.equal(plan.note, "saw from-a");
    assert.deepEqual(plan.blocks, [{ claudeCode: { settings: { a: 1 } } }, { claudeCode: { settings: { b: 2 } } }]);
    assert.match(notices[0]!, /d pre-start hook failed: Error: broken/);
  });

  it("closes a step when any gate is closed, until the latest time, and counts a throwing gate as closed", async () => {
    const early = new Date(Date.now() + 1_000);
    const late = new Date(Date.now() + 5_000);
    const h = withPlugins([
      { name: "a", gate: { check: () => ({ open: false, reason: "a full", until: early }) } },
      { name: "b", gate: { check: () => ({ open: false, reason: "b full", until: late }) } },
      { name: "c", gate: { check: () => ({ open: true }) } },
    ]);
    assert.deepEqual(await h.gate({ step: "merge" }), { open: false, reason: "a: a full; b: b full", until: late });

    const broken = withPlugins([{ name: "x", gate: { check: () => { throw new Error("no data"); } } }]);
    const answer = await broken.gate({ step: "plan" });
    assert.equal(answer.open, false);
    assert.equal(answer.open ? "" : answer.until, undefined);
  });
});

describe("the sandboxes of Sandcastle 0.12", () => {
  const samples: Record<string, Record<string, unknown>> = {
    "no-sandbox": {},
    docker: {
      imageName: "agent-image",
      containerUid: 1000,
      selinuxLabel: "off",
      mounts: [{ hostPath: "~/.cache", sandboxPath: "~/.cache", readonly: true }],
      network: ["agents"],
      groups: ["docker"],
      devices: ["/dev/fuse"],
      cpus: 2,
    },
    podman: { imageName: "agent-image", userns: "off", network: ["agents"] },
    vercel: { runtime: "node24", vcpus: 2, timeoutMs: 600_000, ports: [3000], snapshotId: "snap", projectId: "p", teamId: "t" },
    daytona: { apiUrl: "https://daytona.example/api", target: "eu", image: "node:24" },
  };

  for (const [module, settings] of Object.entries(samples)) {
    it(`builds ${module} with the agent env, without starting it`, async () => {
      const h = resolve({ sandbox: { module, ...settings } });
      assert.equal(h.sandboxModule, module);
      const provider = sandboxOf(h);
      assert.equal(provider.name, module);
      assert.deepEqual(provider.env, h.env);
      const { agent } = await startAgent(h, "implementer", () => {}, { id: "1", title: "t", body: "b" });
      // Sandcastle 0.12 throws on a key in both provider envs.
      assert.deepEqual(Object.keys(agent.env).filter((key) => key in provider.env), []);
      const command = agent.buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: false }).command;
      assert.equal(command.includes("--dangerously-skip-permissions"), module === "no-sandbox");
    });
  }

  it("hands the host SDK its key from .sandcastle/.env or the environment, and keeps it out of the sandbox env", () => {
    const cwd = process.cwd();
    const saved = { VERCEL_TOKEN: process.env.VERCEL_TOKEN, DAYTONA_API_KEY: process.env.DAYTONA_API_KEY };
    const dir = mkdtempSync(join(tmpdir(), "castle-keep-secrets-"));
    mkdirSync(join(dir, ".sandcastle"));
    writeFileSync(join(dir, ".sandcastle/.env"), "VERCEL_TOKEN=from-file\n");
    try {
      process.chdir(dir);
      delete process.env.VERCEL_TOKEN;
      process.env.DAYTONA_API_KEY = "from-env";
      const env = { A: "1", VERCEL_TOKEN: "leaked", DAYTONA_API_KEY: "leaked" };
      const v = vercelOptions({}, env);
      assert.equal(v.token, "from-file");
      assert.deepEqual(v.env, { A: "1", DAYTONA_API_KEY: "leaked" });
      const d = daytonaOptions({}, env);
      assert.equal(d.apiKey, "from-env");
      assert.deepEqual(d.env, { A: "1", VERCEL_TOKEN: "leaked" });
      const h = resolve({ sandbox: { module: "vercel" }, env: { VERCEL_TOKEN: "leaked" } }, dir);
      assert.equal(sandboxOf(h).env.VERCEL_TOKEN, undefined);
    } finally {
      process.chdir(cwd);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("refuses bad settings and a secret in the file", () => {
    assert.throws(() => resolve({ sandbox: { module: "docker", cpus: 0 } }), /sandbox\.cpus/);
    assert.throws(() => resolve({ sandbox: { module: "podman", userns: "auto" } }), /sandbox\.userns/);
    assert.throws(() => resolve({ sandbox: { module: "vercel", token: "secret" } }), ConfigError);
    assert.throws(() => resolve({ sandbox: { module: "daytona", image: "a", snapshot: "b" } }), /image or snapshot/);
  });
});
