// The task source `beads`: the issues of a Beads database, through the `bd` CLI.
//
// Fixtures and flags follow Beads 1.3.x (steveyegge/beads), `bd ... --json`.
// An open issue carrying the label `needs-human` or `needs-triage` is in that
// state; any other open issue is `ready` once no `blocks` dependency is open;
// a closed issue is `done`. The parent is the `parent-child` dependency.

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { Handover, NewTask, Task, TaskSource, TaskState } from "../source.mts";

const execFileAsync = promisify(execFile);

export const HUMAN_LABEL = "needs-human";
export const TRIAGE_LABEL = "needs-triage";

/** Runs one `bd` call and returns its standard output. */
export type BdRunner = (args: string[]) => Promise<string>;

const runBd: BdRunner = async (args) => (await execFileAsync("bd", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout;

interface BdDependency {
  id: string;
  status: string;
  dependency_type: string;
}

/** The part of `bd show --json` and `bd ready --json` the source reads. */
export interface BdIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  updated_at: string;
  labels?: string[];
  dependencies?: BdDependency[];
  comments?: { text: string }[];
  parent?: string;
}

function toTask(issue: BdIssue): Task {
  const dependencies = issue.dependencies ?? [];
  const parent = issue.parent ?? dependencies.find((d) => d.dependency_type === "parent-child")?.id;
  return {
    id: issue.id,
    title: issue.title,
    body: issue.description ?? "",
    labels: issue.labels ?? [],
    ...(parent ? { parent } : {}),
    blockers: dependencies.filter((d) => d.dependency_type === "blocks" && d.status !== "closed").map((d) => d.id),
    comments: (issue.comments ?? []).map((c) => c.text),
    changeKey: `${issue.updated_at}/${issue.comments?.length ?? 0}`,
  };
}

const stateOf = (issue: BdIssue): TaskState => {
  if (issue.status === "closed") return "done";
  const labels = issue.labels ?? [];
  if (labels.includes(HUMAN_LABEL)) return "needs-human";
  if (labels.includes(TRIAGE_LABEL)) return "needs-triage";
  return "ready";
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function beadsSource(options: { run?: BdRunner; installed?: () => boolean } = {}): TaskSource {
  const run = options.run ?? runBd;
  const installed = options.installed ?? (() => spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0);
  const show = async (ids: string[]): Promise<BdIssue[]> =>
    ids.length === 0 ? [] : (JSON.parse(await run(["show", ...ids, "--json", "--include-comments"])) as BdIssue[]);

  return {
    env: [],
    preflight: () => (installed() ? {} : { errors: ["bd is not installed (steveyegge/beads): the tasks live there"] }),

    // `bd ready` leaves out the labels and the text, so each ready issue is read whole.
    async listReady() {
      const ready = JSON.parse(await run(["ready", "--json", "--limit", "0", "--exclude-type", "epic", "--exclude-label", `${HUMAN_LABEL},${TRIAGE_LABEL}`])) as BdIssue[];
      const issues = await show(ready.map((issue) => issue.id));
      return issues.filter((issue) => stateOf(issue) === "ready").map(toTask).filter((task) => task.blockers.length === 0);
    },

    async handToHuman(id, reason): Promise<Handover> {
      try {
        await run(["update", id, "--add-label", HUMAN_LABEL, "--remove-label", TRIAGE_LABEL]);
        await run(["comment", id, "--", `sandcastle: ${reason}`]);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: message(error) };
      }
    },

    async close(id) {
      await run(["close", id, "--reason", "Completed by Sandcastle"]);
    },

    async view(id) {
      const issue = (await show([id]))[0];
      if (!issue) throw new Error(`no issue ${id}`);
      return { ...toTask(issue), state: stateOf(issue) };
    },

    async comment(id, body) {
      await run(["comment", id, "--", body]);
    },

    async edit(id, body) {
      await run(["update", id, "--description", body]);
    },

    async create(task: NewTask) {
      const state = task.state ?? "needs-triage";
      const label = { "needs-human": HUMAN_LABEL, "needs-triage": TRIAGE_LABEL, ready: undefined, done: undefined }[state];
      const body = task.followUpOf ? `${task.body.trimEnd()}\n\nFollow-up of #${task.followUpOf}\n` : task.body;
      const out = await run([
        "create", task.title, "--description", body, "--silent",
        ...(label ? ["--labels", label] : []),
        ...(task.parent ? ["--parent", task.parent] : []),
      ]);
      const id = out.trim().split("\n").pop()?.trim() ?? "";
      if (!id) throw new Error("bd create printed no issue id");
      return { id };
    },

    async block(id, blocker) {
      await run(["dep", "add", id, blocker]);
    },
  };
}
