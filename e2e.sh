#!/bin/sh
docker compose run --remove-orphans --rm -it test bash -c 'TEST_E2E=true bun test e2e'
