#!/usr/bin/env node
// The `castle-keep` command. It finds `.sandcastle/config.json` by walking up from the working directory.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { runTaskCommand } from "./cli.mts";
import { CONFIG_FILE, parseConfig } from "./config.mts";
import { INIT_USAGE, runInit } from "./init.mts";

function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) return path;
    if (dirname(dir) === dir) return undefined;
  }
}

const USAGE = `usage: castle-keep init [options]     write .sandcastle/config.json and the prompts (init --help)
       castle-keep run [--batch] [--iterations N]
                                      start the loop; without a config, a terminal opens the setup wizard
       castle-keep task <view|comment|edit|create|block|needs-human> …
       castle-keep --version`;

const [group, ...rest] = process.argv.slice(2);
if (group === "--help" || group === "-h" || group === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (group === "--version" || group === "-v") {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  console.log(manifest.version);
  process.exit(0);
}
if (group === "init" && (rest.includes("--help") || rest.includes("-h"))) {
  console.log(INIT_USAGE);
  process.exit(0);
}
if (group === "run") {
  // Loaded on demand: the loop pulls in Sandcastle and the TUI, which `task` and `init` do not need.
  const { runSandcastle } = await import("./run.mts");
  await runSandcastle();
}
if (group === "init") {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const code = await runInit(rest, { out: console.log, err: console.error, cwd: process.cwd(), tty, ask: rl && ((q) => rl.question(q)) });
  rl?.close();
  process.exit(code);
}
if (group !== "task") {
  console.error(USAGE);
  process.exit(2);
}
const path = findConfig(process.cwd());
if (!path) {
  console.error(`no ${CONFIG_FILE} in this directory or above`);
  process.exit(2);
}
const source = parseConfig(readFileSync(path, "utf8")).source.build();
process.exit(await runTaskCommand(rest, source, { out: console.log, err: console.error }));
