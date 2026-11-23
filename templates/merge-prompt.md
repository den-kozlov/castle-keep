# TASK

Merge these branches into the current branch:

{{BRANCHES}}

Each branch already passed the gates on its own base, so merge them all first
and run the gates once at the end:

1. For each branch run `git merge <branch> --no-ff --no-edit`. Always `--no-ff`:
   every branch lands as a merge commit. Merge the last branch with the summary
   of the whole merge as its message: `git merge <branch> --no-ff -m "<summary>"`.
2. On a conflict, read both sides and resolve it so that both changes keep
   working. Do not build between branches.
3. After the last branch, run the gates once; they are in `.sandcastle/config.json`
   under `gates`.
4. When a gate fails, find from the error which branches it involves
   (`git log --first-parent`, `git blame`); do not check out older commits in
   this checkout. Fix it in a commit of its own on the current branch, then run
   the gates again until they pass.

Do not push and do not deploy. Merge into the local branch only. The last merge
commit carries the summary: make no separate summary commit.

The branch list may be `- (none)`: an earlier run merged everything. Then merge
nothing.

# TASKS

Do not close any task: the harness closes each merged task after you. The tasks
of the branches you merge:

{{ISSUES}}

# MERGE, BUT LEAVE OPEN

The implementers of these tasks asked for a human. Merge their branches like the
others, but do not close the tasks and do not touch their state; the harness
hands them to a human after you:

{{HUMAN_ISSUES}}

# ALREADY MERGED

An earlier run merged these branches before it was stopped. Do not merge them
again; the harness closes their tasks:

{{MERGED_ISSUES}}

When everything that can be merged is merged, output
<promise>COMPLETE</promise>.
