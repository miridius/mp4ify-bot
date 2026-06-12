---
name: commit
description: Use for EVERY commit in this repo instead of raw `git commit`, no matter how small the change.
---

1. Stage, run `./check.sh`, fix until green.
2. Run `/code-review high` — report-only, NOT `--fix`: the scope includes
   all unpushed commits, so --fix re-applies fixes you already reverted.
   Apply accepted findings yourself; findings on earlier unpushed commits
   recur — hold prior dispositions.
3. Spawn a `comment-audit` agent on `git diff HEAD`. When in doubt fix —
   dismissals here are never reviewed again.
4. Re-stage everything, then commit.
