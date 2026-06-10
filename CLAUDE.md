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

Most quality gates are enforced mechanically (pre-commit: lint + gitleaks +
tests + coverage; pre-push: e2e; Stop hook: commit before finishing; GitHub:
secret push protection, and branch protection on main requiring a PR with
green CI — no direct pushes, admins included). The conventions hooks can't
enforce:

- EVERY change goes on a branch with a PR, however small. The owner reviews
  and merges all PRs.
- Every behavior change ships with tests covering it. If the coverage
  thresholds in bunfig.toml block you, write better tests — don't lower them.
- Every change gets the full review treatment (the skills are fast on small
  changes): /pr-review-toolkit:review-pr during development, then
  /code-review --fix before handing the PR to the owner. Fix the findings you
  agree with, dismiss bad ones with stated reasoning, and never post review
  comments on your own PR.
- e2e snapshot mismatches where only yt-dlp format ids / filenames changed are
  staleness, not bugs: refresh with
  `docker compose run --rm -T test bash -c "TEST_E2E=true bun --config=bunfig.e2e.toml test e2e -u"`

## Gotchas

- X/Twitter is intentionally unsupported for moral reasons. Do not add support.
- yt-dlp self-updates at startup and daily (world-writable /opt/yt-dlp in the
  containers), so the version baked into the image is only a starting point.
- Verify Telegram API behavior empirically: capture real payloads, keep
  MockBotApi in parity (test/simulate-bot-api.ts). The official docs are
  incomplete or wrong in places.
- reddit/youtube hard-block datacenter IPs (403 / "account authentication
  required"), so anything involving real yt-dlp downloads only works from
  residential IPs. This is why e2e runs pre-push and at deploy but NOT in CI,
  and why this project can't be developed from cloud environments.
