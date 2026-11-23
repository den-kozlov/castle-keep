# TASK

Fix task #{{TASK_ID}}: {{ISSUE_TITLE}}

Read it whole, with its comments, its parent and its blockers:
`npm exec castle-keep -- task view {{TASK_ID}}`. Its parent is the PRD of the
feature; read it the same way when there is one.

Only work on the task specified. Work on branch {{BRANCH}}. Make commits and run
the tests.

# CONTEXT

The last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and read what you need for the task: the project docs, the
code the task touches and above all the test files around it. Follow the names
and the decisions the project already records.

# EXECUTION

If it applies, work red-green-refactor:

1. RED: write one test.
2. GREEN: write the code that passes it.
3. REPEAT until the task is done.
4. REFACTOR.

Stay inside this worktree. Never deploy.

# FEEDBACK LOOPS

Before you commit, run the gates of the project: the `gates` list of
`.sandcastle/config.json`. All must pass.

# COMMIT

Make a git commit on `{{BRANCH}}`. Do not push and do not open a pull request.
The message:

1. is in the Conventional Commits format, for example `fix(parser): drop the stale token`;
2. names the task: `Refs #{{TASK_ID}}` (not `Closes`: the merger closes it);
3. is short; key decisions and blockers go in the body, one line each.

# ACCEPTANCE CRITERIA

The human reads the checkboxes of the task to see what is done. Tick each
criterion you checked, in the task body itself:

1. Find the checkbox list (`- [ ]`) under «Acceptance criteria», «Done when» or
   the like. When it has plain bullets, make each a checkbox (`- ` to `- [ ] `)
   and change nothing else.
2. Tick a criterion (`- [ ]` to `- [x]`) only when you checked it yourself on
   this branch: a test that covers it passes, a command it names ran and gave
   what it asks, or you read the code that does it. A criterion for the owner,
   or one you could not check, stays `- [ ]`.
3. Behind a criterion that a follow-up task carries, add ` → #<new>` and leave
   it unticked.
4. Read the body fresh just before you write it, change only the checkbox marks
   and those additions: `npm exec castle-keep -- task view {{TASK_ID}} --json`,
   take the `body` into a file, edit the file, then
   `npm exec castle-keep -- task edit {{TASK_ID}} --body-file <file>`.
5. Your last comment on the task lists each criterion you ticked with its proof
   in one short line: the test name, or the command and its result.

Do not tick a criterion because the code looks right; tick it because you
checked it. Do not end with `COMPLETE` while a criterion is unticked and no
follow-up task carries it.

# THE TASK

When the task is not complete, leave one short comment with what was done and
what is left: `npm exec castle-keep -- task comment {{TASK_ID}} --body-file <file>`.

Do not change the state of the task and do not close it: the harness and the
merger do that from the signal you end with.

A comment is not read until a human opens the task. Whatever someone has to do
after you goes into a follow-up task, never only into a comment:

- `npm exec castle-keep -- task create --title "<title>" --state <state> --body-file <file> --follow-up-of {{TASK_ID}}`
  (add `--parent <prd>` when this task has a parent). The body says what to do
  and how to tell it is done. When the new task waits for an open one:
  `npm exec castle-keep -- task block <new> <n>`.
- State `needs-human` when only the human can do it (a decision, data, an
  action no agent may take); `ready` when an agent can do it later;
  `needs-triage` for a new problem you found that the task did not ask about.
- Name the new task in your comment on this one.

End every pass with exactly one of these signals:

- `<promise>COMPLETE</promise>`: the task is done. Work handed to follow-up
  tasks counts as done.
- `<needs-human>one line: what you need from the human</needs-human>` and then
  `<promise>NEEDS-HUMAN</promise>`: this task cannot go on without the human (a
  decision the task, its PRD and the docs do not make; data only the human has).
  Write the question in a comment on the task first. The harness merges your
  commits and hands the task to the human.

A pass that ends without a signal starts another pass on the same branch. End
that way only when work is left that the next pass can do; never to wait for a
human.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
