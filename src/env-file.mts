import { readFileSync } from "node:fs";

export const ENV_FILE = ".sandcastle/.env";

/** The KEY=value pairs of .sandcastle/.env; empty when the file is missing. */
export function readEnvFile(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const value = line.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
    if (value) values[line.slice(0, equals).trim()] = value;
  }
  return values;
}
