#!/bin/bash
set -e

docker compose build test
docker compose run --rm --no-deps test sh -c "INTEGRATION=1 bun test test/learning-tests.test.ts"
