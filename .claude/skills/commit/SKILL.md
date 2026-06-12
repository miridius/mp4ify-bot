---
name: commit
description: The only way to commit in this repo — use instead of raw `git commit` for every commit. Fast gates, simplify, scoped review of the pending diff, then commit.
---

Run for every commit, no matter how small. Do not skip a step because the
change seems trivial — that judgment is what this skill exists to remove.

1. Stage the changes (`git add`).
2. Run `./check.sh` (lint with warnings fatal, gitleaks, unit tests). Fix
   until green — review effort is wasted on code that fails mechanical gates.
3. Run `/simplify` (built-in; quality-only review that applies its fixes —
   bug-hunting is /merge's `/code-review`). Keep the fixes you agree with;
   if code changed, re-stage and re-run `./check.sh`.
4. Review the pending diff — just this commit, not the whole branch. Spawn
   in parallel:
   - the pr-review-toolkit `code-reviewer` agent on `git diff HEAD`, and
   - a general-purpose agent with `git diff HEAD` plus the comment standards
     below, verbatim.
   Fix the findings you agree with. Findings you dismiss here are dropped
   — they only reach the human gate if the /merge review gate re-finds
   them — so when in doubt, fix or surface it in the PR's open decisions.
5. Re-stage everything (`git add`) so the commit contains exactly what was
   tested and reviewed, then `git commit`. The pre-commit hook re-runs the
   mechanical gates as a backstop; the reduced e2e suite runs on push. If a
   gate fails, fix and return to step 2.

### Comment standards (pass to the auditing agent verbatim)

You are auditing a diff with no other context about the work; that is
deliberate — read it as a stranger would. Report only violations, each with
file:line and a suggested rewrite.

A comment may only state a constraint the code cannot show: an external
fact (a library's hidden behavior, a remote API quirk) or the why of a
deliberately surprising choice. Violations:

- Narrates what adjacent code does, or restates a log/assertion next to it.
- Past-tense history or change-justification ("used to", "previously",
  "now we", "fixed", referencing a bug story). That belongs in git/PR.
- Guards a behavior that a test could pin instead. Check the diff's tests:
  if the constraint is testable and untested, the fix is a test, not a
  comment. A comment survives alongside a test only where the code locally
  reads as a mistake (error swallowing, odd ordering) — then one terse line.
- Multi-line essays where the codebase idiom is terse one-liners.
- States something as observed fact (in production, in the wild) that is
  actually an unverified inference.
