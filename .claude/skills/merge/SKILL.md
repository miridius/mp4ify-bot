---
name: merge
description: Use to merge a PR — only when the user asks — and for everything after the merge. Never raw `gh pr merge`.
---

1. Run `/code-review max main...HEAD` (scope explicit: the default scope
   is empty on a pushed clean branch). Also spawn two agents: one for git
   blame / prior-PR conflicts with the diff, one for CLAUDE.md and
   code-comment guidance compliance. For each finding: fix if you agree
   OR are unsure (fixes go through /commit with its /code-review step skipped —
   this gate re-reviews — then /pr for scoped re-QA). Dismissing REQUIRES
   user approval via AskUserQuestion, no exceptions. Repeat until clean;
   settled findings stay settled.
2. Run `./e2e.sh full`.
3. CI green, then `gh pr merge --merge --delete-branch`.
4. Switch to main, pull, prune stale branches and worktrees.
5. Run `./prod.sh`, then verify the bot is actually up (`docker compose
   ps` + recent prod logs).
