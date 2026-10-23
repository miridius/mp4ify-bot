#!/bin/bash
set -e
cd "$(dirname "$0")"

docker compose build test

# the live Reddit fixture needs the prod bot's login
. scripts/borrow-cookie-jar.sh
MOUNT=()
if borrow_cookie_jar; then
  trap 'rm -r "$JAR"' EXIT
  MOUNT=(-v "$JAR_VOLUME")
else
  echo "the reddit fixture will fail" >&2
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
read -p "Tests failed. Update fixtures from real services? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  run bun scripts/update-fixtures.ts
  echo ""
  echo "Fixtures updated. Re-running tests..."
  echo ""
  learn
else
  exit 1
fi
