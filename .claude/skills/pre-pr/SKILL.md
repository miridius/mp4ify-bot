---
name: pre-pr
description: Mandatory gate before opening any PR. Runs both review skills, then a cold-context audit of code comments and the PR description. Use when a branch is ready to become a PR.
---

Run these steps in order, on the current branch, before `gh pr create`. Do not
skip a step because the change seems small or the step seems unnecessary —
that judgment is exactly what this gate exists to remove.

## 1. Review skills

1. Run `/pr-review-toolkit:review-pr`. Fix every finding you agree with;
   dismiss with evidence the ones you don't. Never post findings as comments.
2. Run `/code-review --fix`.

## 2. Cold-context audit

Draft the PR title and body, then spawn ONE fresh agent (Agent tool,
subagent_type: general-purpose) with: the full `git diff main...HEAD`, the
draft title/body, and the audit instructions below verbatim. The author
cannot audit their own prose — confidence in it is the failure mode. Fix
every violation the auditor confirms, re-running step 1's test gates if code
changed.

### Audit instructions (pass to the agent verbatim)

You are auditing a PR diff and its draft description. You have no other
context about this work; that is deliberate — read everything as a stranger
would. Report violations of the following, each with file:line (or
description quote) and a suggested rewrite. Report only violations, not
praise.

**Code comments.** A comment may only state a constraint the code cannot
show: an external fact (a library's hidden behavior, a remote API quirk) or
the why of a deliberately surprising choice. Violations:
- Narrates what adjacent code does, or restates a log/assertion next to it.
- Past-tense history or change-justification ("used to", "previously",
  "now we", "fixed", referencing a bug story). That belongs in git/PR.
- Guards a behavior that a test could pin instead. Check the diff's tests:
  if the constraint is testable and untested, the fix is a test, not a
  comment. A comment survives alongside a test only where the code locally
  reads as a mistake (error swallowing, odd ordering) — then one terse line.
- Multi-line essays where the codebase idiom is terse one-liners.

**PR description.** It is a pitch to a reviewer with zero prior knowledge.
Violations:
- The problem is missing, vague, or stated in project/session jargon a
  stranger can't follow ("the baseline review", codenames, issue shorthand
  without links).
- Claims about production behavior ("this crashes", "users hit X") with no
  stated evidence. Unobserved mechanisms must be labeled as latent/found by
  review.
- Self-review narration (what reviews ran, what was fixed pre-PR) — the
  reviewer sees only the final diff; this is noise.
- Missing the genuine open decisions a reviewer must weigh in on, if the
  diff contains any judgment calls.

## 3. Open the PR

Only after steps 1–2 are clean: push and `gh pr create`.
