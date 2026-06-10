#!/bin/sh
# Usage: ./e2e.sh [full] [-u]
#   full  also test rate-limit-prone sites (youtube rejects more than a few
#         hits per hour). Used by the deploy gate (prod.sh); the pre-push
#         hook runs the reduced set.
#   -u    refresh snapshots. Implies full: `bun test -u` deletes snapshots of
#         tests it didn't run, so a reduced -u run would silently prune the
#         full-mode snapshots.
FULL=""
UPDATE=""
for arg in "$@"; do
  case "$arg" in
    full) FULL=1 ;;
    -u) UPDATE="-u"; FULL=1 ;;
    *) echo "unknown argument: $arg" >&2 && exit 64 ;;
  esac
done
docker compose run --remove-orphans --rm -T -e TEST_E2E=true -e TEST_E2E_FULL="$FULL" test bun --config=bunfig.e2e.toml test e2e $UPDATE
