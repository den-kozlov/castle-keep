// Checks before a run starts. A problem the harness would only meet hours
// later, at the merge, is cheaper to meet now.
//
// Errors refuse the start. Warnings are shown; the TUI asks to go on when the
// base is not `main`, batch mode starts anyway.

import { existsSync } from "node:fs";
import { DEFAULT_REFS, checkCheckout, readCheckout, type GitRunner, type Refs } from "./git.mts";
import { readEnvFile } from "./env-file.mts";
import type { PreflightCheck } from "./plugin.mts";
import type { TaskSource } from "./source.mts";

export interface PreflightInput {
  base: string;
  env: Record<string, string>;
  exists: (path: string) => boolean;
  /** The task source: the keys it needs must be set, and its own checks pass. */
  source?: Pick<TaskSource, "env" | "preflight">;
  /** The checks of the project and its plugins; see ./plugin.mts. */
  checks?: PreflightCheck[];
  /** The branch the run should start on. Defaults to `main`. */
  expectedBase?: string;
  /** The remote, mirror and branch prefix. Defaults to `origin`, `sandcastle/main`, `sandcastle/issue-`. */
  refs?: Refs;
  /** The credential variables of the agents (`AgentModule.authEnv`); one of them must be set. */
  authEnv?: string[];
  /** `git` with the exit code; see ./git.mts. */
  git?: GitRunner;
}

export interface PreflightResult {
  errors: string[];
  warnings: string[];
  /** True when the base is not the expected one: the TUI asks before it goes on. */
  confirmBase: boolean;
}

export const EXPECTED_BASE = "main";

export function preflight(input: PreflightInput): PreflightResult {
  const expectedBase = input.expectedBase ?? EXPECTED_BASE;
  const refs = input.refs ?? DEFAULT_REFS;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.exists(".sandcastle/.env")) {
    errors.push("no .sandcastle/.env; copy .sandcastle/.env.example");
  } else {
    const auth = input.authEnv ?? [];
    if (auth.length > 0 && !auth.some((name) => input.env[name])) {
      errors.push(`no ${auth.join(" or ")} in .sandcastle/.env`);
    }
  }

  for (const check of input.checks ?? []) {
    const found = check({ base: input.base, refs });
    errors.push(...(found.errors ?? []));
    warnings.push(...(found.warnings ?? []));
  }

  for (const key of input.source?.env ?? []) {
    if (!input.env[key] && !process.env[key]) errors.push(`no ${key} in .sandcastle/.env or the environment: the task source needs it`);
  }
  const found = input.source?.preflight?.();
  errors.push(...(found?.errors ?? []));
  warnings.push(...(found?.warnings ?? []));

  const checkout = checkCheckout(readCheckout(input.git));
  if (!checkout.ok) errors.push(checkout.reason);

  const confirmBase = input.base !== expectedBase;
  if (confirmBase) {
    warnings.push(`base branch is ${input.base}, not ${expectedBase}: the merger merges into ${input.base}`);
  }

  if (input.git) {
    const worktrees = input.git(["worktree", "list", "--porcelain"]).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree ") && line.includes("/.sandcastle/worktrees/"));
    if (worktrees.length > 0) {
      warnings.push(`${worktrees.length} worktree(s) left from an earlier run; their issues resume`);
    }
    const branches = input.git(["branch", "--list", `${refs.branchPrefix}*`]).stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (branches.length > 0) {
      warnings.push(`${branches.length} ${refs.branchPrefix}* branch(es) from earlier runs`);
    }
  }

  return { errors, warnings, confirmBase };
}

/** The preflight against the real checkout. */
export function preflightHere(
  base: string,
  git: GitRunner,
  options: { checks?: PreflightCheck[]; expectedBase?: string; refs?: Refs; authEnv?: string[]; source?: Pick<TaskSource, "env" | "preflight"> } = {},
): PreflightResult {
  return preflight({ base, env: readEnvFile(), exists: existsSync, git, ...options });
}
