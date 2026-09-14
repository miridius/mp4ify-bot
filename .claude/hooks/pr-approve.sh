#!/bin/sh
# Mint the whole-PR review approval that pr-gate.sh requires before it will set
# the all-pr-skill-steps-passed merge gate.
#
# Run this ONLY from /pr's whole-PR review step, and ONLY after a fresh
# attestation agent found no unaddressed findings in the FULL PR diff. It binds
# to the current HEAD commit, so any later commit (e.g. fixing a finding) changes
# HEAD and invalidates it, forcing the whole-PR review to re-run on the new head
# before the gate can be set. That is the "gate can't be inherited" rule, made
# mechanical rather than self-policed.
set -e
cd "$(git rev-parse --show-toplevel)" || exit 1
head=$(git rev-parse HEAD)
printf '%s\n' "$head" > "$(git rev-parse --git-dir)/.pr-approved"
echo "Whole-PR review approval minted for HEAD $head."
