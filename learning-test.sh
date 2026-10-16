#!/bin/bash
set -e
cd "$(dirname "$0")"
export HOST_UID=$(id -u) HOST_GID=$(id -g)

docker compose build test

# the live Reddit and Threads cases need the prod bot's login
. scripts/borrow-cookie-jar.sh
MOUNT=()
if borrow_cookie_jar; then
  trap 'rm -r "$JAR"' EXIT
  MOUNT=(-v "$JAR_VOLUME")
else
  echo "the reddit and threads cases will fail" >&2
fi
# a backstop past the summed per-test timeouts in test/learning-tests.test.ts,
# which also covers update-fixtures' fewer fetches of the same URLs
run() { docker compose run --rm --no-deps "${MOUNT[@]}" test timeout -k 30 1800 "$@"; }
learn() { run env INTEGRATION=1 bun --config=bunfig.partial.toml test test/learning-tests.test.ts; }

# Run learning tests
if learn; then
  echo ""
  echo "All learning tests passed."
  exit 0
fi

echo ""
echo "Tests failed."
read -p "Update fixtures from real services? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  # exit 2 is a failed fetch, and the re-run below fails on that service too
  run bun scripts/update-fixtures.ts || [ $? -eq 2 ]
  echo ""
  echo "Re-running tests..."
  echo ""
  learn
else
  exit 1
fi
