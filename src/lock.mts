// One run at a time. Two runs would merge into the same base.
//
// The lock is a file with the pid of the run. A file whose pid no longer lives
// is a leftover of a killed run, and the next run takes it over.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LOCK_FILE = ".sandcastle/run.pid";

export type LockResult = { ok: true; release: () => void } | { ok: false; reason: string };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process lives but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function acquireLock(
  path = LOCK_FILE,
  pid = process.pid,
  isAlive: (pid: number) => boolean = alive,
): LockResult {
  let held: number | undefined;
  try {
    held = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    held = undefined;
  }
  if (held !== undefined && Number.isFinite(held) && held !== pid && isAlive(held)) {
    return { ok: false, reason: `another run holds ${path} (pid ${held})` };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`);
  return {
    ok: true,
    release: () => {
      try {
        if (readFileSync(path, "utf8").trim() === String(pid)) rmSync(path);
      } catch {
        // Already gone.
      }
    },
  };
}
