# mp4ify-bot

Telegram bot (@mp4ify_bot): send it a video link, it replies with the mp4.
Bun + Telegraf + yt-dlp, deployed via Docker Compose with a local
telegram-bot-api server.

- Tests only work inside the test container (/storage is root-owned on the
  host). The in-container `timeout` bounds the run so a hung/non-exiting `bun
  test` self-kills and `--rm` cleans up instead of orphaning a 100%-CPU
  container; keep it, especially when backgrounding the run:
  `UID=$(id -u) GID=$(id -g) docker compose run --rm --no-deps test timeout -k 30 300 bun test`
- Everything goes on a branch + PR (main is protected). Use /commit, /pr,
  and /merge instead of raw `git commit`, `gh pr create`, `gh pr merge`.
- Never assume Telegram API behavior from the docs — verify against real
  payloads and keep MockBotApi (test/simulate-bot-api.ts) in parity.
- X/Twitter is deliberately unsupported, for moral reasons. Do not add it.
- Review findings get fixed and pushed, not posted as PR comments.
- Every change gets the full review treatment: no trivial-change fast paths.
- Solo repo: fix it now in the current PR; never proactively offer to defer
  work or to create GitHub issues.
- File a GitHub issue only when I ask, with facts only (symptoms + repro for a
  bug, requirements/user story for a feature), never a proposed solution.
