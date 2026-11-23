/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The settings window: the modules of the config file, each a form drawn from its `zod` schema.
// A save writes the config file; the loop reads it at the next iteration.

import { readFileSync } from "node:fs";
import { Box, Text } from "ink";
import { useState } from "react";
import { ROLES } from "./config.mts";
import { Confirm, Form, Select } from "./form.tsx";
import {
  dropMismatched,
  dropsOf,
  editConfig,
  KIND_LABEL,
  kindHelp,
  moduleHelp,
  moduleNames,
  pluginHelp,
  pluginSchema,
  roleFormSchema,
  roleHelp,
  setPlugin,
  settingsSchema,
  visiblePlugins,
  type Kind,
} from "./sections.mts";
import type { ModuleChoice } from "./setup.mts";

/** Picks a module of a kind, then asks its settings when it has any. */
export function ModuleEditor({
  kind,
  current,
  onDone,
  onCancel,
  active = true,
}: {
  kind: Kind;
  current?: ModuleChoice;
  onDone: (choice: ModuleChoice) => string | undefined | void;
  onCancel?: () => void;
  active?: boolean;
}) {
  const [module, setModule] = useState<string | undefined>();
  if (!module) {
    return (
      <Select
        title={`${KIND_LABEL[kind]}${current ? ` (now ${current.module})` : ""}`}
        options={moduleNames(kind)}
        describe={(name) => moduleHelp(kind, name)}
        active={active}
        onCancel={onCancel}
        onPick={(picked) => {
          const schema = settingsSchema(kind, picked);
          if (!schema || Object.keys(schema.shape).length === 0) onDone({ module: picked });
          else setModule(picked);
        }}
      />
    );
  }
  const { module: _, ...settings } = current?.module === module ? current : { module };
  return (
    <Form
      title={`${KIND_LABEL[kind]}: ${module}`}
      schema={settingsSchema(kind, module)!}
      value={settings}
      active={active}
      onCancel={() => setModule(undefined)}
      onSave={(value) => onDone({ module, ...value })}
    />
  );
}

type Screen =
  | { kind: "menu" }
  | { kind: Kind }
  | { kind: "role"; role: (typeof ROLES)[number] }
  | { kind: "plugin"; name: string };

export function SettingsWindow({ file, onClose, active = true }: { file: string; onClose: () => void; active?: boolean }) {
  const [screen, setScreen] = useState<Screen>({ kind: "menu" });
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, setPending] = useState<{ kind: Kind; choice: ModuleChoice; drops: string[] } | undefined>();
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return <Text color="red">{`cannot read ${file}: ${(error as Error).message}`}</Text>;
  }
  const back = () => setScreen({ kind: "menu" });
  const done = (problem: string | undefined) => {
    setNotice(problem ? `not saved: ${problem}` : "saved");
    if (!problem) back();
    return problem;
  };

  const write = (kind: Kind, choice: ModuleChoice) =>
    done(
      editConfig(file, (c) => {
        c[kind] = choice;
        dropMismatched(c);
      }),
    );

  if (pending) {
    return (
      <Confirm
        title={`Change the ${KIND_LABEL[pending.kind]} to ${pending.choice.module}? This drops:`}
        lines={pending.drops}
        active={active}
        onYes={() => {
          setPending(undefined);
          write(pending.kind, pending.choice);
        }}
        onNo={() => {
          setPending(undefined);
          setNotice("not changed");
          back();
        }}
      />
    );
  }
  if (screen.kind === "source" || screen.kind === "sandbox") {
    const kind = screen.kind;
    return (
      <ModuleEditor
        kind={kind}
        current={config[kind]}
        active={active}
        onCancel={back}
        onDone={(choice) => {
          const drops = dropsOf(config, kind, choice);
          if (drops.length === 0) return write(kind, choice);
          setPending({ kind, choice, drops });
        }}
      />
    );
  }
  if (screen.kind === "role") {
    const role = screen.role;
    return (
      <Form
        title={`role: ${role}`}
        schema={roleFormSchema}
        value={config.roles?.[role] ?? {}}
        active={active}
        onCancel={back}
        onSave={(value) => done(editConfig(file, (c) => void (c.roles = { ...c.roles, [role]: value })))}
      />
    );
  }
  if (screen.kind === "plugin") {
    const name = screen.name;
    const entry = (config.plugins ?? []).find((p: { module: string }) => p.module === name);
    const { module: _, ...settings } = entry ?? {};
    return (
      <Form
        title={`plugin: ${name}`}
        schema={pluginSchema(name)}
        value={{ enabled: Boolean(entry), ...settings }}
        active={active}
        onCancel={back}
        onSave={({ enabled, ...rest }) => done(editConfig(file, (c) => setPlugin(c, name, enabled ? rest : undefined)))}
      />
    );
  }

  const plugins = visiblePlugins(config.source?.module);
  const items: [string, Screen, string | undefined][] = [
    [`${KIND_LABEL.source}: ${config.source?.module}`, { kind: "source" }, kindHelp("source")],
    [`${KIND_LABEL.sandbox}: ${config.sandbox?.module}`, { kind: "sandbox" }, kindHelp("sandbox")],
    ...ROLES.map((role): [string, Screen, string | undefined] => [`role ${role}: ${config.roles?.[role]?.model ?? ""}`, { kind: "role", role }, roleHelp(role)]),
    ...plugins.map((name): [string, Screen, string | undefined] => [
      `plugin ${name}: ${(config.plugins ?? []).some((p: { module: string }) => p.module === name) ? "on" : "off"}`,
      { kind: "plugin", name },
      pluginHelp(name),
    ]),
  ];
  return (
    <Box flexDirection="column">
      <Select
        title={`Settings (${file})`}
        options={[...items.map(([label]) => label), "close"]}
        describe={(label) => items.find(([l]) => l === label)?.[2] ?? (label === "close" ? "Closes the window; the loop reads the file at its next iteration." : undefined)}
        active={active}
        onCancel={onClose}
        onPick={(label) => {
          const item = items.find(([l]) => l === label);
          if (item) setScreen(item[1]);
          else onClose();
        }}
      />
      {notice ? <Text color={notice.startsWith("not") ? "red" : "green"}>{notice}</Text> : null}
    </Box>
  );
}
