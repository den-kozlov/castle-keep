import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireLock } from "./lock.mts";

const dirs: string[] = [];
const lockPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-lock-"));
  dirs.push(dir);
  return join(dir, "run.pid");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("takes a free lock and releases it", () => {
    const path = lockPath();
    const lock = acquireLock(path, 100, () => false);

    assert.equal(lock.ok, true);
    if (lock.ok) lock.release();
    assert.equal(existsSync(path), false);
  });

  it("refuses a lock whose pid lives", () => {
    const path = lockPath();
    writeFileSync(path, "200\n");

    const lock = acquireLock(path, 100, () => true);

    assert.equal(lock.ok, false);
    assert.match(!lock.ok ? lock.reason : "", /pid 200/);
  });

  it("takes over the lock of a dead run", () => {
    const path = lockPath();
    writeFileSync(path, "200\n");

    assert.equal(acquireLock(path, 100, () => false).ok, true);
  });
});
