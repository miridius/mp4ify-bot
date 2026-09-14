---
name: merge
description: Use to merge a PR (only when the user asks) and for everything after the merge.
---

The PR's review, QA, and e2e all happen in `/pr` (which clears
`all-pr-skill-steps-passed`); the user's `/lgtm` clears `human-approved`.
GitHub blocks the merge until both of those plus the CI `test` check are green,
so `/merge` does NOT re-review: it merges and deploys.

1. Confirm the PR is mergeable: `gh pr view --json mergeStateStatus`. It must
   be `CLEAN`. `BLOCKED` means a required check (`test`,
   `all-pr-skill-steps-passed`, `human-approved`) is failing OR not yet posted,
   and a never-posted gate is *absent*, not red, so don't trust `gh pr
   checks` showing "all green". On `BLOCKED`, STOP and fix the specific gap
   (`gh pr view --json statusCheckRollup` shows what's set): `test` failing →
   CI is broken, fix the code; `all-pr-skill-steps-passed` absent → re-run
   `/pr`; `human-approved` absent → ask the user to `/lgtm`. Any other non-`CLEAN`
   state (`DIRTY` conflicts, `BEHIND` base moved, `UNSTABLE` a non-required
   check red): resolve it and retry; don't force it. NEVER set
   `human-approved` yourself: it is the user's gate, and setting it forges
   their sign-off.
2. `gh pr merge --squash --delete-branch`: the repo only allows squash
   merges, so `--merge` is rejected (405).
3. Switch to main, pull, prune stale branches and worktrees, so the next
   branch forks from the just-merged commit, not a stale local main, and
   leftover worktrees don't shadow it.
4. Run `./prod.sh`, then confirm the bot is up: `docker compose ps` and a
   clean recent `docker compose logs prod`. Deploying is the point of the
   merge, and a prod that fails to boot is the failure this catches.
