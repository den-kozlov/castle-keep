# TASKS

Here are the open tasks:

<tasks-json>

{{ISSUES_JSON}}

</tasks-json>

The list is already filtered to tasks that are ready for work, with every
blocker closed. `id` is the id of a task. `parent`, when set, is the PRD of its
feature, another task; read it with `npm exec castle-keep -- task view <id>`
when the bodies alone do not tell you what overlaps.

# TASK

Build a dependency graph of these tasks. Task B is **blocked by** task A when:

- B needs code or infrastructure that A introduces;
- B and A change overlapping files or modules, so work in parallel would
  conflict when merged;
- B depends on a decision or an API shape that A will set.

A task is **unblocked** when no other open task blocks it.

For each unblocked task give the branch `sandcastle/issue-{id}`, where `{id}` is
the `id` field as given, for example `sandcastle/issue-42` (no slug or other
suffix). The name is deterministic, so planning the same task again keeps the
progress already on its branch.

# OUTPUT

Output the plan as JSON inside `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix the login form", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked tasks. When every task is blocked, include the one
candidate with the fewest or weakest dependencies.

Always emit the `<plan>` tags. With nothing to do, output `<plan>{"issues": []}</plan>`.
