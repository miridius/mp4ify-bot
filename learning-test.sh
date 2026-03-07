#!/bin/bash
set -e

docker compose build test

# Run learning tests
if docker compose run --rm --no-deps test sh -c "INTEGRATION=1 bun test test/learning-tests.test.ts"; then
  echo ""
  echo "All learning tests passed."
  exit 0
fi

echo ""
read -p "Tests failed. Update fixtures from real services? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  docker compose run --rm --no-deps test bun scripts/update-fixtures.ts
  echo ""
  echo "Fixtures updated. Re-running tests..."
  echo ""
  docker compose run --rm --no-deps test sh -c "INTEGRATION=1 bun test test/learning-tests.test.ts"
else
  exit 1
fi
