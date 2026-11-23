# TASK

Review the changes on branch `{{BRANCH}}` and improve their clarity,
consistency and maintainability while keeping the behaviour exact.

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change.** Read the diff and the commits. Read task #{{TASK_ID}}
   with its comments for what was asked: `npm exec castle-keep -- task view {{TASK_ID}}`;
   it names the parent, the PRD; read it the same way when there is one.

2. **Check the architecture first.** Judge the shape of the solution before its
   details. Read the project docs and decision records. Ask:
   - Does it follow the layering, the vocabulary and the decisions the project records, or route around them?
   - Does it add a module, abstraction or data field that an existing one already covers?
   - Is there a clearly better shape that the next tasks will need? Would you be glad to see this shape copied by the next agent?

   Block only for a wrong shape, not for a detail you can fix. When the shape is
   wrong, **do not rewrite it**: the design belongs to a human. Instead:
   - Comment on the task: `npm exec castle-keep -- task comment {{TASK_ID}} --body-file <file>`. Name the wrong shape, the decision or seam it breaks, and the shape you propose, with file paths.
   - Touch no code and commit nothing. The harness hands the task to a human; do not change its state yourself.
   - End with the verdict `blocked` (see OUTPUT).

   When the shape is sound, keep the strongest block candidate you weighed and
   why it passed: the OUTPUT note names it. Then go on.

3. **Look for improvements**: less nesting and complexity, no redundant code,
   clear names, related logic together, no comment that restates the code.
   Prefer clarity over brevity.

4. **Check correctness.** Does the code match the intent of the task? Are the edge
   cases handled? Do tests cover each new or changed behaviour? Does the change
   leak a credential or open another security hole?

5. **Keep balance.** Do not simplify so far that clarity drops, a helpful
   abstraction goes, or too many concerns merge into one function.

6. **Apply the project standards** of @.sandcastle/CODING_STANDARDS.md.

7. **Preserve functionality.** Change how the code does it, never what it does.

8. **Check what is left for others.** A comment is not read until a human opens
   the task. When a comment leaves work for a human or a later agent and no
   follow-up task carries it, file one: `npm exec castle-keep -- task create --title "<title>" --state <state> --body-file <file> --follow-up-of {{TASK_ID}}`
   (add `--parent <prd>` when the task has a parent), state `needs-human` (only
   the human can do it), `ready`, or `needs-triage` (a new problem the task did
   not ask about). The body says what to do and how to tell it is done. When it
   waits for an open task: `npm exec castle-keep -- task block <new> <n>`.

9. **Check the ticked criteria.** The implementer ticks (`- [x]`) each criterion it
   checked and lists the proof of each in its comment. For each ticked criterion
   confirm the proof: the test exists and covers it, the command result is in
   the comment, the code does it. Untick (`- [x]` to `- [ ]`) a criterion whose
   proof fails or is missing, and name it with the reason in one comment. Tick
   one only when you checked it yourself. Edit the body as the implementer
   does: read it fresh (`npm exec castle-keep -- task view {{TASK_ID}} --json`,
   the `body` into a file), change only the checkbox marks,
   `npm exec castle-keep -- task edit {{TASK_ID}} --body-file <file>`. A
   criterion unticked and with no follow-up task (` → #N`) is work left: file
   the follow-up as in step 8.

# EXECUTION

When you find improvements:

1. Make the changes on this branch.
2. Run the checks:

{{CHECKS}}

3. Commit, describing the refinements.

Never deploy. When the code is already clean, do nothing.

# OUTPUT

Your last message states the architecture verdict on its own line, exactly one of:

<architecture>sound</architecture>
<architecture>blocked</architecture>

`blocked` keeps the branch out of the merge and hands the task to a human. Use
it only after you left the comment on the task.

On `sound`, write exactly one note tag on its own line before the verdict:

<architecture-note>…</architecture-note>

The note is one sentence of at most about 200 characters: the one shape
question you weighed most seriously and why the shape passed. When nothing was
worth weighing, say so: "No shape question: the diff is a test-only change."
Do not write the note into the task.

Once complete, output <promise>COMPLETE</promise>.
