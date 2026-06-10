# mp4ify-bot

Telegram bot (@mp4ify_bot): send it a video link, it downloads with yt-dlp and
replies with the mp4. Bun + Telegraf, deployed via Docker Compose alongside a
local telegram-bot-api server (raises the upload limit to 2GB).

## Commands

- Test: `UID=$(id -u) GID=$(id -g) docker compose run --rm --no-deps test bun test`
  (host runs fail: /storage is root-owned; tests must run in the test container)
- Full quality gate (lint + secret scan + tests): `./check.sh` — same thing the
  pre-commit hook runs
- Deploy: `./prod.sh` (e2e-gated). Owner's call only — never deploy unprompted.
- Dev bot with hot reload: `./dev.sh`

## Workflow

- Features go on a branch with a PR; CI (lint, tests, coverage thresholds,
  gitleaks) must be green to merge. Trivial fixes (typos, config) may go
  straight to main.
- Every behavior change ships with tests covering it. Coverage thresholds live
  in bunfig.toml — if they block you, write better tests, don't lower them.
- Run /code-review on the PR before handing it to the owner.
- A Stop hook blocks ending a session with uncommitted changes.

## Gotchas

- X/Twitter is intentionally unsupported for moral reasons. Do not add support.
- yt-dlp self-updates at startup and daily (world-writable /opt/yt-dlp in the
  containers), so the version baked into the image is only a starting point.
- Verify Telegram API behavior empirically: capture real payloads, keep
  MockBotApi in parity (test/simulate-bot-api.ts). The official docs are
  incomplete or wrong in places.
- yt-dlp needs --no-check-certificates in cloud sandboxes; the code adds it
  automatically when CLAUDE_CODE_REMOTE=true.
