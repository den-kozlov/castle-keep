import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  iterationsToPrune,
  LATEST_LINK,
  logFileName,
  runStamp,
  runsToPrune,
  startLogRun,
} from "./logs.mts";

const roots: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-logs-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runStamp", () => {
  it("builds a sortable directory name from the local time", () => {
    assert.equal(runStamp(new Date(2026, 8, 18, 4, 5, 6)), "2026-09-18T04-05-06");
  });
});

describe("logFileName", () => {
  it("keeps the old name shape of branch and agent", () => {
    assert.equal(logFileName("dev", "planner"), "dev-planner.log");
  });

  it("replaces the path separators of a branch name", () => {
    assert.equal(
      logFileName("sandcastle/issue-194", "implementer"),
      "sandcastle-issue-194-implementer.log",
    );
  });
});

describe("runsToPrune", () => {
  it("keeps the newest runs and names the older ones", () => {
    const names = [
      "2026-09-15T10-00-00",
      "2026-09-17T10-00-00",
      "2026-09-16T10-00-00",
      "2026-09-18T10-00-00",
    ];

    assert.deepEqual(runsToPrune(names, 2), [
      "2026-09-15T10-00-00",
      "2026-09-16T10-00-00",
    ]);
  });

  it("keeps everything that is not a run directory", () => {
    const names = ["latest", "dev-planner.log", "2026-09-15T10-00-00"];

    assert.deepEqual(runsToPrune(names, 0), ["2026-09-15T10-00-00"]);
  });

  it("counts a second run of the same second as its own run", () => {
    const names = ["2026-09-15T10-00-00", "2026-09-15T10-00-00-2"];

    assert.deepEqual(runsToPrune(names, 1), ["2026-09-15T10-00-00"]);
  });

  it("names nothing while the run count is inside the limit", () => {
    assert.deepEqual(runsToPrune(["2026-09-18T10-00-00"], 5), []);
  });
});

describe("startLogRun", () => {
  it("makes a directory for this run", () => {
    const root = makeRoot();
    const run = startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6) });

    assert.equal(run.dir, join(root, "2026-09-18T04-05-06"));
    assert.ok(readdirSync(root).includes("2026-09-18T04-05-06"));
  });

  it("gives two runs in a row separate directories", () => {
    const root = makeRoot();
    const first = startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6) });
    const second = startLogRun({ root, at: new Date(2026, 8, 18, 4, 9, 30) });

    assert.notEqual(first.dir, second.dir);
    assert.equal(
      first.startIteration(1).file("dev", "merger").path,
      join(first.dir, "001", "dev-merger.log"),
    );
    assert.equal(
      second.startIteration(1).file("dev", "merger").path,
      join(second.dir, "001", "dev-merger.log"),
    );
  });

  it("gives two runs of the same second separate directories", () => {
    const root = makeRoot();
    const at = new Date(2026, 8, 18, 4, 5, 6);
    const first = startLogRun({ root, at });
    const second = startLogRun({ root, at });

    assert.notEqual(first.dir, second.dir);
    assert.equal(second.dir, join(root, "2026-09-18T04-05-06-2"));
    assert.notEqual(
      first.startIteration(1).file("dev", "merger").path,
      second.startIteration(1).file("dev", "merger").path,
    );
  });

  it("points the latest link at the current run", () => {
    const root = makeRoot();
    startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6) });
    const second = startLogRun({ root, at: new Date(2026, 8, 18, 4, 9, 30) });

    assert.equal(readlinkSync(join(root, LATEST_LINK)), basename(second.dir));
  });

  it("removes the runs above the keep count", () => {
    const root = makeRoot();
    for (const day of [10, 11, 12]) {
      mkdirSync(join(root, `2026-09-${day}T10-00-00`), { recursive: true });
    }

    startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6), keep: 2 });

    assert.deepEqual(readdirSync(root).filter((n) => n !== LATEST_LINK).sort(), [
      "2026-09-12T10-00-00",
      "2026-09-18T04-05-06",
    ]);
  });

  it("leaves the logs of the old flat layout alone", () => {
    const root = makeRoot();
    writeFileSync(join(root, "dev-planner.log"), "old run\n");

    startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6), keep: 1 });

    assert.ok(readdirSync(root).includes("dev-planner.log"));
  });

  it("gives the file option that sandcastle expects", () => {
    const root = makeRoot();
    const run = startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6) });

    assert.deepEqual(run.startIteration(3).file("sandcastle/issue-7", "reviewer"), {
      type: "file",
      path: join(run.dir, "003", "sandcastle-issue-7-reviewer.log"),
    });
  });

  it("puts the journal of the harness at the top of the run", () => {
    const root = makeRoot();
    const run = startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6) });

    assert.equal(run.orchestratorPath, join(run.dir, "orchestrator.log"));
  });

  it("points the latest link at the current iteration", () => {
    const root = makeRoot();
    const run = startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6) });
    run.startIteration(1);
    run.startIteration(2);

    assert.equal(readlinkSync(join(root, LATEST_LINK)), `${basename(run.dir)}/002`);
  });

  it("keeps the newest iterations over all runs and drops a run left empty", () => {
    const root = makeRoot();
    const old = "2026-09-10T10-00-00";
    mkdirSync(join(root, old, "001"), { recursive: true });
    writeFileSync(join(root, old, "orchestrator.log"), "old\n");
    const run = startLogRun({ root, at: new Date(2026, 8, 18, 4, 5, 6), keepIterations: 2 });

    run.startIteration(1);
    run.startIteration(2);

    assert.equal(readdirSync(root).includes(old), false);
    assert.deepEqual(readdirSync(run.dir).sort(), ["001", "002"]);

    run.startIteration(3);
    assert.deepEqual(readdirSync(run.dir).sort(), ["002", "003"]);
  });
});

describe("iterationsToPrune", () => {
  it("orders by run, then by number", () => {
    const paths = ["b/002", "a/010", "b/001", "a/009"];

    assert.deepEqual(iterationsToPrune(paths, 1), ["a/009", "a/010", "b/001"]);
  });
});
