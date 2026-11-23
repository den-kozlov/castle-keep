// The task source `local_md`: one Markdown file per task in a directory.
//
// `<id>-<slug>.md` holds a YAML frontmatter (title, status, labels, parent,
// blocked_by), the body, and below a line `<!-- comments -->` the comments, each
// as `### <ISO time>` and its text. The id is the number before the slug; the
// change key is the hash of the file content. A task is ready when its status is
// `ready` and every blocker is `done`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_STATES, type Handover, type NewTask, type Task, type TaskSource, type TaskState } from "../source.mts";

export const COMMENTS_SEPARATOR = "<!-- comments -->";

interface Parsed {
  file: string;
  title: string;
  state: TaskState;
  labels: string[];
  parent?: string;
  blockedBy: string[];
  body: string;
  comments: { time: string; text: string }[];
  changeKey: string;
}

const FILE = /^(\d+)(?:-.*)?\.md$/;

/** A frontmatter value: a JSON scalar or list, else the bare text. */
function value(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const list = (v: unknown, key: string): string[] => {
  if (v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  throw new Error(`${key} must be a list`);
};

export function parseTask(file: string, content: string): Parsed {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!m) throw new Error("no frontmatter between --- lines");
  const fm: Record<string, unknown> = {};
  for (const line of m[1]!.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const kv = /^([a-z_]+):(.*)$/.exec(line);
    if (!kv) throw new Error(`bad frontmatter line: ${line}`);
    fm[kv[1]!] = value(kv[2]!);
  }
  const status = fm.status;
  if (typeof status !== "string" || !(TASK_STATES as readonly string[]).includes(status)) {
    throw new Error(`status must be one of ${TASK_STATES.join(", ")}`);
  }
  if (typeof fm.title !== "string" || fm.title === "") throw new Error("title is missing");
  const [body = "", ...rest] = m[2]!.split(`\n${COMMENTS_SEPARATOR}`);
  const comments = rest
    .join(`\n${COMMENTS_SEPARATOR}`)
    .split(/^### /m)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      return { time: chunk.slice(0, nl < 0 ? undefined : nl).trim(), text: (nl < 0 ? "" : chunk.slice(nl + 1)).trim() };
    });
  const parent = fm.parent === undefined || fm.parent === "" || fm.parent === null ? undefined : String(fm.parent);
  return {
    file,
    title: fm.title,
    state: status as TaskState,
    labels: list(fm.labels, "labels"),
    ...(parent ? { parent } : {}),
    blockedBy: list(fm.blocked_by, "blocked_by"),
    body: body.replace(/^\n/, "").trimEnd(),
    comments,
    changeKey: createHash("sha1").update(content).digest("hex").slice(0, 16),
  };
}

function render(t: Omit<Parsed, "file" | "changeKey">): string {
  const fm = [
    "---",
    `title: ${JSON.stringify(t.title)}`,
    `status: ${t.state}`,
    `labels: ${JSON.stringify(t.labels)}`,
    ...(t.parent ? [`parent: ${JSON.stringify(t.parent)}`] : []),
    `blocked_by: ${JSON.stringify(t.blockedBy)}`,
    "---",
  ].join("\n");
  const comments = t.comments.map((c) => `\n### ${c.time}\n${c.text}\n`).join("");
  return `${fm}\n${t.body}\n\n${COMMENTS_SEPARATOR}\n${comments}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "task";

export interface LocalMdOptions {
  /** Receives the warning for a task file that cannot be read. */
  warn?: (message: string) => void;
  now?: () => Date;
}

export function localMdSource(settings: { dir?: string } = {}, options: LocalMdOptions = {}): TaskSource {
  const dir = settings.dir ?? ".sandcastle/tasks";
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const now = options.now ?? (() => new Date());

  const idOf = (file: string) => FILE.exec(file)![1]!;
  const files = () =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => FILE.test(f))
          .sort((a, b) => Number(idOf(a)) - Number(idOf(b)))
      : [];
  const fileOf = (id: string) => files().find((f) => idOf(f) === id);

  /** Every readable task by id; a broken file is warned about and left out. */
  const readAll = () => {
    const all = new Map<string, Parsed>();
    for (const f of files()) {
      try {
        all.set(idOf(f), parseTask(f, readFileSync(join(dir, f), "utf8")));
      } catch (error) {
        warn(`task file ${join(dir, f)} skipped: ${message(error)}`);
      }
    }
    return all;
  };
  const read = (id: string) => {
    const f = fileOf(id);
    if (!f) throw new Error(`no task ${id}`);
    try {
      return parseTask(f, readFileSync(join(dir, f), "utf8"));
    } catch (error) {
      throw new Error(`task file ${join(dir, f)}: ${message(error)}`);
    }
  };
  const write = (id: string, change: (t: Parsed) => void) => {
    const t = read(id);
    change(t);
    writeFileSync(join(dir, t.file), render(t));
  };
  const addComment = (t: Parsed, text: string) => t.comments.push({ time: now().toISOString(), text });
  // A blocker that is missing or unreadable counts as open.
  const openBlockers = (t: Parsed, all: Map<string, Parsed>) => t.blockedBy.filter((b) => all.get(b)?.state !== "done");
  const toTask = (t: Parsed, id: string, open: string[]): Task => ({
    id,
    title: t.title,
    body: t.body,
    labels: t.labels,
    ...(t.parent ? { parent: t.parent } : {}),
    blockers: open,
    comments: t.comments.map((c) => c.text),
    changeKey: t.changeKey,
  });

  return {
    env: [],
    preflight: () => (existsSync(dir) ? {} : { warnings: [`task directory ${dir} does not exist yet`] }),

    async listReady() {
      const all = readAll();
      const ready: Task[] = [];
      for (const [id, t] of all) {
        const open = openBlockers(t, all);
        if (t.state === "ready" && open.length === 0) ready.push(toTask(t, id, open));
      }
      return ready;
    },

    async handToHuman(id, reason): Promise<Handover> {
      try {
        write(id, (t) => {
          t.state = "needs-human";
          addComment(t, `sandcastle: ${reason}`);
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: message(error) };
      }
    },

    async close(id) {
      write(id, (t) => void (t.state = "done"));
    },

    async view(id) {
      const t = read(id);
      return { ...toTask(t, id, openBlockers(t, readAll())), state: t.state };
    },

    async comment(id, body) {
      write(id, (t) => addComment(t, body));
    },

    async edit(id, body) {
      write(id, (t) => void (t.body = body.trimEnd()));
    },

    async create(task: NewTask) {
      mkdirSync(dir, { recursive: true });
      const id = String(Math.max(0, ...files().map((f) => Number(idOf(f)))) + 1);
      const body = task.followUpOf ? `${task.body.trimEnd()}\n\nFollow-up of #${task.followUpOf}` : task.body.trimEnd();
      const content = render({ title: task.title, state: task.state ?? "needs-triage", labels: [], parent: task.parent, blockedBy: [], body, comments: [] });
      writeFileSync(join(dir, `${id}-${slug(task.title)}.md`), content);
      return { id };
    },

    async block(id, blocker) {
      read(blocker);
      write(id, (t) => {
        if (!t.blockedBy.includes(blocker)) t.blockedBy.push(blocker);
      });
    },
  };
}
