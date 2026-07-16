---
name: pr
description: Use to open or update ANY PR. Re-run whenever the branch changes: its last step clears the merge gate, which must sit on the exact commit being merged.
---

This is the merge gate: its final step clears `all-pr-skill-steps-passed`,
which GitHub requires before merge. A green gate means /pr's QA, review, and
e2e all ran on the exact commit being merged; the status is per-commit, so any
later commit invalidates it.

Every /pr runs every step in full, over the whole PR, even when you are sure
parts are unchanged, frozen, or already reviewed. A bare "never scope it down"
keeps losing to your own rationalizations, so here is why it genuinely holds:

- **Second pair of eyes.** The review subagents reliably find real bugs in code
  you were certain was correct, and your certainty is itself the blind spot, so
  the times you're surest no review is needed are exactly the ones it exists for.
  Reviewing your own diff and clearing your own gate amounts to squash-merging to
  main unreviewed.
- **The gate can't be inherited.** It certifies the *exact* commit that merges.
  A green gate on an earlier commit certifies nothing about HEAD and never
  carries forward: "already validated at the last gate" or "the delta since it
  is only docs" names a *different commit* that nothing has validated.
- **Cost is not a license to scope.** Whatever the review costs in time or
  tokens never justifies narrowing it: "expensive", "mostly unchanged",
  "doc-only", or "I'll re-run it later anyway" are work-avoidance, not reasons.
  Catching yourself building one of those arguments IS the cue to run the full
  pass, and asking the user whether to scope or skip is that same avoidance
  wearing a polite face. Don't ask; run it.

The ask wears disguises: close them all. Putting the choice to run a step to
the user as a question, a recommendation, a "checkpoint", or a status-with-a-
fork is the SAME violation, however worded ("full review vs. skip the tiny
delta?", "re-run or hand off?", "how do you want to clear the gate?"). A small
or already-reviewed delta is the case the no-inherit rule is FOR, not an
exception to it. It is also futile: pr-gate.sh won't stamp without a fresh
whole-PR attestation bound to the exact HEAD, so no green-gate path skips the
review. The only thing you ever put to the user during /pr is a step-3 finding-
triage decision. Anything about whether/how/how-much to run a step: act, don't
ask.

Other than the step-1 tidy (a content-identical squash), `/pr` validates the
committed HEAD without changing it: a failing step in 2–6 STOPS `/pr` rather
than fix-committing, and `/pr` never loops on itself. Fix those out-of-band
with `/commit` once any open questions are settled, then start a fresh `/pr`.

First, require a clean tree (`git status --porcelain` empty). /pr QAs the
working tree but gates the committed HEAD, so a dirty tree would vouch for code
GitHub won't merge. If it's dirty, STOP and have the user `/commit` or stash.

1. Tidy the branch into the single commit that should merge: these PRs are one
   change, so the merge shouldn't carry the review loop's blow-by-blow (`fix
   finding`, `trim comment`, `pin why`). If `main..HEAD` is already one commit,
   it's tidy; go to step 2. Otherwise squash with a REBASE (write the
   merge-worthy message to `/tmp/squash-msg` first):

       GIT_SEQUENCE_EDITOR='sed -i "2,\$ s/^pick/squash/"' \
       GIT_EDITOR='cp /tmp/squash-msg' \
       git rebase -i "$(git merge-base main HEAD)"

   Git never runs the pre-commit hook during a rebase (even one that
   manufactures content, hence the guard below), so the gate can't catch a bad
   squash; the squash needs no re-review only because it is content-identical,
   which YOU verify with `git diff ORIG_HEAD HEAD` (rebase sets ORIG_HEAD to
   the pre-rebase head; the diff must be empty). If the rebase stops on a
   conflict (a branch that merged main can do this), or the verify diff is
   non-empty, `git rebase --abort` and STOP: hand-resolving mid-rebase
   manufactures content no review ever saw. Never squash via `git reset` +
   recommit either: that manufactures a brand-new commit, which the commit
   gate blocks, and routing it through `/commit` to compensate just
   duplicates, at lower effort, the whole-PR review that step 3 runs on this
   same content minutes later. Do this FIRST, before QA/review/e2e: it
   rewrites HEAD, and the attestation (step 3) and the gate (step 6) bind to
   the *exact* HEAD; tidy after them and you void their certification and
   merge an unvalidated commit.
2. QA every user-visible change against the live dev bot (it serves the
   working tree, so don't switch branches mid-QA). Build fixtures for the
   failure paths, not just the happy path (e.g. poison a cache entry): that's
   where the bugs your tests miss live. Verify the path taken in `docker
   compose logs dev`, not just the chat outcome. Drive the bot via
   web.telegram.org with the browser tools; if no session is logged in, ask
   the user to log in. QA the whole PR every run, not just what changed (the
   reasons above apply here too).
3. Review the PR three ways, on the WHOLE PR diff, never a subset. Two whole-PR
   specifics beyond the three reasons above: cross-commit bugs (duplication, bad
   interactions) only surface in whole-PR context, and xhigh reviews at higher
   recall than the per-commit `high` pass. The three: `/code-review xhigh` (no
   scope arg; it reviews the PR), a `comment-audit` agent, and a
   `rules-compliance` agent (not
   redundant; `/code-review` does NOT read CLAUDE.md or `.claude/rules/`).
   Triage every finding into exactly one of these (the bias is FIX):
   - A real bug → the PR isn't ready: STOP, fix it out-of-band with `/commit`,
     then a fresh `/pr`. Fix every one, never a chosen subset; "out-of-scope"
     and "pre-existing" are not triage categories. Don't ask permission to fix
     a bug, UNLESS the fix would change behavior the user deliberately
     SPECIFIED or a documented design decision, which is the design bucket below.
   - Empirically refuted (you can SHOW it's not a bug): cite the line the
     reviewer misread, or a type/constant that makes it impossible, or run it.
     Drop it yourself, no ask. A guard you merely THINK covers the case, or any
     judgment call, is NOT proof: that's the ask bucket. If the same false
     positive resurfaces in a later review the code is unclear: out-of-band (via
     `/commit`), add a comment or test that pins the real behavior so it stops
     being re-flagged.
   - Deciding NOT to fix a real finding without that proof: "works as intended"
     (your inference, not something the user SPECIFIED), "rare", "acceptable",
     "documented elsewhere" → AskUserQuestion. This is the work-avoidance case;
     asking is its only legitimate form, never silent skipping. A wrong
     dismissal ships at the irreversible merge, so the user signs off, not you.
     (A finding the user already dismissed stays dismissed.)
   - A fix that would change user-SPECIFIED behavior or a documented design
     trade-off (e.g. altering delivery semantics) → AskUserQuestion: that's the
     user's call, even when the finding is real.
   - Compliance findings ALWAYS go to AskUserQuestion: a rule may be the thing
     that's wrong, not the code.

   Continue only when every finding is fixed, empirically refuted, or
   user-dismissed. Then spawn a fresh, no-prior-context **whole-PR attestation
   agent** on the full PR diff: it independently confirms no unaddressed finding
   remains and, ONLY on PASS, runs `./.claude/hooks/pr-approve.sh` to mint a
   review approval bound to the current HEAD. You do not mint it yourself. (Any
   later commit changes HEAD and voids it, so a fix forces a fresh `/pr`.)
4. Run `./e2e.sh full`: it exercises the real bot/yt-dlp/filesystem seams that
   QA and unit tests stub out; without it a green gate vouches for an
   integration nothing actually ran. (Run it even when the source looks
   unchanged: the real yt-dlp self-updates, so the integration can drift under
   byte-identical code.)
5. Push the branch. Then write/update the PR description, a pitch to a
   zero-context reviewer: lead with the user-visible Problem, then the Fix; no
   open decisions (if one is unsettled, AskUserQuestion and resolve it first).
   Have a fresh-context `pr-description-audit` agent check the diff against the
   draft and fix the DRAFT (prose only; editing the description isn't a code
   fix-commit); you can't audit your own prose. Create or update with
   `gh pr create` / `gh pr edit`.
6. ONLY now (with 1–5 green) clear the gate by running
   `./.claude/hooks/pr-gate.sh`. Do NOT hand-stamp the status with a raw
   `gh api` call: that bypasses the HEAD-bound approval check the script exists
   to enforce. Last step: a later commit changes HEAD and voids both the gate and
   the approval.
