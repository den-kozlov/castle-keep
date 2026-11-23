// The modules a config file may name, each with the zod schema of its settings.
// The resolver (./config.mts) validates the file against them. This file lists every module, so it may name every tool.
// Each schema and each setting carries `.describe(...)`: the help lines of the settings window.

import type * as sandcastle from "@ai-hero/sandcastle";
import { daytona } from "@ai-hero/sandcastle/sandboxes/daytona";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";
import { z } from "zod";
import type { AgentModule } from "./agent.mts";
import { readEnvFile } from "./env-file.mts";
import { claudeCodeAgent } from "./agents/claude-code.mts";
import type { Plugin } from "./plugin.mts";
import { claudeLimits } from "./plugins/claude-limits.mts";
import { graftPlugin } from "./plugins/graft.mts";
import { EASY_QUESTION, EASY_THRESHOLD, jevPilot } from "./plugins/jev.mts";
import { githubPrPlugin } from "./plugins/github-pr.mts";
import { orcaPlugin } from "./plugins/orca.mts";
import { beadsSource } from "./sources/beads.mts";
import { githubSource } from "./sources/github.mts";
import { localMdSource } from "./sources/local-md.mts";
import type { TaskSource } from "./source.mts";

/** The `sandbox` option of a sandcastle run. */
export type SandboxProvider = NonNullable<Parameters<typeof sandcastle.run>[0]["sandbox"]>;

const text = z.string().trim().min(1);

interface Module<S extends z.ZodType, B> {
  settings: S;
  build: (settings: z.infer<S>) => B;
  /** The source a plugin works with only; the settings window hides the plugin under another one. */
  requires?: { source: string };
}
const module_ = <S extends z.ZodType, B>(settings: S, build: (settings: z.infer<S>) => B, requires?: { source: string }): Module<S, B> => ({
  settings,
  build,
  ...(requires ? { requires } : {}),
});

/** The task source: exactly one. */
export const sources: Record<string, Module<z.ZodType, TaskSource>> = {
  beads: module_(z.object({}).strict().describe("Tasks in a Beads database through bd; labels are the states."), () => beadsSource()),
  github: module_(
    z.object({
      repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/name").optional().describe("The repo as owner/name; read from the remote origin when not set."),
      ready: text.default("ready-for-agent").describe("The label of a task the agents may take; default ready-for-agent."),
      human: text.default("ready-for-human").describe("The label of a task handed to a human; default ready-for-human."),
      triage: text.default("needs-triage").describe("The label of a task that waits for triage; default needs-triage."),
    }).strict().describe("Tasks as GitHub Issues through gh; labels are the states."),
    // `gh` reads the repo from `origin` unless the config names it; every `gh` call of the process follows.
    (s) => {
      if (s.repo) process.env.GH_REPO = s.repo;
      return githubSource(s);
    },
  ),
  local_md: module_(
    z.object({ dir: text.default(".sandcastle/tasks").describe("The directory of the task files; default .sandcastle/tasks.") })
      .strict()
      .describe("Tasks as Markdown files in a directory of the repo."),
    (s) => localMdSource(s),
  ),
};

const ids = z.number().int().min(0);
const strings = z.array(text);
const mount = z.object({ hostPath: text, sandboxPath: text, readonly: z.boolean().optional() }).strict();

/** The settings docker and podman share. `off` stands for `false` of the provider: a form edits no boolean-or-string. */
const containerShape = (engine: string, uidDefault: string) => ({
  imageName: text.optional().describe(`The ${engine} image of the agents; derived from the repo directory name when not set.`),
  containerUid: ids.optional().describe(`The UID of the agent user in the image; default ${uidDefault}.`),
  containerGid: ids.optional().describe(`The GID of the agent user in the image; default ${uidDefault}.`),
  selinuxLabel: z.enum(["z", "Z", "off"]).optional().describe("The SELinux label of the bind mounts: z shared (default), Z private, off none."),
  mounts: z.array(mount).optional().describe("More host directories to mount: { hostPath, sandboxPath, readonly? }; none by default."),
  network: strings.optional().describe(`The ${engine} networks of the container; the default network when not set.`),
  groups: strings.optional().describe("Extra groups of the agent user (--group-add), names or GIDs; none by default."),
  devices: strings.optional().describe("Host devices to expose (--device host[:container[:perms]]); none by default."),
  cpus: z.number().positive().optional().describe("The CPU limit of the container (--cpus); no limit when not set."),
});
type ContainerSettings = z.infer<z.ZodObject<ReturnType<typeof containerShape>>>;
const containerOptions = ({ selinuxLabel, ...rest }: ContainerSettings) => ({
  ...rest,
  ...(selinuxLabel ? { selinuxLabel: selinuxLabel === "off" ? (false as const) : selinuxLabel } : {}),
});

/**
 * The key of a provider SDK that runs on the host: from .sandcastle/.env, else the process env.
 * Never in the config file. Castle-keep drops it from the env it hands the sandbox, but Sandcastle
 * 0.12 merges every key of .sandcastle/.env into the sandbox env itself: only a process-env key stays hidden.
 */
const hostSecret = (key: string) => readEnvFile()[key] || process.env[key] || undefined;
const without = (env: Record<string, string>, key: string) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== key));

const vercelSettings = z.object({
  runtime: text.optional().describe("The runtime image, for example node24 (default) or python3.13."),
  vcpus: z.number().int().min(1).optional().describe("The vCPUs of the microVM, 2048 MB each; the Vercel default when not set."),
  timeoutMs: z.number().int().min(1).optional().describe("Milliseconds until the sandbox stops itself; the Vercel default when not set."),
  ports: z.array(z.number().int().min(1).max(65535)).max(4).optional().describe("Up to 4 ports to expose; none by default."),
  snapshotId: text.optional().describe("A snapshot to start from; an empty sandbox when not set."),
  projectId: text.optional().describe("The Vercel project of the sandboxes; from the token when not set."),
  teamId: text.optional().describe("The Vercel team of the sandboxes; from the token when not set."),
}).strict().describe("Agents run in Vercel microVMs; needs @vercel/sandbox and VERCEL_TOKEN; in .sandcastle/.env the agent sees it too, in the environment only it does not.");

/** The options of the vercel provider; exported for the tests. */
export function vercelOptions({ vcpus, snapshotId, ...rest }: z.infer<typeof vercelSettings>, env: Record<string, string>) {
  const token = hostSecret("VERCEL_TOKEN");
  return {
    ...rest,
    ...(vcpus ? { resources: { vcpus } } : {}),
    ...(snapshotId ? { source: { type: "snapshot" as const, snapshotId } } : {}),
    ...(token ? { token } : {}),
    env: without(env, "VERCEL_TOKEN"),
  };
}

const daytonaSettings = z.object({
  apiUrl: text.optional().describe("The Daytona API URL; DAYTONA_API_URL when not set."),
  target: text.optional().describe("The Daytona target region; DAYTONA_TARGET when not set."),
  image: text.optional().describe("The image of the sandbox; give this or snapshot, the Daytona default when neither."),
  snapshot: text.optional().describe("The snapshot of the sandbox; give this or image."),
}).strict()
  .refine((s) => !(s.image && s.snapshot), { message: "give image or snapshot, not both", path: ["snapshot"] })
  .describe("Agents run in Daytona sandboxes; needs @daytona/sdk and DAYTONA_API_KEY; in .sandcastle/.env the agent sees it too, in the environment only it does not.");

/** The options of the daytona provider; exported for the tests. */
export function daytonaOptions({ image, snapshot, ...rest }: z.infer<typeof daytonaSettings>, env: Record<string, string>) {
  const apiKey = hostSecret("DAYTONA_API_KEY");
  return {
    ...rest,
    ...(image ? { create: { image } } : snapshot ? { create: { snapshot } } : {}),
    ...(apiKey ? { apiKey } : {}),
    env: without(env, "DAYTONA_API_KEY"),
  };
}

/** The sandbox: exactly one; builds the provider of an agent from its environment. */
export const sandboxes = {
  "no-sandbox": module_(
    z.object({}).strict().describe("Agents run on the host in their worktrees, with no container."),
    () => (env: Record<string, string>): SandboxProvider => noSandbox({ env }),
  ),
  docker: module_(
    z.object(containerShape("Docker", "the host UID/GID")).strict().describe("Agents run in Docker containers with the worktree bind-mounted."),
    (s) => (env: Record<string, string>): SandboxProvider => docker({ ...containerOptions(s), env }),
  ),
  podman: module_(
    z.object({
      ...containerShape("Podman", "1000"),
      userns: z.enum(["keep-id", "off"]).optional().describe("The user namespace of rootless Podman: keep-id (default), off for rootful."),
    }).strict().describe("Agents run in Podman containers with the worktree bind-mounted."),
    ({ userns, ...rest }) => (env: Record<string, string>): SandboxProvider =>
      podman({ ...containerOptions(rest), ...(userns ? { userns: userns === "off" ? (false as const) : userns } : {}), env }),
  ),
  vercel: module_(vercelSettings, (s) => (env: Record<string, string>): SandboxProvider => vercel(vercelOptions(s, env))),
  daytona: module_(
    daytonaSettings,
    (s) => (env: Record<string, string>): SandboxProvider => daytona(daytonaOptions(s, env) as Parameters<typeof daytona>[0]),
  ),
};

/** An agent of a role. */
export const agents: Record<string, Module<z.ZodType, AgentModule>> = {
  "claude-code": module_(z.object({}).strict().describe("Claude Code, run by Sandcastle."), () => claudeCodeAgent),
};

export const plugins: Record<string, Module<z.ZodType, Plugin>> = {
  "github-pr": module_(
    z.object({}).strict().describe("Pushes the mirror branch and opens a pull request per issue branch, as a record."),
    () => githubPrPlugin(),
    { source: "github" },
  ),
  orca: module_(z.object({}).strict().describe("Shows the worktrees and agent logs on the Orca board."), () => orcaPlugin()),
  graft: module_(
    z.object({ sourceDirs: z.array(text).describe("The directories where grep is denied in favour of graft.") })
      .strict()
      .describe("Points the agents from grep to the graft index of the source directories."),
    (s) => graftPlugin(s),
  ),
  jev: module_(
    z.object({
      project: text.optional().describe(`What the project is, one or two sentences, put in front of the question: "${EASY_QUESTION}"`),
      cheapModel: text.nullable().default(null).describe("The model of an easy implementer task; the pilot is off when not set."),
      easyThreshold: z.number().min(0).max(1).default(EASY_THRESHOLD).describe(`The P(yes) at or above which the cheap model runs; default ${EASY_THRESHOLD}.`),
    }).strict().describe("Jev (through OpenRouter) picks a cheap implementer model for an easy task."),
    (s) => jevPilot(s),
  ),
  "claude-limits": module_(
    z.object({
      fiveHourPercent: z.number().min(1).max(100).default(90).describe("The 5-hour usage percent that closes the agent steps; default 90."),
      sevenDayPercent: z.number().min(1).max(100).default(95).describe("The 7-day usage percent that closes the agent steps; default 95."),
    }).strict().describe("Closes the agent steps of claude-code near the Claude usage limits."),
    (s) => claudeLimits(s),
  ),
};

export type AgentId = string;
export const AGENT_IDS: AgentId[] = Object.keys(agents);
