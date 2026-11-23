# castle-keep

An endless loop of coding agents over the ready tasks of a repo, built on
[Sandcastle](https://github.com/mattpocock/sandcastle): plan, implement, review,
merge. One iteration:

1. **Plan**: a planner agent reads the ready tasks (for GitHub, the issues labelled
   `ready-for-agent` whose "blocked by" issues are closed) and picks the ones that
   can run side by side.
2. **Implement and review**: each task gets a git worktree on the branch
   `sandcastle/issue-<n>`. The implementer runs up to 100 iterations and ends
   with `<promise>COMPLETE</promise>` or `<promise>NEEDS-HUMAN</promise>`; a
   reviewer then runs on the same branch and ends with an architecture verdict
   (`<architecture>sound</architecture>` or `blocked`). A blocked branch stays
   out of the merge; a needs-human task moves to the human.
3. **Merge**: one merger agent merges the branches into the base branch. The
   orchestrator then closes each merged task through the task source.

In a terminal it runs without end under a TUI and stops on `s`. Without a TTY,
or with `--batch`, it runs `--iterations N` iterations. `SIGTERM` stops softly.
A pid lock allows one run, a limit gate holds back new work when a Claude plan
window is full, and the config file is read at the start
of every iteration, so an edit needs no restart.

## Install

```sh
npm install --save-dev castle-keep @ai-hero/sandcastle ink react zod
```

Node 22 or later. `@ai-hero/sandcastle`, `ink`, `react` and `zod` are peer
dependencies. The agents need the CLI of their agent (`claude` for `claude-code`)
and the tools of the chosen task source (`gh` for `github`, `bd` for `beads`).

## Use

1. Write the config and the prompts:

   ```sh
   npx castle-keep init --source github --gate "npm test"
   ```

2. Copy `.sandcastle/.env.example` to `.sandcastle/.env`, fill in the keys, and keep
   that file out of git (`.sandcastle/.env`, `.sandcastle/logs/`,
   `.sandcastle/worktrees/` and `.sandcastle/run.pid` belong in `.gitignore`).
3. With the `github` source, create the labels of the states once; `gh` fails on a
   missing label:

   ```sh
   gh label create ready-for-agent --description "An agent may take it"
   gh label create ready-for-human --description "Waits for a human"
   gh label create needs-triage --description "Waits for triage"
   ```

   These are the defaults; the source settings `ready`, `human` and `triage` rename them.
4. Start the loop:

   ```sh
   npx castle-keep run                       # in a terminal: endless, under the TUI
   npx castle-keep run --batch --iterations 3
   ```

   `castle-keep run` in a terminal without a config opens the setup wizard first.

`npx castle-keep init --source <github|local_md|beads> --gate "<command>"` writes
`.sandcastle/config.json`, `.sandcastle/.env.example` (the keys the source and the agent
declare), the four prompts and `CODING_STANDARDS.md` into `.sandcastle/`. Every choice has a
flag (`--sandbox`, `--agent`, `--model` and `--<role>-model`, `--plugin` by name or as a JSON
object, `--base-branch`); the output is checked by the resolver before it is written. On a
terminal a missing required flag (`--source`, `--gate`) is asked; without one the command fails
naming it. An existing config or prompt is never overwritten without `--force`. Edit the prompts
and the standards for your project: they are yours after the copy.

A start in a terminal without a config opens a wizard (task tracker, sandbox, agent of each role,
checks, plugins, prompt copy) that calls the same setup function as `init`. In the TUI, `c` opens the
settings window: a form per module drawn from its `zod` schema (strings, numbers, booleans, enums;
any other field shows read-only), a plugin only when its `requires` task tracker is chosen. A gray
line under each form and menu explains the row under the cursor: the `.describe(...)` of its schema.
A change of the task tracker or the sandbox that drops the old module's settings, or a plugin that
requires the old tracker, asks first and names what goes away. A save writes the config file; the
loop reads it at the next iteration.

A project that wants its own start code calls the same loop from an entry file, for example
`.sandcastle/main.mjs`, run with `node .sandcastle/main.mjs`; it takes the same `--batch` and
`--iterations` and opens the wizard the same way:

```js
import { runSandcastle } from "castle-keep";
await runSandcastle();
```

[`examples/config.json`](https://github.com/den-kozlov/castle-keep/blob/main/examples/config.json) is a working config; [`templates/*-prompt.md`](https://github.com/den-kozlov/castle-keep/blob/main/templates)
are the generic prompts `init` copies, with the placeholders the engine fills (`ISSUES_JSON`;
`TASK_ID`, `ISSUE_TITLE`, `BRANCH`; `CHECKS` for the review; `BRANCHES`,
`ISSUES`, `HUMAN_ISSUES`, `MERGED_ISSUES` for the merge). They call only
`castle-keep task …` and keep the signals (`COMPLETE`, `NEEDS-HUMAN`), the architecture
verdict, the criteria ticks with proof and the follow-up tasks.

Credentials: `.sandcastle/.env` with `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.

## The config file

The file is read at the start of every iteration; a missing or broken file keeps
the last good read, and a broken first read refuses the start with the field that
failed. The modules (source, sandbox, plugins) are built by the first read.

- `source`, `sandbox`, `plugins[]`: `{ "module": "<name>", ...settings }`; each
  module declares its settings with a `zod` schema ([modules](https://github.com/den-kozlov/castle-keep/blob/main/src/modules.mts)), each setting with a
  `.describe(...)` for the settings window.
- `sandbox`: a provider of Sandcastle 0.12: `no-sandbox` (agents on the host), `docker`,
  `podman`, `vercel`, `daytona`. The file holds only data options (image, mounts, networks,
  CPUs and the like). The SDKs of `vercel` and `daytona` (`@vercel/sandbox`, `@daytona/sdk`,
  installed by you) run on the host: their keys `VERCEL_TOKEN` and `DAYTONA_API_KEY` go in
  `.sandcastle/.env` or the process environment, never in the file. Sandcastle puts every key of
  `.sandcastle/.env` into the sandbox env, so a key there reaches the agent too, as
  `OPENROUTER_API_KEY` and every other key of the file does. To hide it from the agent, keep it
  only in the process environment.
- `roles`: `planner`, `implementer`, `reviewer`, `merger`, each
  `{ agent, model, effort? }`; `agent` is `claude-code`.
- `prompts` (four paths), `gates` (commands the reviewer runs, listed in
  `{{CHECKS}}`), `env` (`${NAME}` and `${NODE_DIR}` expand), `copyToWorktree`
  (gitignored files the host has).
- Optional, with defaults: `baseBranch` (`main`), `remote`, `parallelism` (3),
  `commandTimeoutMs` (30 min), `idleTimeoutSeconds` (no limit),
  `maxPlannerFailures` (3), `batchIterations` (10).
- `hooks`: keys `host.<event>`, `sandbox.<event>`, `*.<event>`; events
  `worktreeBuildup`, `worktreeTeardown`, `preflight`, `periodic`, `afterMerge`.
  The last three are host only; the resolver refuses them under `sandbox` and `*`.
  An entry is a script (`.ts`, `.mts`, `.mjs`, `.sh`, by extension) or a shell
  command; a `.ts` or `.mts` script runs with `node --import tsx`, so the project
  needs `tsx`; `periodic` takes `{ "run", "interval": "10m", "name"? }`. A hook gets
  `CASTLE_KEEP_WORKTREE`, `CASTLE_KEEP_TASK` and `CASTLE_KEEP_ROLE`. A preflight
  hook prints `error: …` or `warning: …`; a periodic hook prints a summary when
  it did something.
- Package constants, not settings: the mirror name, the issue branch prefix, the
  `.sandcastle/` paths, the Claude config dir.

`parseConfig` turns the text of the file into the one object the loop reads, and throws a
`ConfigError` naming the field that failed; `createConfigReader` re-reads the file and keeps the
last good read.

## The task source and `castle-keep task`

The task source ([interface](https://github.com/den-kozlov/castle-keep/blob/main/src/source.mts)) is the tracker: exactly one per project. The host
lists the ready tasks (id, title, body, labels, parent, blockers, comments and a
change key), hands a task to a human with a reason, and closes it after the
merge. Common states: `ready`, `needs-human`, `needs-triage`, `done`; each
source maps them. A source declares the keys it needs in `env`: preflight names
a missing one, and the orchestrator passes the set ones to the agents.

Agents reach the source only through the CLI, so a prompt names no tracker:
`npm exec castle-keep -- task <command>`. It finds `.sandcastle/config.json` by
walking up from the working directory.

| Command | Does |
| --- | --- |
| `view <id> [--json]` | prints the task with its comments |
| `comment <id> --body <text>` or `--body-file <file>` | adds a comment |
| `edit <id> --body-file <file>` | replaces the body (ticks criteria) |
| `create --title <t> --body-file <f> [--state <s>] [--parent <id>] [--follow-up-of <id>]` | files a task; `--follow-up-of` writes the line `Follow-up of #<id>` |
| `block <id> <blocker>` | makes a task wait for another |
| `needs-human <id> --reason <text>` | hands the task to a human |

The source `github` keeps tasks as GitHub Issues: labels are the states,
sub-issues the parent, issue dependencies the blockers, `gh` underneath.

The source `local_md` (`{ "module": "local_md", "dir": ".sandcastle/tasks" }`) keeps one
file `<number>-<slug>.md` per task: YAML frontmatter (`title`, `status`, `labels`,
`parent`, `blocked_by`), the body, and below a line `<!-- comments -->` the comments,
each as `### <ISO time>` and its text. The id is the number; the change key is the hash
of the file. A task is ready when `status` is `ready` and every blocker is `done`. A file
that does not parse is skipped with a warning naming it.

The source `beads` keeps them in a Beads database through `bd`: the labels
`needs-human` and `needs-triage` are those states, a closed issue is `done`, the
`parent-child` dependency is the parent, open `blocks` dependencies the blockers.
Preflight fails when `bd` is not installed.

## Plugins

A plugin is a plain object (its [types](https://github.com/den-kozlov/castle-keep/blob/main/src/plugin.mts) are exported) with optional contributions: `env`,
`hooks`, `preflight`, `tasks`, `listeners` (`onRunStart`, `onAgentStart`,
`onEvent`) and the five below. Contributions merge in plugin order.

- `preStart(input)`: runs before every agent of every role (planner,
  implementer, reviewer, merger). It gets the role, the agent id, the task and
  the proposed options, and returns changes to `model`, `effort`, `idleTimeout`,
  `env`, a `note` for the agent row, and agent-specific blocks such as
  `claudeCode: { settings }`. The agent module merges the blocks of all
  plugins; for `claude-code` the settings fragments become one `--settings`.
- `lifecycle`: `iterationStart`, `branchReady` (with the review outcome),
  `mergeDone` (with the merged branches), `iterationEnd`, `runEnd`. The core
  awaits them in plugin order with the base branch, host git helpers, a notice
  function and the source API. An error is a warning and the run goes on; they
  are never gated.
- `gate.check({ step, role?, agent?, model?, issue? })`: asked before every
  step (`poll`, `plan`, `implement`, `review`, `merge`, `periodic`). It answers
  open, or closed with a reason and an optional `until`; any closed gate holds
  the step. New work (`poll`, `plan`, `implement`): an endless run waits until
  the latest `until`, a batch run exits. `review` and `merge`: an endless run
  waits; a batch run exits and leaves the branch (and, for `review`, its
  worktree). Without `until` the gate is asked again in a minute; `s` and `K`
  break any wait.
- `header()`: declarative `meter`, `text` and `badge` elements for a header slot
  of the plugin. The TUI draws them; batch mode prints them as one line when
  they change. A pre-start `note` is the one note of an agent row.
- `requires: { source }`: another source refuses the start with the reason.

The agent of a role is a module too: it builds the provider of a
run, reads the stream for the tool lines and the `CTX` column, and declares its
auth env, which the preflight checks. `claude-code` is the first.
The sandbox holds the project env; the agent sets the variables its pre-start
hooks changed or added on its own command, since Sandcastle refuses a key in both
providers and a sandbox of `createSandbox` ignores the agent provider env.

Bundled, opt-in plugins use this interface only:

- `github-pr` (requires the `github` source): the mirror `sandcastle/main` and a
  pull request per issue branch, a record of the diff; nobody merges there. Mirror
  push at iteration start, branch push and pull request at `branchReady`, mirror
  push, wait for merged and remote branch deletion at `mergeDone` and
  `iterationEnd`, a dry-run push in preflight. Failures are warnings. Without the
  plugin nothing is pushed.
- `orca`: shows worktrees and agent logs on the Orca board and the status of
  the run in the title of the terminal tab.
- `graft({ sourceDirs })`: adds a `PreToolUse` hook through
  `claudeCode.settings` that denies `grep` over the source directories and
  names the graft command instead. For another agent it warns once and adds
  nothing.
- `jev({ project?, cheapModel, easyThreshold })`: in its pre-start hook, asks Jev
  (through OpenRouter, `OPENROUTER_API_KEY`) whether a cheap, fast model can finish
  the issue alone on the first try, and picks `cheapModel` for the implementer at
  P(yes) ≥ `easyThreshold` (default 0.9: conservative and not tuned). `project`, one or two
  sentences on what the project is, goes in front of the question. The row note
  reads `P(easy) 0.93`; no key, an error or an odd answer keeps the strong model.
- `claude-limits({ fiveHourPercent, sevenDayPercent })`: closes every step of an
  agent on `claude-code` at 5h ≥ 90 % or 7d ≥ 95 %, `review` and `merge`
  included; passes the steps without an agent; shows the 5h and 7d meters; warns
  when no role uses `claude-code`.

## Design

- **The config is data.** One JSON file in `.sandcastle/`, kept in the repo and
  read at the start of every iteration: the TUI edits it, a schema checks it, and
  a change takes effect without a restart. A config in code could do neither.
  What is special to a project goes into hooks (scripts or commands), its
  prompts and its gates, not into the package.
- **Secrets stay out of the file.** Keys go in `.sandcastle/.env` or the process
  environment; the file names modules and their data options only.
- **Four module kinds**, each with a `zod` schema of its settings: exactly one
  task source, exactly one sandbox, one agent per role, any number of plugins.
  The settings window and the first-run wizard draw their forms from these
  schemas.
- **Agents reach the tracker only through `castle-keep task`.** The prompts name
  no tracker, so one set of prompts serves every source; the orchestrator, not
  the merger agent, closes a merged task.
- **Plugins extend through hooks and gates.** Lifecycle hooks, a gate before
  every step, a pre-start hook per agent and declarative header elements; the
  core names no tool. A tool name (`gh`, `bd`, `graft`, `orca`, `jev`) appears
  only in the files of its own module, and a test guards that.

## Development

```sh
npm ci
npm run typecheck
npm test        # builds dist/ first, then runs the tests with tsx
```

`npm test` runs the tests next to the sources (`src/**/*.test.mts`) and a smoke
test of the built package on plain node (`test/dist.test.mts`).
`src/purity.test.mts` fails when a tool name leaves the files of its module.

This repo runs castle-keep on itself: `.sandcastle/` holds its config and
prompts. `npm run castle` builds the package, copies the build to the gitignored
`.sandcastle/run/` and starts the loop from that copy, so the gates that rebuild
`dist/` during a merge leave the running loop alone.

## License

MIT
