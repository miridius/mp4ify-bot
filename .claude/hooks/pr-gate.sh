#!/bin/sh
# Set the all-pr-skill-steps-passed merge gate, but ONLY with a whole-PR review
# approval bound to the exact commit being gated (see pr-approve.sh). /pr's last
# step runs THIS instead of a raw `gh api ... statuses` call, so the gate is
# impossible to set without /pr's whole-PR review having run clean on this head:
#   - no approval (review skipped / findings left open)  -> refused
#   - approval minted for an earlier commit              -> HEAD mismatch -> refused
#   - pushed head != local HEAD                          -> refused
# The other /pr steps (QA, e2e) are mandated by the skill prose; this script is
# the mechanical backstop for the review, the step most often shortchanged.
set -e
cd "$(git rev-parse --show-toplevel)" || exit 1
marker="$(git rev-parse --git-dir)/.pr-approved"
head=$(git rev-parse HEAD)

[ -f "$marker" ] ||
  { echo "Refused: no whole-PR review approval. Run /pr's review step (it mints one when clean)." >&2; exit 1; }
# generous window: a /pr run does e2e + push + description between mint and here
[ -n "$(find "$marker" -mmin -120 2>/dev/null)" ] ||
  { rm -f "$marker"; echo "Refused: the PR review approval is stale (>2h). Re-review." >&2; exit 1; }
approved=$(cat "$marker")
[ "$approved" = "$head" ] ||
  { rm -f "$marker"; echo "Refused: approval is for $approved, not current HEAD $head. Re-review the new head." >&2; exit 1; }

# the gate must land on the commit GitHub evaluates, which must equal local HEAD
oid=$(gh pr view --json headRefOid -q .headRefOid)
[ "$oid" = "$head" ] ||
  { echo "Refused: pushed head $oid != local HEAD $head. Re-push first." >&2; exit 1; }

gh api -X POST "repos/{owner}/{repo}/statuses/$oid" \
  -f state=success -f context=all-pr-skill-steps-passed -f description="/pr passed" >/dev/null
rm -f "$marker" # consume: the gate is set for this head; a new head needs a fresh review
echo "Set all-pr-skill-steps-passed on $oid."
