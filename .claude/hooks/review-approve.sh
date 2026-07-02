#!/bin/sh
# Mint the content-bound review approval that commit-gate.sh requires.
#
# Run this ONLY from /commit's review-attestation step, and ONLY after a fresh
# review of the staged change found no unaddressed findings. The marker asserts
# "this exact staged snapshot was reviewed and is clean." It must be the LAST
# action before `git commit`: anything re-staged afterwards moves the tree SHA,
# and the gate will (correctly) reject the commit as not-what-was-approved.
set -e
cd "$(git rev-parse --show-toplevel)" || exit 1
. ./.claude/hooks/stage-id.sh

if git diff --cached --quiet; then
  echo "Nothing staged; stage the change before minting an approval." >&2
  exit 1
fi

# Compute the id FIRST: stage_id returns nonzero if the index can't be hashed, so
# set -e aborts here and no marker is written (fail closed). Only on success do we
# write, so a hashing failure can never leave a usable approval behind.
id=$(stage_id)
printf '%s\n' "$id" > "$(git rev-parse --git-dir)/.commit-approved"
echo "Review approval minted for the staged snapshot."
