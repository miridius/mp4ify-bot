---
name: merge
description: The only way to merge a PR, and what happens after — final code-review gate (dismissals require explicit user approval), merge, cleanup, deploy.
---

Run only when the user has reviewed the PR and asked for the merge.

## 1. Final review gate

Run `/code-review max main...HEAD` — scope pinned explicitly (the
default scope, commits ahead of upstream plus uncommitted changes, is
EMPTY once the branch is pushed and clean, which it always is here) and
effort pinned so the gate doesn't vary with the session's /effort
setting. max surfaces uncertainty-labeled findings; the fix-if-unsure
rule below absorbs them. In parallel, spawn two agents covering lenses
/code-review lacks:

- **History**: read the git blame and prior PRs touching the modified
  files; flag changes that conflict with that context.
- **Guidance compliance**: check the diff against CLAUDE.md and against
  guidance in code comments of the modified files.

For every finding from any of the three:

- **Fix it** if you agree or are unsure. Gate fixes go through /commit
  with its review step skipped — this gate's own repeat is the
  authoritative re-review — and through /pr scoped to re-QA of what the
  fix touches; wait for CI.
- **To dismiss it**, you MUST present the finding together with your
  refuting evidence to the user via AskUserQuestion and receive explicit
  approval. There are no self-service dismissals at this gate — this is the
  one place a human signs off on every dropped finding.

Repeat until all three come back clean or every finding is dispositioned.
Settled findings (fixed, or dismissed with user approval) are not
re-litigated on repeat.

## 2. Full e2e gate

Run `./e2e.sh full` — the full set includes youtube, which is excluded
from the per-push reduced set because it rate-limits frequent hits. This
is the only pre-merge stage that exercises it.

## 3. Merge

Confirm CI is green and the PR is mergeable, then:
`gh pr merge <n> --merge --delete-branch`

## 4. Cleanup

- Switch to main (or the worktree that holds it) and `git pull`.
- `git fetch --prune`; delete the merged local branch if it survived.
- `git worktree prune`, and remove any worktrees the work no longer needs.

## 5. Deploy

Run `./prod.sh`. It re-runs the full e2e gate against the merged main
(redundant with step 2 when main hasn't moved, but it revalidates the
actual deploy artifact and two youtube hits per merge stays within its
tolerance), then rebuilds and restarts prod. Afterwards confirm the bot is
actually up: `docker compose ps` and a clean recent `docker compose logs
prod`.
