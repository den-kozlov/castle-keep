# castle-keep

[![npm](https://img.shields.io/npm/v/castle-keep)](https://www.npmjs.com/package/castle-keep)
[![CI](https://github.com/den-kozlov/castle-keep/actions/workflows/ci.yml/badge.svg)](https://github.com/den-kozlov/castle-keep/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/castle-keep)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/castle-keep)](https://github.com/den-kozlov/castle-keep/blob/main/LICENSE)

**A terminal UI for [Sandcastle](https://github.com/mattpocock/sandcastle).** castle-keep runs
Sandcastle in an infinite loop over the ready tasks of your repo and lets you see the task
details and the agent logs.

> **castle-keep** was initially imagined as a simple TUI for
> [Sandcastle](https://github.com/mattpocock/sandcastle) by
> [Matt Pocock](https://github.com/mattpocock). But at some point something went wrong, and now
> it has plugins, hooks and whatnot. If you don't know what Sandcastle is, I encourage you to
> visit its repo (don't forget to star it) and [read the docs](https://www.aihero.dev/sandcastle).

**Contents:**
[The loop](#the-loop) ·
[Quick start](#quick-start) ·
[GitHub labels](#github-labels) ·
[Skills](#skills-that-write-the-tasks) ·
[The TUI](#the-tui) ·
[Customize](#customize) ·
[Reference](#reference) ·
[Credits](#credits)

## The loop

**The loop is the loop of Sandcastle.** One iteration is the template
`parallel-planner-with-review`, which `sandcastle init` offers. castle-keep runs that loop, shows
it, and lets plugins hook into each step. To learn how the loop works inside, read the
[Sandcastle docs](https://www.aihero.dev/sandcastle):
[templates](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/init.md#templates),
[iterations](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/iterations.md),
[branch strategies](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/branch-strategies.md)
and [prompts](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/prompts.md).

```text
                                 ┌───────────┐   ┌────────┐
                             ┌──>│ Implement │──>│ Review │──┐
┌──────────────┐   ┌──────┐  │   └───────────┘   └────────┘  │   ┌───────┐
│ task tracker │──>│ Plan │──┤                               ├──>│ Merge │──┐
└──────────────┘   └──────┘  │   ┌───────────┐   ┌────────┐  │   └───────┘  │
        ^                    └──>│ Implement │──>│ Review │──┘              │
        │                        └───────────┘   └────────┘                 │
        └───────────────────────────────────────────────────────────────────┘
```

| Step | Who does it | What happens | Result |
| --- | --- | --- | --- |
| **1. Poll** | castle-keep | Lists the ready tasks with one cheap call to the tracker. | The planner starts only when the list holds new work. |
| **2. Plan** | The planner agent | Reads the ready tasks, finds which ones depend on each other, and picks the tasks that can run side by side. | A plan: each task with its branch `sandcastle/issue-<n>`. |
| **3. Implement** | One implementer agent per task | Works in its own git worktree, on the branch of the task. Writes tests and code, and commits. | Commits on the branch, or a question for a human. |
| **4. Review** | One reviewer agent per branch | Runs your checks on the branch, makes the code cleaner, and gives a verdict on the architecture. | A branch that is ready to merge, or a blocked branch. |
| **5. Merge** | The merger agent | Merges the good branches into the base branch and runs your checks one more time. | The work is on the base branch. |
| **6. Close** | castle-keep | Closes the merged tasks and deletes the merged branches. | The next iteration starts. |

### What castle-keep adds to the loop

- **It runs without end.** The template stops after a fixed number of iterations. castle-keep
  polls the tracker, and without work it waits: 1 minute first, then twice as long each time,
  up to 60 minutes. With `--batch` it runs a fixed number of iterations and exits.
- **A TUI.** One row per agent with its task, model and context, and the header meters of the
  plugins. See [The TUI](#the-tui).
- **A config as data.** One JSON file, read at the start of every iteration. Press `c` to edit it
  in the TUI. Most changes need no restart.
- **Two ways to a human.** An implementer that needs a decision ends with a question. A reviewer
  that finds a wrong design blocks the branch. In both cases castle-keep moves the task to
  `ready-for-human` and writes the reason in a comment.
- **Plugins.** Hooks, gates and header elements for every step: pull requests, Claude plan
  limits, model choice per task, and more.
- **Any task tracker.** GitHub Issues, Markdown files or Beads, behind one `castle-keep task` CLI.

## Quick start

You need:

- Node 22 or later;
- a git repo with a clean working tree;
- the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI;
- the [GitHub CLI](https://cli.github.com), signed in. These steps use GitHub Issues as the
  task tracker.

### 1. Install

castle-keep needs Sandcastle and three more packages next to it.

```sh
npm install --save-dev castle-keep @ai-hero/sandcastle ink react zod
```

### 2. Set up

```sh
npx castle-keep setup
```

The wizard asks these questions, in this order:

| Question | Example |
| --- | --- |
| The task tracker | `github` |
| The sandbox: where the agents run | `no-sandbox` (on your machine) |
| The model of each agent | one per role: planner, implementer, reviewer, merger |
| The checks that the reviewer runs | `npm test` |
| The command that prepares each worktree | `npm ci` |
| The plugins | `github-pr`, `claude-limits` |
| The prompts | copy the generic prompts, or bring your own |

Then it writes `.sandcastle/config.json`, the agent prompts and `.sandcastle/.env.example`, and
adds the local files of a run to `.gitignore`.

The sandboxes are the
[sandbox providers of Sandcastle](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/sandbox-providers.md).

### 3. Get a Claude token

The agents sign in to Claude with this token.

```sh
claude setup-token
```

### 4. Save the token

Replace `paste-the-token-here` with the token from step 3:

```sh
echo "CLAUDE_CODE_OAUTH_TOKEN=paste-the-token-here" > .sandcastle/.env
```

### 5. Create the GitHub labels

The labels carry the state of each task. [GitHub labels](#github-labels) tells what each one
means.

```sh
gh label create ready-for-agent --force --description "An agent may take it"
gh label create ready-for-human --force --description "Waits for a human"
gh label create needs-triage --force --description "Waits for triage"
```

### 6. Commit the setup

A run starts only from a clean working tree.

```sh
git add .gitignore .sandcastle package.json package-lock.json
git commit -m "Set up castle-keep"
```

### 7. Start

```sh
npx castle-keep run
```

Add the label `ready-for-agent` to an issue. The agents take it on the next iteration.

### Set up without the wizard

`castle-keep init` writes the same files as the wizard, with every choice as a flag. Use it in
place of step 2, for example in a script. This command gives a working config for a Node project
with GitHub Issues:

```sh
npx castle-keep init --source github --gate "npm test" --hook "sandbox.worktreeBuildup=npm ci" --plugin github-pr --plugin claude-limits
```

`npx castle-keep init --help` lists all flags: `--sandbox`, `--agent`, `--model`,
`--<role>-model`, `--plugin`, `--hook`, `--base-branch`, `--force`.

## GitHub labels

**castle-keep does not invent its labels.** With the `github` source, a label is the state of a
task:

| Label | Meaning | Who sets it |
| --- | --- | --- |
| **`ready-for-agent`** | The task is fully specified. An agent may take it. | You, or the skills `/triage`, `/to-tickets` and `/to-spec`. |
| **`ready-for-human`** | The task needs a human. | castle-keep, when an implementer asks for a human or a reviewer blocks the branch. It adds a comment with the reason. |
| **`needs-triage`** | A maintainer must look at the task first. | An agent, when it files a task for a new problem that it found. |

A closed issue is done. An open issue without these labels waits for triage, and no agent takes
it.

### Where the names come from

The names are the **triage roles** of [Matt Pocock's skills](https://github.com/mattpocock/skills).
The skill
[`/triage`](https://github.com/mattpocock/skills/blob/main/skills/engineering/triage/SKILL.md)
defines five roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and
`wontfix`.

The Sandcastle repo runs its own agents on the same labels:

- [docs/agents/triage.md](https://github.com/mattpocock/sandcastle/blob/main/docs/agents/triage.md)
  lists the labels and their meaning;
- its [plan prompt](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/plan-prompt.md)
  gives the planner only the issues with `ready-for-agent`.

castle-keep reads three of the five roles. It ignores `needs-info` and `wontfix`: an issue with
only one of these labels waits, and no agent takes it.

> [!NOTE]
> `sandcastle init` offers to create one label, `Sandcastle`, for its own scaffold
> ([`--create-label`](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/cli.md#sandcastle-init)).
> castle-keep needs three states, so it follows the triage labels above and not that one label.

### Why these names

- **One vocabulary from the idea to the merge.** The skills write these labels, and castle-keep
  reads them. You map nothing.
- **A human opens the gate.** An agent takes only a task that a person, or a triage session with
  a person, marked `ready-for-agent`.
- **Each name tells who acts next:** an agent, a human, or a maintainer who has to decide.

To use other names, set `ready`, `human` and `triage` in the settings of the `github` source.

## Skills that write the tasks

castle-keep can only be as good as its tasks. An agent needs a task that tells what to build and
how to check it.

[**Skills For Real Engineers**](https://github.com/mattpocock/skills) is the skill set of Matt
Pocock, the author of Sandcastle. The skills and Sandcastle are made for each other: the skills
write the tasks in the shape that the loop reads, and the loop does the work. castle-keep keeps
that shape, so the skills work with it as they are.

castle-keep works without the skills. With them, the path from an idea to a merged branch looks
like this:

| Step | Skill | What it does |
| --- | --- | --- |
| 1 | [`/setup-matt-pocock-skills`](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md) | Once per repo: sets the issue tracker and the triage labels. Keep the default labels. |
| 2 | [`/grill-with-docs`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md) | Asks you questions until the plan is clear, and records the terms and the decisions. |
| 3 | [`/to-spec`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md) | Writes the spec and files it as an issue. |
| 4 | [`/to-tickets`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) | Splits the spec into small tickets, each with its blockers and the label `ready-for-agent`. |
| 5 | [`/triage`](https://github.com/mattpocock/skills/blob/main/skills/engineering/triage/SKILL.md) | Moves incoming issues through the labels and writes a brief for the agent. |
| 6 | `npx castle-keep run` | The agents take the tickets. |

What the skills write is what castle-keep reads:

| The skills write | castle-keep reads it as |
| --- | --- |
| The label `ready-for-agent` | A task that an agent may take. |
| A ticket as a **sub-issue** of the spec | The parent of the task. The agents read the parent as the spec of the feature. |
| A **blocked-by** link between two tickets | A blocker. A task is ready only when every blocker is closed. |
| Checkboxes under "Acceptance criteria" | The list that the implementer ticks and the reviewer checks. |

Install the skills in Claude Code:

```sh
claude plugin install mattpocock-skills@claude-plugins-official
```

The [README of the skills](https://github.com/mattpocock/skills#readme) shows how to install
them for other agents and explains each skill.

> [!NOTE]
> `/to-spec` puts `ready-for-agent` on the spec too. When tickets carry the work, remove that
> label from the spec. If you do not, the planner sees the spec as one more task.

## The TUI

`npx castle-keep run` in a terminal opens the TUI. The header shows the state of the run and the
meters of the plugins. Below it, each agent has one row.

| Key | Does |
| --- | --- |
| `↑` `↓` | Selects a row. |
| `Enter` | Opens the log of the row, full screen. |
| `o` | Opens the log in `$PAGER`. |
| `w` | Checks for work now and skips the pause. |
| `c` | Opens the settings. A save writes the config file for the next iteration. |
| `s` | **Soft stop.** The running agents finish, the merge runs, the run exits. Press again to cancel. |
| `K` | **Hard stop.** Aborts the agents now, without a merge. Asks first. |
| `Ctrl-C` | Lets you choose: soft stop, hard stop, or cancel. |
| `?` | Shows the help. |

**Stops are safe.** After a hard stop the worktrees and the branches stay, and the next run
resumes them.

**Without a terminal**, or with `--batch`, castle-keep prints plain lines, runs up to
`--iterations N` iterations (default 10) and exits when there is no work.

**Before the start**, castle-keep checks the repo: the working tree is clean, `.sandcastle/.env`
holds a token, the GitHub CLI is signed in, and no other run is active. A failed check stops the
start and names the problem.

## Customize

- **Prompts.** The prompts in `.sandcastle/` are yours after setup. They start from the prompts of
  the Sandcastle template. Edit them and `CODING_STANDARDS.md` for your project. They use the
  [prompt syntax of Sandcastle](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/prompts.md):
  `{{KEY}}` arguments and `` !`command` `` expressions.
- **Settings.** Press `c` in the TUI to open the settings window. A save writes the config file,
  and the loop reads it at the next iteration.
- **Your own entry file.** Call the same loop from code, for example `.sandcastle/main.mjs`, and
  run it with `node .sandcastle/main.mjs`:

  ```js
  import { runSandcastle } from "castle-keep";
  await runSandcastle();
  ```

[`examples/config.json`](https://github.com/den-kozlov/castle-keep/blob/main/examples/config.json) is a working config.
[`templates/`](https://github.com/den-kozlov/castle-keep/blob/main/templates) holds the generic prompts that setup copies.

## Reference

<details>
<summary><b>The config file</b></summary>

castle-keep reads `.sandcastle/config.json` before every poll of the tracker and at the start of
every iteration. A missing or broken file keeps the last good read. A broken first read stops the
start and names the field that failed.

Most settings follow the file without a restart. The modules have their own rule:

| Change in the file | When it takes effect |
| --- | --- |
| Roles, prompts, gates, hooks, `env`, `parallelism`, timeouts | At the next read. |
| A plugin is switched **off** | At the next read. From then on the plugin runs nothing: no hook, no gate, no task, no header, no event. |
| A plugin is switched **on**, or its settings change | After a restart. |
| The source or the sandbox changes | After a restart. |

A plugin without an entry in `plugins[]` is never built: it does nothing in a run.

- `source`, `sandbox`, `plugins[]`: `{ "module": "<name>", ...settings }`. Each module declares its
  settings with a `zod` schema ([modules](https://github.com/den-kozlov/castle-keep/blob/main/src/modules.mts)).
- `sandbox`: a [sandbox provider](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/sandbox-providers.md)
  of Sandcastle 0.12: `no-sandbox` (agents on the host), `docker`, `podman`, `vercel`, `daytona`.
  The file holds only data options (image, mounts, networks, CPUs). The SDKs of `vercel` and
  `daytona` (`@vercel/sandbox`, `@daytona/sdk`, installed by you) run on the host. Their keys
  `VERCEL_TOKEN` and `DAYTONA_API_KEY` go in `.sandcastle/.env` or the process environment, never
  in the file.
- `roles`: `planner`, `implementer`, `reviewer`, `merger`, each `{ agent, model, effort? }`.
  `agent` is `claude-code`.
- `prompts`: four paths. `gates`: the commands the reviewer runs. `env`: variables for the agents
  (`${NAME}` and `${NODE_DIR}` expand). `copyToWorktree`: gitignored files to copy into each
  worktree.
- Optional, with defaults: `baseBranch` (`main`), `remote`, `parallelism` (3),
  `commandTimeoutMs` (30 min), `idleTimeoutSeconds` (no limit), `maxPlannerFailures` (3),
  `batchIterations` (10).
- `hooks`: keys `host.<event>`, `sandbox.<event>`, `*.<event>`. Events: `worktreeBuildup`,
  `worktreeTeardown`, `preflight`, `periodic`, `afterMerge`; the last three run on the host only.
  An entry is a script (`.ts`, `.mts`, `.mjs`, `.sh`) or a shell command. A `.ts` or `.mts`
  script runs with `node --import tsx`, so the project needs `tsx`. `periodic` takes
  `{ "run", "interval": "10m", "name"? }`. A hook gets `CASTLE_KEEP_WORKTREE`, `CASTLE_KEEP_TASK`
  and `CASTLE_KEEP_ROLE`. A preflight hook prints `error: …` or `warning: …`. castle-keep passes
  the `worktreeBuildup` hooks to Sandcastle as its own
  [hooks](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/hooks.md).

**Secrets.** Sandcastle puts every key of `.sandcastle/.env` into the sandbox, so the agents see
them. To hide a key from the agents, keep it only in the process environment.

</details>

<details>
<summary><b>Task sources and <code>castle-keep task</code></b></summary>

The task source is the tracker, one per project ([interface](https://github.com/den-kozlov/castle-keep/blob/main/src/source.mts)). The host lists the
ready tasks, hands a task to a human with a reason, and closes it after the merge. Common states:
`ready`, `needs-human`, `needs-triage`, `done`.

Agents reach the source only through the CLI, so the prompts name no tracker:
`npm exec castle-keep -- task <command>`.

| Command | Does |
| --- | --- |
| `view <id> [--json]` | prints the task with its comments |
| `comment <id> --body <text>` or `--body-file <file>` | adds a comment |
| `edit <id> --body-file <file>` | replaces the body (ticks criteria) |
| `create --title <t> --body-file <f> [--state <s>] [--parent <id>] [--follow-up-of <id>]` | files a task |
| `block <id> <blocker>` | makes a task wait for another |
| `needs-human <id> --reason <text>` | hands the task to a human |

- **`github`**: GitHub Issues through [`gh`](https://cli.github.com). Labels are the states
  ([GitHub labels](#github-labels)), sub-issues the parent, issue dependencies the blockers. The
  settings `ready`, `human` and `triage` rename the labels.
- **`local_md`** (`{ "module": "local_md", "dir": ".sandcastle/tasks" }`): one file
  `<number>-<slug>.md` per task, with YAML frontmatter (`title`, `status`, `labels`, `parent`,
  `blocked_by`), the body, and the comments below a line `<!-- comments -->`. A task is ready when
  `status` is `ready` and every blocker is `done`.
- **`beads`**: a [Beads](https://github.com/gastownhall/beads) database through `bd`. The labels
  `needs-human` and `needs-triage` are those states, a closed issue is `done`, `parent-child` is
  the parent, open `blocks` are the blockers.

</details>

<details>
<summary><b>Plugins</b></summary>

Bundled plugins, all opt-in:

- **`github-pr`** (needs the `github` source): a pull request per issue branch and the mirror
  branch `sandcastle/main`, as a record of the diff. Nobody merges there.
- **`claude-limits`** (`fiveHourPercent`, `sevenDayPercent`): holds the agents back at 5h ≥ 90 %
  or 7d ≥ 95 % of the Claude plan window, and shows both meters.
- **`jev`** (`project`, `cheapModel`, `easyThreshold`): asks Jev through
  [OpenRouter](https://openrouter.ai) whether a cheap model can finish a task alone, and picks
  `cheapModel` for the implementer when P(yes) ≥ `easyThreshold` (default 0.9). Needs
  `OPENROUTER_API_KEY`. Without `cheapModel` the plugin does nothing.
- **`graft`** (`sourceDirs`, optional): denies `grep` over the source directories and names the
  [graft](https://www.npmjs.com/package/@nanonets/graft) command instead. Without
  `sourceDirs` it denies only a search of source files by extension (`.ts`, `.mts`, `.rs`, ...).
- **`orca`**: shows worktrees and agent logs on the [Orca](https://github.com/stablyai/orca)
  board.

A plugin is a plain object ([types](https://github.com/den-kozlov/castle-keep/blob/main/src/plugin.mts)) with optional parts: `env`, `hooks`,
`preflight`, `tasks`, `listeners`, and:

- `preStart(input)`: runs before every agent and can change its `model`, `effort`,
  `idleTimeout`, `env` and agent settings, and set a `note` for the agent row.
- `lifecycle`: `iterationStart`, `branchReady`, `mergeDone`, `iterationEnd`, `runEnd`. An error is
  a warning, and the run goes on.
- `gate.check({ step, … })`: asked before every step. A closed gate holds the step, until
  `until` or for a minute.
- `header()`: meters, text and badges for the TUI header.
- `requires: { source }`: the plugin works only with this source.

</details>

<details>
<summary><b>Design</b></summary>

- **The config is data.** One JSON file, kept in the repo and read at every iteration. The TUI
  edits it, a schema checks it, and most changes take effect without a restart. What is special to
  a project goes into hooks, prompts and gates, not into the package.
- **Secrets stay out of the file.** Keys go in `.sandcastle/.env` or the process environment.
- **Four module kinds**, each with a `zod` schema: one task source, one sandbox, one agent per
  role, any number of plugins. The settings window and the wizard draw their forms from these
  schemas.
- **Agents reach the tracker only through `castle-keep task`.** One set of prompts serves every
  source. castle-keep, not the merger agent, closes a merged task.
- **Plugins extend through hooks and gates.** The core names no tool. A tool name appears only in
  the files of its own module, and a test guards that.

</details>

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds `dist/`, then runs the tests next to the sources and a smoke test of the
built package.

This repo runs castle-keep on itself. `npm run castle` builds the package, copies the build to
the gitignored `.sandcastle/run/`, and starts the loop from that copy. So a merge that rebuilds
`dist/` leaves the running loop alone.

## Credits

castle-keep stands on the work of other people:

| Project | Author | What castle-keep takes from it |
| --- | --- | --- |
| [Sandcastle](https://github.com/mattpocock/sandcastle) | [Matt Pocock](https://github.com/mattpocock) | The engine: sandboxes, worktrees, agent runs. The loop and the first version of the prompts. |
| [Skills For Real Engineers](https://github.com/mattpocock/skills) | [Matt Pocock](https://github.com/mattpocock) | The triage labels and the shape of a task. |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Anthropic | The coding agent of every role. |
| [Ink](https://github.com/vadimdemedes/ink) and [React](https://react.dev) | Vadim Demedes; Meta | The TUI. |
| [Zod](https://zod.dev) | Colin McDonnell | The schema of the config and of each module. |
| [GitHub CLI](https://cli.github.com) | GitHub | The access to GitHub Issues and pull requests. |

## License

MIT
