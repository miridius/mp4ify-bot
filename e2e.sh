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
# Self-update yt-dlp first (directly: the bot's own updater skips test-stub
# resolution, and prod self-updates every 5 minutes, so e2e against the
# image's build-time binary would validate a yt-dlp prod no longer runs).
# In-place rewrite is safe here: nothing else runs in this container.
# Then the in-container timeout, like check.sh: a hung run self-kills so
# --rm can clean up instead of orphaning a 100%-CPU container.
docker compose run --remove-orphans --rm -T -e TEST_E2E=true -e TEST_E2E_FULL="$FULL" test sh -c "
  /opt/yt-dlp/yt-dlp --update-to nightly || echo 'yt-dlp self-update failed; testing the image binary' >&2
  exec timeout -k 30 600 bun --config=bunfig.e2e.toml test e2e $UPDATE"
