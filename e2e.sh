#!/bin/sh
# Usage: ./e2e.sh [full] [-u]
#   full  also test rate-limit-prone sites (youtube rejects more than a few
#         hits per hour; reddit is scraped as the prod bot's logged-in
#         account) and the multi-video case (one more scrape of
#         instagram, which rate-limits too). Used by the deploy gate
#         (prod.sh); the pre-push hook runs the reduced set.
#   -u    refresh snapshots, or record a new test's. Implies full: `bun
#         test -u` deletes snapshots of tests it didn't run, so a reduced -u
#         run would silently prune the full-mode snapshots.
cd "$(dirname "$0")" || exit
FULL=""
UPDATE=""
for arg in "$@"; do
  case "$arg" in
    full) FULL=1 ;;
    -u) UPDATE="-u"; FULL=1 ;;
    *) echo "unknown argument: $arg" >&2 && exit 64 ;;
  esac
done
# a backstop past the mode's summed per-test timeouts in test/e2e.test.ts
TIMEOUT=1200
[ -n "$FULL" ] && TIMEOUT=4600
# Reddit demands a login for every request from this server's IP, so a full run
# borrows the prod bot's cookie jar (the test service has no /storage volume)
JAR=""
set --
if [ -n "$FULL" ]; then
  JAR=$(mktemp -d)
  if ! docker cp mp4ify:/storage/mp4ify-cookies.txt "$JAR"; then
    echo "couldn't copy the Reddit cookie jar out of the prod container" >&2
    rm -r "$JAR"
    exit 1
  fi
  set -- -v "$JAR/mp4ify-cookies.txt:/storage/mp4ify-cookies.txt:ro"
fi
# in CI mode bun fails a missing snapshot instead of writing it unreviewed
# (-u still writes)
set -- "$@" -e CI=true
SNAP=test/__snapshots__/e2e.test.ts.snap
if [ -n "$UPDATE" ]; then
  KEPT=$(mktemp)
  cp "$SNAP" "$KEPT"
fi
# Self-update yt-dlp first (directly: the bot's own updater skips test-stub
# resolution, and prod self-updates every 5 minutes, so e2e against the
# image's build-time binary would validate a yt-dlp prod no longer runs).
# In-place rewrite is safe here: nothing else runs in this container.
# All under the in-container timeout, like check.sh: a hung run self-kills so
# --rm can clean up instead of orphaning a 100%-CPU container.
docker compose run --build --remove-orphans --rm -T "$@" -e TEST_E2E=true -e TEST_E2E_FULL="$FULL" test timeout -k 30 "$TIMEOUT" sh -c "
  /opt/yt-dlp/yt-dlp --update-to nightly || echo 'yt-dlp self-update failed; testing the image binary' >&2
  exec bun --config=bunfig.e2e.toml test e2e $UPDATE"
status=$?
[ -z "$JAR" ] || rm -r "$JAR"
if [ -n "$UPDATE" ]; then
  # bun test -u deletes the snapshots of tests that failed before reaching theirs
  [ "$status" -eq 0 ] || cp "$KEPT" "$SNAP"
  rm "$KEPT"
fi
exit "$status"
