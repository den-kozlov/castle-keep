/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The widgets of the settings window and the wizard: a form drawn from a `zod` object
// schema (./fields.mts) and a list to pick from.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { z } from "zod";
import { draftOf, fieldsOf, parseDraft, visibleFields, type Draft, type Field } from "./fields.mts";

export interface FormProps {
  title: string;
  schema: z.ZodObject;
  value: Record<string, unknown>;
  /** Called with the parsed value. Returns a problem to show (the file refused it), or nothing when saved. */
  onSave: (value: Record<string, unknown>) => string | undefined | void;
  onCancel: () => void;
  saveLabel?: string;
  /** Receives the keys while true; a screen above the form turns it off. */
  active?: boolean;
}

const shown = (field: Field, raw: unknown, editing: boolean) => {
  if (field.kind === "readonly") return `${JSON.stringify(raw) ?? "(none)"}  (edit the file)`;
  const text = String(raw ?? "");
  if (editing) return `${text}▏`;
  return text === "" ? (field.optional ? "(not set)" : "") : text;
};

/** The gray line under a form or a list: the help of the row under the cursor, nothing when it has none. */
const Help = ({ text }: { text?: string }) => (text ? <Text dimColor>{text}</Text> : null);

export function Form({ title, schema, value, onSave, onCancel, saveLabel = "Save", active = true }: FormProps) {
  const fields = fieldsOf(schema);
  const [draft, setDraft] = useState<Draft>(() => draftOf(schema, value));
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | undefined>();

  const rows = visibleFields(fields, draft);
  const at = Math.min(cursor, rows.length);
  const field = rows[at];

  const set = (name: string, next: string) => {
    setDraft((d) => ({ ...d, [name]: next }));
    setErrors((e) => ({ ...e, [name]: "" }));
    setMessage(undefined);
  };
  const cycle = (f: Field, delta: number) => {
    const choices = f.kind === "boolean" ? ["false", "true"] : f.optional ? ["", ...f.options] : f.options;
    const current = Math.max(0, choices.indexOf(String(draft[f.name] ?? "")));
    set(f.name, choices[(current + delta + choices.length) % choices.length] ?? "");
  };
  const save = () => {
    const parsed = parseDraft(schema, draft);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setMessage("not saved: fix the marked fields");
      return;
    }
    setErrors({});
    const problem = onSave(parsed.value);
    setMessage(problem ? `not saved: ${problem}` : "saved");
  };

  useInput(
    (input, key) => {
      if (editing && field) {
        const text = String(draft[field.name] ?? "");
        if (key.return || key.escape) setEditing(false);
        else if (key.backspace || key.delete) set(field.name, text.slice(0, -1));
        else if (input && !key.ctrl && !key.meta) set(field.name, text + input);
        return;
      }
      if (key.escape) onCancel();
      else if (key.upArrow || input === "k") setCursor(Math.max(0, at - 1));
      else if (key.downArrow || input === "j") setCursor(Math.min(rows.length, at + 1));
      else if (!field) {
        if (key.return) save();
      } else if (field.kind === "boolean" || field.kind === "enum") {
        if (key.return || input === " " || key.rightArrow) cycle(field, 1);
        else if (key.leftArrow) cycle(field, -1);
      } else if (field.kind === "readonly") {
        if (key.return) setMessage(`${field.name}: edit the config file`);
      } else if (key.return) setEditing(true);
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      {rows.map((f, i) => (
        <Box key={f.name} flexDirection="column">
          <Text color={f.kind === "readonly" ? "gray" : undefined} inverse={i === at}>
            {`${i === at ? "›" : " "} ${f.name}: ${shown(f, draft[f.name], editing && i === at)}`}
          </Text>
          {errors[f.name] ? <Text color="red">{`    ${errors[f.name]}`}</Text> : null}
        </Box>
      ))}
      <Text inverse={at === rows.length}>{`${at === rows.length ? "›" : " "} [ ${saveLabel} ]`}</Text>
      <Help text={field?.description} />
      {message ? <Text color={message.startsWith("not") ? "red" : "green"}>{message}</Text> : null}
      <Text dimColor>↑↓ move · ⏎ edit/toggle · esc back{editing ? " · ⏎ ends the edit" : ""}</Text>
    </Box>
  );
}

export interface SelectProps {
  title: string;
  options: string[];
  onPick: (option: string) => void;
  onCancel?: () => void;
  active?: boolean;
  /** The help line of an option. */
  describe?: (option: string) => string | undefined;
}

export function Select({ title, options, onPick, onCancel, active = true, describe }: SelectProps) {
  const [cursor, setCursor] = useState(0);
  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(Math.max(0, cursor - 1));
      else if (key.downArrow || input === "j") setCursor(Math.min(options.length - 1, cursor + 1));
      else if (key.return && options[cursor] !== undefined) onPick(options[cursor]);
      else if (key.escape) onCancel?.();
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      {options.map((option, i) => (
        <Text key={option} inverse={i === cursor}>{`${i === cursor ? "›" : " "} ${option}`}</Text>
      ))}
      <Help text={options[cursor] === undefined ? undefined : describe?.(options[cursor])} />
      <Text dimColor>↑↓ move · ⏎ pick{onCancel ? " · esc back" : ""}</Text>
    </Box>
  );
}

export interface ConfirmProps {
  title: string;
  /** What the change drops, one row each. */
  lines: string[];
  onYes: () => void;
  onNo: () => void;
  yesLabel?: string;
  active?: boolean;
}

/** A yes/no screen: y or ⏎ on the first row says yes; n, esc or ⏎ on "Back" says no. */
export function Confirm({ title, lines, onYes, onNo, yesLabel = "Change", active = true }: ConfirmProps) {
  const [cursor, setCursor] = useState(0);
  const choices = [yesLabel, "Back"];
  useInput(
    (input, key) => {
      if (input === "y") onYes();
      else if (input === "n" || key.escape) onNo();
      else if (key.upArrow || input === "k") setCursor(0);
      else if (key.downArrow || input === "j") setCursor(1);
      else if (key.return) (cursor === 0 ? onYes : onNo)();
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      {lines.map((line) => (
        <Text key={line}>{`  - ${line}`}</Text>
      ))}
      {choices.map((choice, i) => (
        <Text key={choice} inverse={i === cursor}>{`${i === cursor ? "›" : " "} [ ${choice} ]`}</Text>
      ))}
      <Text dimColor>y/⏎ {yesLabel.toLowerCase()} · n/esc back</Text>
    </Box>
  );
}
