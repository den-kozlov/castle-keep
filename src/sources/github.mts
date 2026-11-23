// The task source `github`: GitHub Issues of the repo, through the `gh` CLI.
//
// Labels carry the state (`ready`, `needs-human`, `needs-triage`); a closed issue
// is `done`. Links between issues are GitHub's own: a PRD is the parent of its
// issues (sub-issues), and an issue waits for its blockers through issue
// dependencies ("blocked by"). An issue is ready only once every blocker is
// closed. The id of an issue is its number, so issue 42 works on the branch
// `sandcastle/issue-42`.

import { spawnSync } from "node:child_process";
import { gh, type GhOptions } from "../gh.mts";
import type { Handover, NewTask, Task, TaskSource, TaskState } from "../source.mts";

/** The label of each state a label carries; `done` is a closed issue. */
export interface Labels {
  ready: string;
  human: string;
  triage: string;
}

export const READY_LABEL = "ready-for-agent";
export const BLOCKED_LABEL = "ready-for-human";
export const TRIAGE_LABEL = "needs-triage";
export const DEFAULT_LABELS: Labels = { ready: READY_LABEL, human: BLOCKED_LABEL, triage: TRIAGE_LABEL };

const FIELDS = `number title body updatedAt state
        labels(first: 30) { nodes { name } }
        comments(last: 50) { nodes { body } }
        parent { number }
        blockedBy(first: 50) { nodes { number state } }`;

/**
 * The open issues with the ready label, their parent and their blockers, in
 * one GraphQL call: `gh issue list --json` has no dependencies. A hundred is
 * far above any ready set.
 */
const readyQuery = (label: string) => `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: ["${label}"], first: 100, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        ${FIELDS}
      }
    }
  }
}`;

const viewQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
        ${FIELDS}
    }
  }
}`;

/** The shape both queries answer, after the `--jq` below. */
const NODE_JQ =
  "{number, title, updatedAt, state, body," +
  " labels: [.labels.nodes[].name], comments: [.comments.nodes[].body], parent: .parent.number," +
  ' blockedBy: [.blockedBy.nodes[] | select(.state == "OPEN") | .number]}';

export const readyIssuesArgs = (label: string) => [
  "api",
  "graphql",
  "-F",
  "owner={owner}",
  "-F",
  "name={repo}",
  "-f",
  `query=${readyQuery(label)}`,
  "--jq",
  `[.data.repository.issues.nodes[] | ${NODE_JQ}]`,
];

export const READY_ISSUES_ARGS = readyIssuesArgs(READY_LABEL);

export const viewIssueArgs = (id: string) => [
  "api",
  "graphql",
  "-F",
  "owner={owner}",
  "-F",
  "name={repo}",
  "-F",
  `number=${id}`,
  "-f",
  `query=${viewQuery}`,
  "--jq",
  `.data.repository.issue | ${NODE_JQ}`,
];

interface ListedIssue {
  number: number;
  title: string;
  updatedAt: string;
  state: string;
  body: string;
  labels: string[];
  comments: string[];
  parent?: number | null;
  blockedBy: number[];
}

function toTask(issue: ListedIssue): Task {
  return {
    id: String(issue.number),
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels,
    ...(issue.parent ? { parent: String(issue.parent) } : {}),
    blockers: issue.blockedBy.map(String),
    comments: issue.comments,
    changeKey: issue.updatedAt,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function githubSource(settings: { ready?: string; human?: string; triage?: string } = {}, options: GhOptions = {}): TaskSource {
  const labels: Labels = {
    ready: settings.ready ?? DEFAULT_LABELS.ready,
    human: settings.human ?? DEFAULT_LABELS.human,
    triage: settings.triage ?? DEFAULT_LABELS.triage,
  };
  const stateLabel = (state: TaskState): string | undefined =>
    ({ ready: labels.ready, "needs-human": labels.human, "needs-triage": labels.triage, done: undefined })[state];
  const stateOf = (issue: ListedIssue): TaskState => {
    if (issue.state !== "OPEN") return "done";
    if (issue.labels.includes(labels.human)) return "needs-human";
    if (issue.labels.includes(labels.ready)) return "ready";
    return "needs-triage";
  };
  const databaseId = async (id: string) => (await gh(["api", `repos/{owner}/{repo}/issues/${id}`, "--jq", ".id"], options)).trim();

  return {
    env: [],
    preflight: () => {
      const signedIn = spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0;
      return signedIn ? {} : { errors: ["gh is not signed in to GitHub (`gh auth login`): the issues live there"] };
    },

    async listReady() {
      const listed = JSON.parse(await gh(readyIssuesArgs(labels.ready), options)) as ListedIssue[];
      return listed.filter((issue) => issue.blockedBy.length === 0).map(toTask);
    },

    // The comment of the reviewer's block, or the implementer's question, is the reason.
    async handToHuman(id, reason): Promise<Handover> {
      try {
        await gh(["issue", "edit", id, "--remove-label", labels.ready, "--add-label", labels.human], options);
        await gh(["issue", "comment", id, "--body", `sandcastle: ${reason}`], options);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: message(error) };
      }
    },

    async close(id) {
      await gh(["issue", "close", id, "--comment", "Completed by Sandcastle"], options);
    },

    async view(id) {
      const issue = JSON.parse(await gh(viewIssueArgs(id), options)) as ListedIssue | null;
      if (!issue) throw new Error(`no issue ${id}`);
      return { ...toTask(issue), state: stateOf(issue) };
    },

    async comment(id, body) {
      await gh(["issue", "comment", id, "--body", body], options);
    },

    async edit(id, body) {
      await gh(["issue", "edit", id, "--body", body], options);
    },

    async create(task: NewTask) {
      const label = stateLabel(task.state ?? "needs-triage");
      const body = task.followUpOf ? `${task.body.trimEnd()}\n\nFollow-up of #${task.followUpOf}\n` : task.body;
      const out = await gh(["issue", "create", "--title", task.title, "--body", body, ...(label ? ["--label", label] : [])], options);
      // `gh issue create` prints the URL of the new issue on its last line.
      const id = out.trim().split("\n").pop()?.split("/").pop() ?? "";
      if (!/^\d+$/.test(id)) throw new Error(`gh issue create printed no issue number: ${out.trim().slice(0, 80)}`);
      if (task.parent) {
        await gh(["api", "--method", "POST", `repos/{owner}/{repo}/issues/${task.parent}/sub_issues`, "-F", `sub_issue_id=${await databaseId(id)}`], options);
      }
      return { id };
    },

    async block(id, blocker) {
      await gh(["api", "--method", "POST", `repos/{owner}/{repo}/issues/${id}/dependencies/blocked_by`, "-F", `issue_id=${await databaseId(blocker)}`], options);
    },
  };
}
