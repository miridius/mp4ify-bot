#!/bin/sh
# git pre-commit gate. A commit is allowed only with a FRESH approval whose hash
# binds to the EXACT staged snapshot (see review-approve.sh + stage-id.sh). So an
# approval can't be inherited across changes, reused after a re-stage, or stand in
# for a direct `git commit` that minted none. It does NOT by itself prove a review
# happened: that is the /commit skill's job; what it guarantees is that the
# approval is un-inheritable and un-skippable, turning an omitted review into a
# deliberate, visible bypass rather than a silent omission. Defeatable only via the
# explicit --no-verify / SKIP_SIMPLE_GIT_HOOKS escapes, which /commit never uses.
cd "$(git rev-parse --show-toplevel)" || exit 1
. ./.claude/hooks/stage-id.sh
marker="$(git rev-parse --git-dir)/.commit-approved"

fail() {
  rm -f "$marker"
  echo "Blocked: $1" >&2
  echo "Commit through the /commit skill: it reviews the staged change and a" >&2
  echo "fresh attestation agent mints a content-bound approval before committing." >&2
  exit 1
}

[ -f "$marker" ] || fail "no review approval for this commit."
# the approval authorizes one attempt within 5 min of the review (it is minted as
# the last step right before `git commit`, so the window is normally seconds)
[ -n "$(find "$marker" -mmin -5 2>/dev/null)" ] || fail "the review approval is stale (>5 min)."

want=$(cat "$marker")
rm -f "$marker" # consume up front: one approval authorizes one attempt, pass or fail
have=$(stage_id) || fail "could not hash the staged tree (unmerged index?)."
[ "$want" = "$have" ] || fail "the staged change differs from what was reviewed and approved."

exec ./check.sh
