#!/bin/sh
docker compose run --remove-orphans --rm -T test bash -c "TEST_E2E=true bun --config=bunfig.e2e.toml test e2e"
