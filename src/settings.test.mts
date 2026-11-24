// The settings window, its forms and the first-run wizard.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { z } from "zod";
import { parseConfig, ROLES } from "./config.mts";
import { fieldsOf } from "./fields.mts";
import { agents, plugins, sandboxes, sources } from "./modules.mts";
import { dropsOf, editConfig, kindHelp, pluginSchema, roleFormSchema, roleHelp } from "./sections.mts";
import { runInit } from "./init.mts";
import { Form } from "./form.tsx";
import { SettingsWindow } from "./settings.tsx";
import { Wizard } from "./wizard.tsx";

const DOWN = "\u001B[B";
const ESC = "\u001B";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const press = async (stdin: { write: (s: string) => void }, ...keys: string[]) => {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
};
const typed = (text: string) => [...text];

const schema = z.object({
  name: z.string().trim().min(1),
  count: z.number().int().min(1).default(3),
  on: z.boolean(),
  mode: z.enum(["fast", "slow"]),
  extra: z.string().optional().meta({ dependsOn: "on" }),
  dirs: z.array(z.string()),
  sizes: z.array(z.number()),
});

const tmpRepo = () => mkdtempSync(join(tmpdir(), "castle-keep-settings-"));
const initIn = async (cwd: string, source: string, ...more: string[]) => {
  const code = await runInit(["--source", source, "--gate", "npm test", ...more], { cwd, tty: false, out: () => {}, err: () => {} });
  assert.equal(code, 0);
  return join(cwd, ".sandcastle/config.json");
};

describe("Form", () => {
  const mount = (onSave = (_: Record<string, unknown>) => undefined as string | undefined | void) =>
    render(createElement(Form, { title: "t", schema, value: { name: "a", dirs: ["x"], sizes: [1] }, onSave, onCancel: () => {} }));

  it("renders a field per schema entry, a default, and a read-only field with a hint", async () => {
    const app = mount();
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /name: a/);
    assert.match(frame, /count: 3/);
    assert.match(frame, /on: false/);
    assert.match(frame, /mode: fast/);
    assert.match(frame, /dirs: x +│/);
    assert.match(frame, /sizes: \[1\]  \(edit the file\)/);
    assert.doesNotMatch(frame, /extra/);
    app.unmount();
  });

  it("shows a dependent setting only while its switch is on", async () => {
    const app = mount();
    await press(app.stdin, DOWN, DOWN, ENTER);
    assert.match(app.lastFrame() ?? "", /on: true/);
    assert.match(app.lastFrame() ?? "", /extra: \(not set\)/);
    app.unmount();
  });

  it("shows the schema error of an invalid value and does not save it", async () => {
    const saved: unknown[] = [];
    const app = mount((v) => void saved.push(v));
    // count: edit, drop the "3", type 0, end the edit, go to Save.
    await press(app.stdin, DOWN, ENTER, BACKSPACE, "0", ENTER, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /count: 0/);
    assert.match(frame, /Too small/i);
    assert.match(frame, /not saved/);
    assert.deepEqual(saved, []);
    app.unmount();
  });

  it("hands a valid value to onSave", async () => {
    const saved: Record<string, unknown>[] = [];
    const app = mount((v) => void saved.push(v));
    await press(app.stdin, DOWN, ENTER, BACKSPACE, "7", ENTER, DOWN, DOWN, DOWN, ENTER, ...typed(", y ,,z"), ENTER, DOWN, DOWN, ENTER);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.count, 7);
    assert.deepEqual(saved[0]!.dirs, ["x", "y", "z"]);
    assert.deepEqual(saved[0]!.sizes, [1]);
    app.unmount();
  });
});

describe("Form, editing a text field", () => {
  const notes = z.object({ note: z.string().optional().describe("A free note."), size: z.number().optional() });
  const mountNotes = () => render(createElement(Form, { title: "t", schema: notes, value: {}, onSave: () => {}, onCancel: () => {} }));
  const row = (frame: string, name: string) => frame.split("\n").find((line) => line.includes(`${name}:`)) ?? "";

  it("edits the real value, never the placeholder, and shows the placeholder again after the edit", async () => {
    const app = mountNotes();
    assert.match(row(app.lastFrame() ?? "", "note"), /note: \(not set\)/);
    await press(app.stdin, ENTER);
    assert.doesNotMatch(row(app.lastFrame() ?? "", "note"), /not set/);
    assert.match(row(app.lastFrame() ?? "", "note"), /note: ▏/);
    await press(app.stdin, ...typed("ab"), BACKSPACE);
    assert.match(row(app.lastFrame() ?? "", "note"), /note: a▏/);
    await press(app.stdin, BACKSPACE, ESC);
    assert.match(row(app.lastFrame() ?? "", "note"), /note: \(not set\)/);
    // a number field follows the same rule.
    await press(app.stdin, DOWN, ENTER);
    assert.match(row(app.lastFrame() ?? "", "size"), /size: ▏/);
    await press(app.stdin, ENTER);
    assert.match(row(app.lastFrame() ?? "", "size"), /size: \(not set\)/);
    app.unmount();
  });

  it("shows the description of the field under the cursor, and no line for a field without one", async () => {
    const help = z.object({ first: z.string().describe("Help of the first."), second: z.boolean().default(false).describe("Help of the second."), bare: z.string().optional() });
    const app = render(createElement(Form, { title: "t", schema: help, value: {}, onSave: () => {}, onCancel: () => {} }));
    assert.match(app.lastFrame() ?? "", /Help of the first\./);
    await press(app.stdin, DOWN);
    assert.match(app.lastFrame() ?? "", /Help of the second\./);
    assert.doesNotMatch(app.lastFrame() ?? "", /Help of the first/);
    await press(app.stdin, DOWN);
    assert.doesNotMatch(app.lastFrame() ?? "", /Help of/);
    app.unmount();
  });
});

describe("the help of every bundled module", () => {
  it("describes each module, each of its settings, the role fields, the plugin switch and the menu rows", () => {
    const missing: string[] = [];
    const registries = { source: sources, sandbox: sandboxes, agent: agents, plugin: plugins } as Record<string, Record<string, { settings: z.ZodType }>>;
    for (const [kind, registry] of Object.entries(registries)) {
      for (const [name, entry] of Object.entries(registry)) {
        if (!entry.settings.description) missing.push(`${kind} ${name}`);
        if (!(entry.settings instanceof z.ZodObject)) continue;
        for (const field of fieldsOf(entry.settings)) if (!field.description) missing.push(`${kind} ${name}.${field.name}`);
      }
    }
    for (const name of Object.keys(plugins)) for (const field of fieldsOf(pluginSchema(name))) if (!field.description) missing.push(`plugin form ${name}.${field.name}`);
    for (const field of fieldsOf(roleFormSchema)) if (!field.description) missing.push(`role.${field.name}`);
    for (const role of ROLES) if (!roleHelp(role)) missing.push(`menu role ${role}`);
    for (const kind of ["source", "sandbox"] as const) if (!kindHelp(kind)) missing.push(`menu ${kind}`);
    assert.deepEqual(missing, []);
  });
});

describe("dropsOf", () => {
  it("lists the settings with a value, 0 and false included, but not an empty list", () => {
    const config = { sandbox: { module: "docker", mounts: [], cpus: 0, network: ["agents"], imageName: "" } };
    assert.deepEqual(dropsOf(config, "sandbox", { module: "no-sandbox" }), ["setting cpus: 0", 'setting network: ["agents"]']);
    assert.deepEqual(dropsOf(config, "sandbox", { module: "docker" }), []);
  });
});

describe("SettingsWindow", () => {
  it("names the source the task tracker, with a help line for the row under the cursor", async () => {
    const file = await initIn(tmpRepo(), "local_md");
    const app = render(createElement(SettingsWindow, { file, onClose: () => {} }));
    assert.match(app.lastFrame() ?? "", /› task tracker: local_md/);
    assert.match(app.lastFrame() ?? "", new RegExp(kindHelp("source")!.slice(0, 30)));
    await press(app.stdin, DOWN);
    assert.match(app.lastFrame() ?? "", new RegExp(kindHelp("sandbox")!.slice(0, 30)));
    await press(app.stdin, "k", ENTER);
    assert.match(app.lastFrame() ?? "", /task tracker \(now local_md\)/);
    app.unmount();
  });

  it("asks before a tracker change that drops settings and plugins; back writes nothing, change writes", async () => {
    const file = await initIn(tmpRepo(), "github");
    assert.equal(editConfig(file, (c) => {
      c.source.repo = "someone/project";
      c.plugins = [...(c.plugins ?? []), { module: "github-pr" }];
    }), undefined);
    const before = readFileSync(file, "utf8");
    const app = render(createElement(SettingsWindow, { file, onClose: () => {} }));
    // task tracker, then beads (the first, no settings).
    await press(app.stdin, ENTER, ENTER);
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /Change the task tracker to beads/);
    assert.match(frame, /setting repo: someone\/project/);
    assert.match(frame, /plugin github-pr/);
    await press(app.stdin, "n");
    assert.equal(readFileSync(file, "utf8"), before);
    assert.match(app.lastFrame() ?? "", /task tracker: github/);
    await press(app.stdin, ENTER, ENTER, "y");
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(after.source, { module: "beads" });
    assert.ok(!after.plugins.some((p: { module: string }) => p.module === "github-pr"));
    app.unmount();
  });

  it("writes a change that drops nothing at once", async () => {
    const file = await initIn(tmpRepo(), "local_md");
    const app = render(createElement(SettingsWindow, { file, onClose: () => {} }));
    // sandbox: no-sandbox has no settings; pick docker, Save its form as it stands.
    await press(app.stdin, DOWN, ENTER, DOWN, ENTER);
    assert.match(app.lastFrame() ?? "", /sandbox: docker/);
    await press(app.stdin, ...Array(9).fill(DOWN), ENTER);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sandbox, { module: "docker" });
    assert.match(app.lastFrame() ?? "", /saved/);
    app.unmount();
  });

  it("offers every sandbox of Sandcastle", async () => {
    const file = await initIn(tmpRepo(), "local_md");
    const app = render(createElement(SettingsWindow, { file, onClose: () => {} }));
    await press(app.stdin, DOWN, ENTER);
    for (const name of ["no-sandbox", "docker", "podman", "vercel", "daytona"]) assert.match(app.lastFrame() ?? "", new RegExp(`[ ›] ${name}\\b`));
    app.unmount();
  });

  it("writes a saved change to the config file", async () => {
    const file = await initIn(tmpRepo(), "local_md");
    const app = render(createElement(SettingsWindow, { file, onClose: () => {} }));
    // menu: source, sandbox, planner, implementer, ...
    await press(app.stdin, DOWN, DOWN, ENTER);
    assert.match(app.lastFrame() ?? "", /role: planner/);
    // fields: agent, model, effort, Save. Edit the model.
    await press(app.stdin, DOWN, ENTER, ...Array(40).fill(BACKSPACE), ...typed("claude-sonnet-5-5"), ENTER, DOWN, DOWN, ENTER);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).roles.planner.model, "claude-sonnet-5-5");
    app.unmount();
  });

  it("hides a plugin that needs the github source under beads and shows it under github", async () => {
    const beads = await initIn(tmpRepo(), "beads");
    const github = await initIn(tmpRepo(), "github");
    const under = (file: string) => {
      const app = render(createElement(SettingsWindow, { file, onClose: () => {} }));
      const frame = app.lastFrame() ?? "";
      app.unmount();
      return frame;
    };
    assert.doesNotMatch(under(beads), /plugin github-pr/);
    assert.match(under(github), /plugin github-pr: off/);
    assert.match(under(beads), /plugin claude-limits/);
  });
});

describe("Wizard", () => {
  it("writes the same config as init with the same choices", async () => {
    const viaInit = tmpRepo();
    await initIn(viaInit, "local_md", "--hook", "sandbox.worktreeBuildup=npm ci");

    const viaWizard = tmpRepo();
    let written: boolean | undefined;
    const app = render(createElement(Wizard, { cwd: viaWizard, onDone: (ok: boolean) => (written = ok) }));
    assert.match(app.lastFrame() ?? "", /task tracker/);
    // source: beads, github, local_md; then its dir form (Save is the second row).
    await press(app.stdin, DOWN, DOWN, ENTER, DOWN, ENTER);
    // sandbox: no settings, picked at once.
    await press(app.stdin, ENTER);
    // four roles, each accepted as it stands: agent, model, effort, Save.
    for (let i = 0; i < 4; i++) await press(app.stdin, DOWN, DOWN, DOWN, ENTER);
    // one gate.
    await press(app.stdin, ENTER, ...typed("npm test"), ENTER, DOWN, ENTER);
    assert.match(app.lastFrame() ?? "", /Goes on with these checks/);
    await press(app.stdin, DOWN);
    assert.match(app.lastFrame() ?? "", /Asks one more command/);
    await press(app.stdin, "k", ENTER);
    // the command that prepares each worktree.
    assert.match(app.lastFrame() ?? "", /prepare each worktree/);
    await press(app.stdin, ENTER, ...typed("npm ci"), ENTER, DOWN, ENTER);
    // plugins under local_md: each form, Save with the switch off (enabled is its first row).
    for (let i = 0; i < 4 && written === undefined; i++) {
      if (!/plugin:/.test(app.lastFrame() ?? "")) break;
      await press(app.stdin, DOWN, ENTER);
    }
    assert.match(app.lastFrame() ?? "", /Copies the generic prompts/);
    await press(app.stdin, ENTER);
    if (written !== true) console.log(app.lastFrame());
    assert.equal(written, true);
    // The wizard writes the settings it asked, init leaves the defaults to the resolver: compare what resolves.
    const read = (cwd: string) => {
      const parsed = parseConfig(readFileSync(join(cwd, ".sandcastle/config.json"), "utf8"));
      return { ...parsed.file, source: { module: parsed.source.module, ...(parsed.source.settings as object) } };
    };
    assert.deepEqual(read(viaWizard), read(viaInit));
    assert.equal(readFileSync(join(viaWizard, ".sandcastle/plan-prompt.md"), "utf8"), readFileSync(join(viaInit, ".sandcastle/plan-prompt.md"), "utf8"));
    app.unmount();
  });
});
