/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The first-run wizard: the screens of the settings window in order, then the same
// `writeSetup` as `castle-keep init`.

import { Box, render, Text } from "ink";
import { useState } from "react";
import { z } from "zod";
import { ConfigError, ROLES, type RoleName } from "./config.mts";
import { Form, Select } from "./form.tsx";
import { pluginSchema, roleFormSchema, visiblePlugins } from "./sections.mts";
import { ModuleEditor } from "./settings.tsx";
import { defaultRoles, writeSetup, type ModuleChoice, type SetupChoices } from "./setup.mts";

const gateSchema = z.object({ gate: z.string().trim().min(1).describe("A command the reviewer runs as a check of each branch.") });
const COPY = "copy the generic prompts into .sandcastle/";
const OWN = "I bring my own prompts";
const CONTINUE = "continue";
const ANOTHER = "add another check";
const QUIT = "quit";
const HELP: Record<string, string> = {
  [CONTINUE]: "Goes on to the plugins with these checks.",
  [ANOTHER]: "Asks one more command for the reviewer to run.",
  [COPY]: "Copies the generic prompts and CODING_STANDARDS.md; they are yours to edit after the copy.",
  [OWN]: "Copies nothing: the prompt files the config names must exist before the start.",
  [QUIT]: "Ends the wizard without a config; fix the problem and start again.",
};
const help = (option: string) => HELP[option];

type Step = "source" | "sandbox" | { role: RoleName } | "gate" | "more-gates" | { plugin: string } | "prompts" | "write";

export function Wizard({ cwd, onDone }: { cwd: string; onDone: (written: boolean) => void }) {
  const [step, setStep] = useState<Step>("source");
  const [choices, setChoices] = useState<Partial<SetupChoices>>({ roles: defaultRoles(), gates: [], plugins: [] });
  const [error, setError] = useState<string | undefined>();

  const patch = (change: Partial<SetupChoices>) => setChoices((c) => ({ ...c, ...change }));
  const pluginsLeft = (after?: string) => {
    const names = visiblePlugins(choices.source?.module ?? "");
    return after === undefined ? names : names.slice(names.indexOf(after) + 1);
  };
  const nextPlugin = (after?: string): Step => {
    const [name] = pluginsLeft(after);
    return name ? { plugin: name } : "prompts";
  };

  // A key per step: each screen starts with its own state.
  const key = JSON.stringify(step);
  if (step === "source" || step === "sandbox") {
    return (
      <ModuleEditor
        key={key}
        kind={step}
        onDone={(choice) => {
          patch({ [step]: choice });
          setStep(step === "source" ? "sandbox" : { role: ROLES[0] });
        }}
      />
    );
  }
  if (typeof step === "object" && "role" in step) {
    const role = step.role;
    const next = ROLES[ROLES.indexOf(role) + 1];
    return (
      <Form
        key={key}
        title={`agent of the ${role}`}
        schema={roleFormSchema}
        value={{ ...choices.roles![role] }}
        onCancel={() => {}}
        saveLabel="Next"
        onSave={(value) => {
          patch({ roles: { ...choices.roles!, [role]: value as unknown as SetupChoices["roles"][RoleName] } });
          setStep(next ? { role: next } : "gate");
        }}
      />
    );
  }
  if (step === "gate") {
    return (
      <Form
        key={key}
        title="a check the reviewer runs (a command)"
        schema={gateSchema}
        value={{}}
        onCancel={() => {}}
        saveLabel="Next"
        onSave={({ gate }) => {
          patch({ gates: [...choices.gates!, gate as string] });
          setStep("more-gates");
        }}
      />
    );
  }
  if (step === "more-gates") {
    return (
      <Select
        key={key}
        title={`checks: ${choices.gates!.join(", ")}`}
        options={[CONTINUE, ANOTHER]}
        describe={help}
        onPick={(option) => setStep(option === CONTINUE ? nextPlugin() : "gate")}
      />
    );
  }
  if (typeof step === "object" && "plugin" in step) {
    const name = step.plugin;
    return (
      <Form
        key={key}
        title={`plugin: ${name}`}
        schema={pluginSchema(name)}
        value={{ enabled: false }}
        onCancel={() => setStep(nextPlugin(name))}
        saveLabel="Next"
        onSave={({ enabled, ...rest }) => {
          if (enabled) patch({ plugins: [...choices.plugins!, { module: name, ...rest } as ModuleChoice] });
          setStep(nextPlugin(name));
        }}
      />
    );
  }
  if (step === "prompts") {
    return (
      <Select
        key={key}
        title="prompts of the agents"
        options={[COPY, OWN]}
        describe={help}
        onPick={(option) => {
          const all = { ...choices, copyPrompts: option === COPY } as SetupChoices;
          try {
            const result = writeSetup(cwd, all);
            if (!result.ok) {
              setError(`refusing to overwrite ${result.existing.join(", ")}`);
              setStep("write");
              return;
            }
            onDone(true);
          } catch (e) {
            setError(e instanceof ConfigError ? e.message : String(e));
            setStep("write");
          }
        }}
      />
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="red">{`setup failed: ${error}`}</Text>
      <Select title="setup" options={[QUIT]} describe={help} onPick={() => onDone(false)} />
    </Box>
  );
}

/** Runs the wizard on the terminal. Resolves true when the config was written. */
export async function runWizard(cwd: string): Promise<boolean> {
  let written = false;
  const instance = render(<Wizard cwd={cwd} onDone={(ok) => { written = ok; instance.unmount(); }} />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
  return written;
}
