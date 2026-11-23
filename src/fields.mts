// The fields of a `zod` object schema, as a form edits them.
// Strings, numbers, booleans, enums and the optional, defaulted and nullable forms of them are
// editable; any other field type is read-only and keeps its value. A field may carry
// `.meta({ dependsOn: "<boolean field>" })`: it shows only while that switch is on.
// `.describe(...)` on a field, or on any wrapper of it, is the help line of its row.

import type { z } from "zod";

export type FieldKind = "string" | "number" | "boolean" | "enum" | "readonly";

export interface Field {
  name: string;
  kind: FieldKind;
  /** The choices of an enum. */
  options: string[];
  /** An empty input means "not set": the schema decides (a default, or nothing). */
  optional: boolean;
  /** The value of an empty input when the schema is nullable. */
  nullable: boolean;
  defaultValue?: unknown;
  dependsOn?: string;
  description?: string;
}

interface Def {
  type: string;
  innerType?: z.ZodType & { _zod: { def: Def } };
  entries?: Record<string, string>;
  defaultValue?: unknown;
}

const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** The fields of an object schema, in declaration order. */
export function fieldsOf(schema: z.ZodObject): Field[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const meta = (field as { meta?: () => { dependsOn?: string } | undefined }).meta?.();
    const out: Field = { name, kind: "readonly", options: [], optional: false, nullable: false, dependsOn: meta?.dependsOn };
    let def = defOf(field as z.ZodType);
    out.description = (field as z.ZodType).description;
    for (;;) {
      if (def.type === "optional") out.optional = true;
      else if (def.type === "nullable") out.nullable = out.optional = true;
      else if (def.type === "default") {
        out.optional = true;
        out.defaultValue = def.defaultValue;
      } else break;
      if (!def.innerType) break;
      out.description ??= def.innerType.description;
      def = def.innerType._zod.def;
    }
    if (def.type === "string" || def.type === "number" || def.type === "boolean") out.kind = def.type;
    else if (def.type === "enum") {
      out.kind = "enum";
      out.options = Object.values(def.entries ?? {});
    }
    return out;
  });
}

/** What a form holds per field: the text of an editable field, the raw value of a read-only one. */
export type Draft = Record<string, unknown>;

/** The draft of a form: the saved value, else the default of the schema. */
export function draftOf(schema: z.ZodObject, value: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const field of fieldsOf(schema)) {
    const given = value[field.name] ?? field.defaultValue;
    if (field.kind === "readonly") draft[field.name] = value[field.name];
    else if (field.kind === "boolean") draft[field.name] = given === true ? "true" : "false";
    else if (field.kind === "enum") draft[field.name] = given === undefined || given === null ? (field.optional ? "" : field.options[0] ?? "") : String(given);
    else draft[field.name] = given === undefined || given === null ? "" : String(given);
  }
  return draft;
}

/** The fields that show, given the switches of the draft. */
export function visibleFields(fields: Field[], draft: Draft): Field[] {
  return fields.filter((field) => !field.dependsOn || draft[field.dependsOn] === "true");
}

export type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** Checks the draft against the schema; a hidden field is not required. */
export function parseDraft(schema: z.ZodObject, draft: Draft): Parsed {
  const fields = fieldsOf(schema);
  const shown = new Set(visibleFields(fields, draft).map((f) => f.name));
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    if (!shown.has(field.name)) continue;
    const raw = draft[field.name];
    if (field.kind === "readonly") input[field.name] = raw;
    else if (field.kind === "boolean") input[field.name] = raw === "true";
    else if (raw === "" || raw === undefined) input[field.name] = field.nullable ? null : undefined;
    else input[field.name] = field.kind === "number" ? Number(raw) : raw;
  }
  const hidden = Object.fromEntries(fields.filter((f) => !shown.has(f.name)).map((f) => [f.name, true as const]));
  const result = schema.partial(hidden as never).safeParse(input);
  if (result.success) return { ok: true, value: result.data as Record<string, unknown> };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) errors[String(issue.path[0] ?? "")] ??= issue.message;
  return { ok: false, errors };
}
