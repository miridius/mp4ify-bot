# mp4ify-bot

Telegram bot (@mp4ify_bot): send it a video link, it replies with the mp4.
Bun + Telegraf + yt-dlp, deployed via Docker Compose with a local
telegram-bot-api server.

- Tests only work inside the test container (/storage is root-owned on the
  host):
  `UID=$(id -u) GID=$(id -g) docker compose run --rm --no-deps test bun test`
- Everything goes on a branch + PR (main is protected). Before opening the
  PR, run /pr-review-toolkit:review-pr, then /code-review --fix.
- Never assume Telegram API behavior from the docs — verify against real
  payloads and keep MockBotApi (test/simulate-bot-api.ts) in parity.
- X/Twitter is deliberately unsupported, for moral reasons. Do not add it.
