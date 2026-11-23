// A task source held in memory: the fake of the loop and CLI tests, and the
// smallest example of the interface (./source.mts).

import type { Handover, NewTask, Task, TaskSource, TaskState } from "./source.mts";

export interface MemoryTask extends Task {
  state: TaskState;
}

export interface MemorySource extends TaskSource {
  tasks: Map<string, MemoryTask>;
  /** Every write, in order, as `command id …`. */
  log: string[];
}

export function memorySource(initial: Partial<MemoryTask>[] = [], options: { env?: string[] } = {}): MemorySource {
  const tasks = new Map<string, MemoryTask>();
  const log: string[] = [];
  let next = 100;
  const put = (task: Partial<MemoryTask>) => {
    const id = task.id ?? String(next++);
    tasks.set(id, { id, title: `task ${id}`, body: "", labels: [], blockers: [], comments: [], changeKey: "0", state: "ready", ...task });
  };
  for (const task of initial) put(task);
  const get = (id: string) => {
    const task = tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    return task;
  };
  const touch = (task: MemoryTask) => void (task.changeKey = String(Number(task.changeKey) + 1));

  return {
    tasks,
    log,
    env: options.env ?? [],
    async listReady() {
      return [...tasks.values()].filter((t) => t.state === "ready" && t.blockers.every((b) => tasks.get(b)?.state === "done"));
    },
    async handToHuman(id, reason): Promise<Handover> {
      log.push(`needs-human ${id} ${reason}`);
      const task = tasks.get(id);
      if (!task) return { ok: false, reason: `no task ${id}` };
      task.state = "needs-human";
      task.comments.push(reason);
      touch(task);
      return { ok: true };
    },
    async close(id) {
      log.push(`close ${id}`);
      get(id).state = "done";
    },
    async view(id) {
      return get(id);
    },
    async comment(id, body) {
      log.push(`comment ${id} ${body}`);
      const task = get(id);
      task.comments.push(body);
      touch(task);
    },
    async edit(id, body) {
      log.push(`edit ${id} ${body}`);
      const task = get(id);
      task.body = body;
      touch(task);
    },
    async create(task: NewTask) {
      const id = String(next);
      put({
        id,
        title: task.title,
        body: task.followUpOf ? `${task.body}\n\nFollow-up of #${task.followUpOf}` : task.body,
        state: task.state ?? "needs-triage",
        parent: task.parent,
      });
      log.push(`create ${id} ${task.title}`);
      return { id };
    },
    async block(id, blocker) {
      log.push(`block ${id} ${blocker}`);
      get(id).blockers.push(get(blocker).id);
    },
  };
}
