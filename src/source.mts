// The task source interface. A source is the tracker a
// project keeps its tasks in. The host reads the ready tasks, hands a task to a
// human and closes it after the merge; agents reach the same source through
// `castle-keep task …` (./cli.mts), so prompts do not depend on the tracker.

/** The states every source maps onto its own labels, statuses or frontmatter. */
export const TASK_STATES = ["ready", "needs-human", "needs-triage", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  id: string;
  title: string;
  body: string;
  labels: string[];
  /** The task of the feature this one belongs to. */
  parent?: string;
  /** The blockers still open. */
  blockers: string[];
  comments: string[];
  /** Changes whenever the task, its labels or its comments do; the loop plans again on a new key. */
  changeKey: string;
}

export interface NewTask {
  title: string;
  body: string;
  /** Defaults to `needs-triage`. */
  state?: TaskState;
  parent?: string;
  /** The source writes the line `Follow-up of #<id>` into the body. */
  followUpOf?: string;
}

export type Handover = { ok: true } | { ok: false; reason: string };

export interface TaskSource {
  /** The keys of the environment the source needs: preflight checks them, agents get them. */
  env: string[];
  /** Extra preflight findings of the source itself, for example a missing sign-in. */
  preflight?: () => { errors?: string[]; warnings?: string[] };

  // Host side.
  /** The tasks an agent may take now: ready, with no blocker open. Throws when the tracker stays unreachable. */
  listReady(): Promise<Task[]>;
  /** Moves a task to `needs-human` and says why. Never throws. */
  handToHuman(id: string, reason: string): Promise<Handover>;
  /** Closes a merged task as `done`. Throws on failure. */
  close(id: string): Promise<void>;

  // Agent side (the CLI).
  view(id: string): Promise<Task & { state: TaskState }>;
  comment(id: string, body: string): Promise<void>;
  /** Replaces the body. */
  edit(id: string, body: string): Promise<void>;
  create(task: NewTask): Promise<{ id: string }>;
  /** Makes `id` wait for `blocker`. */
  block(id: string, blocker: string): Promise<void>;
}
