---
name: commit
description: Use for EVERY commit in this repo instead of raw `git commit`, no matter how small the change.
---

Run every step, every time: they exist because you skip them when you judge
them "unnecessary," and that judgment is the failure they remove. Re-stage
after applying a fix in ANY step, so the commit is exactly what was reviewed.

1. Stage, run `./check.sh`, fix until green (review is wasted on code that
   still fails the mechanical gates).
2. Run `/code-review high --fix --cached`. `--cached` scopes it to the staged
   change, so `--fix` can't resurrect fixes you reverted on earlier commits.
   Keep its fixes; revert any you can see are wrong. Skip a finding ONLY as a
   false positive: the reviewer misread the code. A real finding you'd rather
   not fix (including "it's working as intended", where "intended" means the
   user specified the behaviour, not your inference) is NOT a skip: fix it, or
   if it turns on what the user wants and you're unsure, AskUserQuestion. Don't
   relabel a dismissal as a false positive to dodge the work.
3. Spawn a `comment-audit` agent on the staged diff and fix what it flags.
   You are repeatedly wrong about your own comments, so this is not skippable.
4. Re-stage all fixes, then spawn a fresh, no-prior-context **review-attestation
   agent** on the final `git diff --cached`. Give it the change plus the findings
   from steps 2–3 and have it (a) confirm every finding is genuinely addressed and
   (b) re-scan the post-fix diff for any new correctness issue a fix introduced. It
   returns PASS or a findings list. On findings: fix them, re-stage, and re-run
   this step (a fresh agent each time). ONLY on PASS does the agent, as its last
   action, run `./.claude/hooks/review-approve.sh`, minting a content-bound
   approval of the exact staged snapshot. You do not mint it yourself; minting
   despite open findings is the failure this step exists to remove.
5. `git commit` with NO further `git add`: the pre-commit gate rejects any
   re-stage after the mint as not-what-was-approved. If you must change anything
   after the mint, re-run step 4.
