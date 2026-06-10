#!/bin/sh
# Quality gate: lint, secret scan, full test suite (with coverage thresholds).
# Runs as the pre-commit hook; can also be run manually at any time.
set -e

bun run lint

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --pre-commit --staged --no-banner --redact
else
  echo "ERROR: gitleaks not installed - refusing to commit unscanned changes." >&2
  echo "Install: https://github.com/gitleaks/gitleaks/releases (single static binary)" >&2
  exit 1
fi

UID=$(id -u) GID=$(id -g) docker compose run --rm --no-deps test bun test
