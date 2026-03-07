#!/usr/bin/env bash
set -euo pipefail
INTEGRATION=1 bun test test/learning-tests.test.ts
