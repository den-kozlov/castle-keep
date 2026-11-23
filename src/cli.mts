// `castle-keep task <command> …`: the one door of the agents to the task source.
// A prompt names these commands and nothing of the tracker behind them.
//
//   view <id> [--json]
//   comment <id> (--body <text> | --body-file <file>)
//   edit <id> (--body <text> | --body-file <file>)        replaces the body
//   create --title <text> (--body … | --body-file …) [--state <state>] [--parent <id>] [--follow-up-of <id>]
//   block <id> <blocker>
//   needs-human <id> --reason <text>

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { TASK_STATES, type TaskSource, type TaskState } from "./source.mts";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Replaced in tests. */
  readFile?: (path: string) => string;
}

const USAGE = `usage: castle-keep task <command>
  view <id> [--json]
  comment <id> (--body <text> | --body-file <file>)
  edit <id> (--body <text> | --body-file <file>)
  create --title <text> (--body <text> | --body-file <file>) [--state ${TASK_STATES.join("|")}] [--parent <id>] [--follow-up-of <id>]
  block <id> <blocker>
  needs-human <id> --reason <text>`;

class UsageError extends Error {}

/** Runs one command against the source. Returns the exit code: 0, 1 when the source failed, 2 on a usage error. */
export async function runTaskCommand(argv: string[], source: TaskSource, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        body: { type: "string" },
        "body-file": { type: "string" },
        title: { type: "string" },
        state: { type: "string" },
        parent: { type: "string" },
        "follow-up-of": { type: "string" },
        reason: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const id = () => {
      if (!positionals[0]) throw new UsageError(`${command}: a task id is needed`);
      return positionals[0];
    };
    const text = () => {
      if (values.body !== undefined) return values.body;
      if (values["body-file"] !== undefined) return (io.readFile ?? ((p) => readFileSync(p, "utf8")))(values["body-file"]);
      throw new UsageError(`${command}: --body or --body-file is needed`);
    };

    switch (command) {
      case "view": {
        const task = await source.view(id());
        if (values.json) {
          io.out(JSON.stringify(task, null, 2));
          return 0;
        }
        const lines = [`#${task.id} [${task.state}] ${task.title}`];
        if (task.labels.length > 0) lines.push(`labels: ${task.labels.join(", ")}`);
        lines.push(`parent: ${task.parent ? `#${task.parent}` : "none"}`);
        lines.push(`blocked by: ${task.blockers.length > 0 ? task.blockers.map((b) => `#${b}`).join(", ") : "none"}`, "", task.body);
        task.comments.forEach((comment, i) => lines.push("", `--- comment ${i + 1} ---`, comment));
        io.out(lines.join("\n"));
        return 0;
      }
      case "comment":
        await source.comment(id(), text());
        io.out(`commented on #${id()}`);
        return 0;
      case "edit":
        await source.edit(id(), text());
        io.out(`edited #${id()}`);
        return 0;
      case "create": {
        if (!values.title) throw new UsageError("create: --title is needed");
        const state = values.state ?? "needs-triage";
        if (!TASK_STATES.includes(state as TaskState)) throw new UsageError(`create: --state is one of ${TASK_STATES.join(", ")}`);
        const created = await source.create({
          title: values.title,
          body: text(),
          state: state as TaskState,
          parent: values.parent,
          followUpOf: values["follow-up-of"],
        });
        io.out(`created #${created.id}`);
        return 0;
      }
      case "block":
        if (!positionals[1]) throw new UsageError("block: a task id and its blocker are needed");
        await source.block(id(), positionals[1]);
        io.out(`#${id()} is blocked by #${positionals[1]}`);
        return 0;
      case "needs-human": {
        if (!values.reason) throw new UsageError("needs-human: --reason is needed");
        const done = await source.handToHuman(id(), values.reason);
        if (!done.ok) throw new Error(done.reason);
        io.out(`#${id()} handed to a human`);
        return 0;
      }
      default:
        throw new UsageError(command ? `unknown command ${command}` : "a command is needed");
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    io.err(`failed: ${((error as Error).message ?? String(error)).split("\n")[0]}`);
    return 1;
  }
}
