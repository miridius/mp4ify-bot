---
name: pr
description: The only way to open or update a PR — manual QA on the dev bot, then a description written to standard and audited cold. Re-run whenever the branch changes after a review or QA pass.
---

Per-commit code review is /commit's job; this skill owns everything
PR-shaped. Re-running it after the branch changes is not optional — a QA
pass or review of stale code is worth nothing.

## 1. Manual QA on the dev bot

The dev container hot-reloads the working tree, so @dev_mp4ify_bot is
already running this branch. Do not switch branches while QA is in
flight — the bot serves whatever the tree holds.

- Derive a checklist from the PR's user-visible changes. Include failure
  paths, not just happy paths — set up fixtures deliberately (e.g. poison a
  cache entry, pick a video sized to cross a limit).
- Exercise each case by messaging the dev bot: via web.telegram.org with the
  browser tools when a logged-in session is available, otherwise hand the
  user the checklist with exact links/messages to send.
- Watch `docker compose logs dev` while each case runs; verify the log path
  taken, not just the chat-visible outcome.
- Findings → fix → /commit → re-test the broken case. On re-runs of this
  skill after a fix, QA may be scoped to the cases the change touches.

## 2. PR description

Draft (or refresh) the title and body. A PR is a pitch to a reviewer with
zero prior knowledge: convince them it should be merged. Describe what it
does and why, or what problem it solves and how. For every line ask: does
this change the merge decision, or is it TMI? Assume nothing from your own
context — no session jargon, no codenames, no issue shorthand without
links. Structure: Problem (user-visible symptom first, then mechanism) →
Fix. Never include self-review narration (what reviews ran, what was fixed
before the PR opened). Always surface the genuine open decisions the
reviewer must weigh in on.

## 3. Cold-context audit

Spawn ONE fresh general-purpose agent with the full `git diff main...HEAD`,
the draft title/body, and the audit instructions below verbatim. The author
cannot audit their own prose — confidence in it is the failure mode. Fix
every confirmed violation.

### Audit instructions (pass to the agent verbatim)

You are auditing a PR diff and its draft description. You have no other
context about this work; that is deliberate — read everything as a stranger
would. Report only violations, each with a quote and a suggested rewrite.
The description is a pitch to a reviewer with zero prior knowledge.
Violations:

- The problem is missing, vague, or stated in project/session jargon a
  stranger can't follow.
- Claims about production behavior ("this crashes", "users hit X") with no
  stated evidence. Unobserved mechanisms must be labeled as latent/found by
  review.
- Self-review narration (what reviews ran, what was fixed pre-PR) — the
  reviewer sees only the final diff; this is noise.
- Missing open decisions: if the diff contains judgment calls (tunable
  values, accepted trade-offs, behavior changes a reasonable reviewer might
  push back on), the description must name them and ask.

## 4. Open or update

Push, then `gh pr create` — or if the PR exists, update its body and
re-request review.
