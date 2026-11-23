// The graft guard: a PreToolUse hook of the agents.
//
// graft is wired into every agent session (README, "graft"), and its
// SessionStart hook tells the agent to find code with graft first. The agents
// read that and still searched the source with `grep -rn` and `rg`: dozens of
// calls per issue, not one graft call. The guard denies a search of the source
// directories and names the graft command that answers it; the denial reaches
// the agent as the tool result, and the agent takes the graft route.
//
// A search the graph cannot answer stays possible: the agent ends the command
// with `# graft-miss: <why>`. Text that is not source (docs, logs, the output
// of a command piped into grep) passes untouched.
//
// The plugin passes the hook to the agents only, through `claude --settings`;
// a session of the human keeps the repo's own hooks.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "../plugin.mts";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An operand that names source: a source directory, or a source file or glob. */
function sourcePattern(sourceDirs: string[]): RegExp {
  const dirs = sourceDirs.map(escapeRe).join("|");
  const head = dirs ? `^(\\.\\/)?(${dirs})(\\/|$)|` : "";
  return new RegExp(`${head}\\.(rs|mjs|mts|js|ts|tsx)$`);
}

/** An operand that names the whole checkout. */
const ROOT = /^\.\/?$/;

/** The escape: the agent tried graft, and graft did not answer. */
const MISS = "graft-miss";

export const REASON = [
  "Find source code with graft, not grep or rg; its graph covers this branch:",
  '- `graft grep "<literal>"`: every occurrence, grouped by the enclosing symbol;',
  '- `graft ask "<question>" --source`: where the code lives and how it works, the code inlined;',
  "- `graft skeleton <file>`: the API of a file with the line spans, then `sed -n` only the span;",
  "- `graft callers <symbol> --depth all`: who calls it, what a change breaks.",
  "grep stays fine for text that is not code (docs, logs, command output).",
  `If graft did not answer, run the search again and end the command with \`# ${MISS}: <why>\`.`,
].join("\n");

type HookInput = {
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string; path?: string; glob?: string; type?: string };
};

/** The simple commands of a shell line as words, quotes removed, no
 *  expansion; each with whether a pipe feeds it. An operator inside quotes,
 *  such as the `\\|` of a grep pattern, stays in its word. */
function commands(line: string): { argv: string[]; piped: boolean }[] {
  const out: { argv: string[]; piped: boolean }[] = [];
  let argv: string[] = [];
  let word: string | undefined;
  let piped = false;
  const endWord = () => {
    if (word !== undefined) argv.push(word);
    word = undefined;
  };
  const endCommand = (next: boolean) => {
    endWord();
    if (argv.length > 0) out.push({ argv, piped });
    argv = [];
    piped = next;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      const stop = close < 0 ? line.length : close;
      word = (word ?? "") + line.slice(i + 1, stop).replace(c === '"' ? /\\(.)/g : /$^/, "$1");
      i = stop;
    } else if (c === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "");
      i++;
    } else if (c === "#" && word === undefined) {
      const eol = line.indexOf("\n", i);
      i = eol < 0 ? line.length : eol - 1;
    } else if (c === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) {
      word = (word ?? "") + c; // a redirection: 2>&1, &>
    } else if (/\s/.test(c) && c !== "\n") {
      endWord();
    } else if ("|&;\n()`".includes(c) || (c === "$" && line[i + 1] === "(")) {
      const pipe = c === "|" && line[i + 1] !== "|";
      if (line[i + 1] === c || c === "$") i++;
      endCommand(pipe);
    } else {
      word = (word ?? "") + c;
    }
  }
  endCommand(false);
  return out;
}

/** Why a Bash command is a source search, or undefined when it is not one. */
function bashSearch(command: string, SOURCE: RegExp): string | undefined {
  if (command.includes(MISS)) return undefined;
  const all = commands(command);
  const everything = all.flatMap((c) => c.argv);
  for (const { argv: words, piped } of all) {
    let argv = words;
    while (argv.length > 0 && /^\w+=/.test(argv[0] ?? "")) argv = argv.slice(1);
    const viaXargs = argv[0] === "xargs";
    if (viaXargs) argv = argv.slice(1).filter((word, i) => i > 0 || !word.startsWith("-"));

    const tool = (argv[0] ?? "").split("/").pop() ?? "";
    let args: string[];
    let recursive: boolean;
    if (["grep", "egrep", "fgrep"].includes(tool)) {
      args = argv.slice(1);
      recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    } else if (tool === "rg") {
      args = argv.slice(1);
      recursive = true;
    } else if (tool === "git" && argv[1] === "grep") {
      args = argv.slice(2);
      recursive = true;
    } else {
      continue;
    }

    // xargs takes its files from the pipe: a source path anywhere in the line.
    if (viaXargs && everything.some((word) => SOURCE.test(word))) return `xargs ${tool}`;

    const operands = args.filter((a) => !a.startsWith("-"));
    if (operands.some((a) => SOURCE.test(a))) return tool;
    // The pattern is the first operand; none after it searches the checkout.
    const paths = operands.slice(1);
    if (recursive && !piped && (paths.length === 0 || paths.some((a) => ROOT.test(a)))) return tool;
  }
  return undefined;
}

/** Why a Grep tool call is a source search, or undefined when it is not one. */
// It has no comment to carry the escape: past a graft miss, the agent greps in Bash.
function grepSearch(input: NonNullable<HookInput["tool_input"]>, cwd: string, SOURCE: RegExp): string | undefined {
  const path = cwd && input.path ? relative(cwd, input.path) || "." : (input.path ?? "");
  if (!path || ROOT.test(path) || SOURCE.test(path)) return "Grep";
  if ((input.glob && SOURCE.test(input.glob)) || ["rust", "js", "ts"].includes(input.type ?? "")) {
    return "Grep";
  }
  return undefined;
}

/** The reason to deny a tool call, or undefined to let it run. */
export function guard(input: HookInput, sourceDirs: string[] = []): string | undefined {
  const SOURCE = sourcePattern(sourceDirs);
  const toolInput = input.tool_input ?? {};
  const hit =
    input.tool_name === "Bash" && toolInput.command
      ? bashSearch(toolInput.command, SOURCE)
      : input.tool_name === "Grep"
        ? grepSearch(toolInput, input.cwd ?? "", SOURCE)
        : undefined;
  return hit === undefined ? undefined : REASON;
}

// Run as a hook: the tool call on stdin, the decision on stdout. Any failure
// lets the call run: a broken guard must not stop an agent.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reason = guard(JSON.parse(readFileSync(0, "utf8")) as HookInput, (process.argv[2] ?? "").split(",").filter(Boolean));
    if (reason !== undefined) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
  } catch {
    // Let the call run.
  }
}

export interface GraftOptions {
  /** Directories of the checkout that hold source; a search of them is denied. */
  sourceDirs: string[];
}

/**
 * The plugin: a `PreToolUse` hook on `Bash` and `Grep` of every Claude Code
 * agent. Another agent has no such hook: one warning, no change.
 */
export function graftPlugin(options: GraftOptions): Plugin {
  const command = [process.execPath, fileURLToPath(import.meta.url), options.sourceDirs.join(",")]
    .map((word) => JSON.stringify(word))
    .join(" ");
  let warned = false;
  return {
    name: "graft",
    preStart({ agent, notice }) {
      if (agent !== "claude-code") {
        if (!warned) notice(`graft: the search guard works only on claude-code, not on ${agent}`, "warn");
        warned = true;
        return undefined;
      }
      return {
        claudeCode: {
          settings: { hooks: { PreToolUse: [{ matcher: "Bash|Grep", hooks: [{ type: "command", command, timeout: 5 }] }] } },
        },
      };
    },
  };
}
