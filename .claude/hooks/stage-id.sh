# Content-bound identity of the currently-staged snapshot: the base commit (HEAD)
# plus the staged tree's SHA (git's own cryptographic content hash of the index,
# i.e. exactly what `git commit` would record). The approver mints this and the
# gate verifies it, so an approval certifies the EXACT change that commits:
# re-staging anything moves the tree SHA and voids a stale approval. Sourced (not
# exec'd) by both sides so they compute it identically; never inline a copy.
#
# Returns NONZERO (printing nothing usable) when the index can't be hashed: e.g.
# an in-progress merge with unmerged entries makes `git write-tree` fail. Callers
# MUST treat that as "no valid id" and refuse: passing or minting a degraded/empty
# value would let an unhashable index slip through (fail-open). Computing the tree
# into a variable first is what makes that failure propagate instead of being
# swallowed by a later printf's exit status.
stage_id() {
  tree=$(git write-tree) || return 1
  base=$(git rev-parse HEAD 2>/dev/null || echo NOHEAD)
  printf '%s\n%s\n' "$base" "$tree"
}
