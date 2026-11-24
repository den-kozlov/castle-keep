// Sandcastle: a team of Claude Code agents over the `ready-for-agent` issues.
//
// Two modes (./policy.mts):
//   endless  in a terminal: a TUI (./tui.tsx), work polled with a backoff, and
//            a stop command that lets the work in hand finish.
//   batch    without a TTY, or with --batch: up to --iterations N (default
//            10) iterations, plain lines on stdout, exit when there is no work.
//
// The loop lives in ./engine.mts. `runSandcastle` checks the checkout, takes the
// run lock, picks the view, and wires the stop signals. A project calls it from
// a short entry file; its config is a JSON file (./config.mts).
//
// Arguments: --batch, --iterations N.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { format } from "node:util";
import { Control } from "./control.mts";
import { CONFIG_FILE, createConfigReader, type ConfigReader, type Harness } from "./config.mts";
import { runLoop } from "./engine.mts";
import { formatLine, type RunEvent } from "./events.mts";
import { readCheckout } from "./git.mts";
import { acquireLock } from "./lock.mts";
import { startLogRun } from "./logs.mts";
import type { Mode } from "./policy.mts";
import { preflightHere } from "./preflight.mts";

export async function runSandcastle(configFile = CONFIG_FILE): Promise<never> {
  // A start without a config opens the wizard on a terminal and stops after it:
  // the files it wrote must be committed before a run (the checkout must be clean).
  if (!existsSync(configFile) && process.stdout.isTTY && process.stdin.isTTY) {
    const { runSetup } = await import("./wizard.tsx");
    process.exit(await runSetup(process.cwd()));
  }
  const reader = createConfigReader(configFile);
  const first = reader.read();
  if (!first.ok) {
    console.error(`Sandcastle refuses to start: ${first.reason}`);
    process.exit(1);
  }
  const harness: Harness = first.harness;

  // ---------------------------------------------------------------------------
  // Arguments
  // ---------------------------------------------------------------------------

  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };

  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const mode: Mode = flag("--batch") || !interactive ? "batch" : "endless";
  const maxIterations = Number.parseInt(value("--iterations") ?? "", 10) || harness.batchIterations;

  const git = (gitArgs: string[]) => {
    const out = spawnSync("git", gitArgs, { encoding: "utf8" });
    return { status: out.status ?? 128, stdout: out.stdout ?? "" };
  };

  // The branch the run started on. Agent branches are measured against it, and
  // the merger merges into it.
  const base = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

  // ---------------------------------------------------------------------------
  // Preflight and lock
  // ---------------------------------------------------------------------------

  const lock = acquireLock();
  if (!lock.ok) {
    console.error(`Sandcastle refuses to start: ${lock.reason}`);
    process.exit(1);
  }

  const checks = preflightHere(base, git, {
    checks: harness.preflight,
    expectedBase: harness.baseBranch,
    refs: harness.refs,
    source: harness.source,
    authEnv: [...new Set(Object.values(harness.agents).flatMap((agent) => agent.authEnv))],
  });
  if (checks.errors.length > 0) {
    console.error("Sandcastle refuses to start:");
    for (const error of checks.errors) console.error(`  ✗ ${error}`);
    lock.release();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // The view
  // ---------------------------------------------------------------------------

  const logRun = startLogRun();
  const control = new Control();

  const stamp = () => new Date().toLocaleTimeString("en-GB");
  const journal = (line: string) => {
    try {
      appendFileSync(logRun.orchestratorPath, `${stamp()} ${line}\n`);
    } catch {
      // The journal is a convenience; the run goes on without it.
    }
  };

  let view: (event: RunEvent) => void;
  let closeView = async () => {};

  if (mode === "endless") {
    const { startTui } = await import("./tui.tsx");
    const tui = startTui(control, logRun.orchestratorPath, configFile);
    view = tui.emit;
    closeView = tui.close;

    // Ink owns the screen. Every stray console line, from this harness or from
    // sandcastle itself, goes to the journal; warnings and errors also show as
    // notices.
    const toJournal =
      (level?: "warn" | "error") =>
      (...parts: unknown[]) => {
        const text = format(...parts);
        journal(text);
        if (level) tui.emit({ type: "notice", level, text: text.trim().split("\n")[0] ?? "" });
      };
    console.log = toJournal();
    console.info = toJournal();
    console.warn = toJournal("warn");
    console.error = toJournal("error");

    for (const warning of checks.warnings) tui.emit({ type: "notice", level: "warn", text: warning });
    if (checks.confirmBase) {
      const go = await tui.confirm(checks.warnings);
      if (!go) {
        await tui.close();
        lock.release();
        console.log("Not started.");
        process.exit(0);
      }
    }
  } else {
    view = (event) => {
      const line = formatLine(event);
      if (line !== undefined) console.log(line);
    };
    for (const warning of checks.warnings) console.log(`! ${warning}`);
  }

  // Plugins that show the run elsewhere start before its first event.
  await harness.listeners.onRunStart();

  // The events go to the listeners of the newest good read: a plugin that is
  // off in the file gets no event after it.
  let current = harness;
  const followed: ConfigReader = {
    read() {
      const read = reader.read();
      if (read.ok) current = read.harness;
      return read;
    },
  };

  const emit = (event: RunEvent) => {
    const line = formatLine(event);
    if (line !== undefined) journal(line.trim());
    view(event);
    current.listeners.onEvent(event);
  };

  control.onChange(() => emit({ type: "stop", request: control.stop }));

  // SIGTERM is a soft stop in both modes. In batch mode Ctrl-C sends SIGINT: the
  // first is a soft stop, the second a hard one. In the TUI, Ctrl-C is a key and
  // opens a menu instead.
  process.on("SIGTERM", () => control.requestSoft());
  process.on("SIGINT", () => (control.stop === "none" ? control.requestSoft() : control.hardStop()));

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  emit({
    type: "start",
    mode,
    base,
    logDir: relative(process.cwd(), logRun.dir),
    maxIterations: mode === "batch" ? maxIterations : undefined,
  });

  let exitCode = 0;
  try {
    await runLoop({ harness, reader: followed, mode, maxIterations, base, control, logRun, emit });
  } catch (error) {
    exitCode = 1;
    emit({ type: "notice", level: "error", text: `run failed: ${(error as Error).stack ?? error}` });
  } finally {
    await closeView();
    lock.release();
  }

  if (mode === "endless") {
    // The TUI is gone; leave the end of the journal on the terminal.
    try {
      const tail = readFileSync(logRun.orchestratorPath, "utf8").trimEnd().split("\n").slice(-15);
      process.stdout.write(`${tail.join("\n")}\n`);
    } catch {
      // No journal.
    }
    const checkout = readCheckout();
    if (checkout.unfinished) process.stdout.write(`! unfinished ${checkout.unfinished} in the checkout\n`);
    process.stdout.write(`Journal: ${relative(process.cwd(), logRun.orchestratorPath)}\n`);
  }

  // Sandcastle can leave handles open (MCP servers, timers); the run is over.
  process.exit(exitCode);
}
