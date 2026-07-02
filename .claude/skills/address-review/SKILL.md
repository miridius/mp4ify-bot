---
name: address-review
description: Use when I ask you to address the review comments I left on my own PR. Pull them, triage with me, then fix only what I approve.
---

The comments are mine, written to you. This skill exists because you tend to
read a comment, guess what I meant, and fix the guess, so it forces the
pulling, the triage, and my approval to happen before any code changes.

1. Pull EVERY comment, including pending (draft) ones. A draft review's inline
   comments are invisible to `gh pr view` and to `.../pulls/{n}/comments`; only
   `gh api repos/{owner}/{repo}/pulls/{n}/reviews` then
   `.../reviews/{id}/comments` shows them, and only to the review's author (here,
   you, since it's your own PR). Miss this and you'll silently address half the
   review. Read the review body too, not just the inline threads. If there are
   genuinely none, say so and stop; don't invent work.

2. Triage WITH me, comment by comment: do not start fixing. For each: if it's a
   question, answer it (to me, in chat, not as a PR reply); if it's unclear or
   conflicts with another comment, ask; if it's a design fork, interview me
   relentlessly until the choice is mine, not yours. You lean toward the
   least-work reading, and a comment I left to force a decision must not get
   resolved that way. Then propose an approach for each and show me.

3. Only AFTER I accept the proposal, make the changes. Fix every accepted comment
   now; defer only the ones I explicitly tell you to defer, and don't
   manufacture a code change for a comment I resolved by just answering. Do the
   fixes as `/commit` commits, then one `/pr` at the end, not per comment. You
   never set the `/lgtm` gate; I re-approve after the fixes.

4. End with a table: every comment, and how it resolved (fixed / deferred /
   answered / acknowledged / dismissed; the last only on my explicit say-so).
   It's the proof I can scan that nothing was silently dropped.
