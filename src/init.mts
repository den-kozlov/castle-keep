// `castle-keep init`: writes `.sandcastle/config.json`, `.sandcastle/.env.example` and the
// generic prompts (./templates) into a repo. Every choice is a flag;
// on a terminal a missing required flag is asked, without one it fails naming the flag.

import { parseArgs } from "node:util";
import { CONFIG_FILE, ConfigError, ROLES } from "./config.mts";
import { sources } from "./modules.mts";
import { defaultRoles, PROMPTS, STANDARDS, writeSetup, ENV_EXAMPLE } from "./setup.mts";

const SOURCE_NAMES = Object.keys(sources).join(", ");

export const INIT_USAGE = `usage: castle-keep init --source <module> --gate <command> [options]
  --source <module>        task source: ${SOURCE_NAMES} (required)
  --gate <command>         a check the reviewer runs; repeat for several (required)
  --sandbox <module>       default no-sandbox
  --agent <id>             agent of every role, default claude-code
  --model <name>           model of every role; --planner-model, --implementer-model,
                           --reviewer-model, --merger-model set one role
  --plugin <name|json>     a plugin by name, or a JSON object {"module": "…", …settings}; repeat
  --base-branch <name>     default main
  --force                  overwrite an existing config and prompts`;

export interface InitIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** The repo to write into. */
  cwd: string;
  /** Whether a person can answer a question. */
  tty: boolean;
  ask?: (question: string) => Promise<string>;
}

class InitError extends Error {}

/** Runs `init`. Returns the exit code: 0, 1 when it refused, 2 on a usage error. */
export async function runInit(argv: string[], io: InitIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        source: { type: "string" },
        gate: { type: "string", multiple: true },
        sandbox: { type: "string" },
        agent: { type: "string" },
        model: { type: "string" },
        "planner-model": { type: "string" },
        "implementer-model": { type: "string" },
        "reviewer-model": { type: "string" },
        "merger-model": { type: "string" },
        plugin: { type: "string", multiple: true },
        "base-branch": { type: "string" },
        force: { type: "boolean" },
      },
    });
    const need = async (flag: string, given: string | undefined, question: string) => {
      if (given) return given;
      if (io.tty && io.ask) {
        const answer = (await io.ask(`${question}: `)).trim();
        if (answer) return answer;
      }
      throw new InitError(`--${flag} is needed`);
    };
    const source = await need("source", values.source, `task source (${SOURCE_NAMES})`);
    const gates = values.gate?.length ? values.gate : [await need("gate", undefined, "gate command")];
    const agent = values.agent ?? "claude-code";
    const roles = defaultRoles(agent);
    for (const role of ROLES) roles[role].model = values[`${role}-model`] ?? values.model ?? roles[role].model;
    const plugins = (values.plugin ?? []).map((p) => {
      if (!p.startsWith("{")) return { module: p };
      try {
        return JSON.parse(p) as { module: string };
      } catch {
        throw new InitError(`--plugin: not JSON: ${p}`);
      }
    });
    let result;
    try {
      result = writeSetup(
        io.cwd,
        { source: { module: source }, sandbox: { module: values.sandbox ?? "no-sandbox" }, roles, gates, plugins, baseBranch: values["base-branch"] },
        values.force,
      );
    } catch (error) {
      if (error instanceof ConfigError) throw new InitError(error.message);
      throw error;
    }
    if (!result.ok) {
      io.err(`refusing to overwrite ${result.existing.join(", ")}; pass --force`);
      return 1;
    }
    io.out(`wrote ${CONFIG_FILE}, ${ENV_EXAMPLE}, ${Object.values(PROMPTS).length} prompts and ${STANDARDS}`);
    return 0;
  } catch (error) {
    if (error instanceof InitError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`${(error as Error).message}\n${INIT_USAGE}`);
      return 2;
    }
    io.err(`failed: ${((error as Error).message ?? String(error)).split("\n")[0]}`);
    return 1;
  }
}
