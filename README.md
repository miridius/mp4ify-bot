# mp4ify bot

A telegram bot that turns links into videos, so that you don't have to deal with opening the cancer that is instagram, reddit, etc. in your browser.

## Usage

Send urls to [@mp4ify_bot](https://t.me/mp4ify_bot), or add it to a group. The bot will try to download the video, converting to mp4 if needed, and send it back to you if successful. Videos must be less than 50MB due to Telegram's bot API limits.

Start your message with `/verbose` to get detailed logs.

> **Note:** x.com links are intentionally not supported by default, because I do not want to have anything to do with a site that promotes obvious evils such as fascism. If you want to use the bot for x.com, you can self-host it and remove the `--use-extractors` line from yt-dlp.conf. If you think there are other sites that I should block as well, please let me know (or just make a PR).

## Development/Self Hosting

0. Prerequisites

   1. Git
   2. Docker
   3. A telegram app api_id and api_hash for running the local bot server, see https://core.telegram.org/api/obtaining_api_id
   4. At least one telegram bot token (using [@BotFather](https://t.me/botfather)), two if you want to run both a local dev bot (live code reloading) and a prod bot (from a stable source snapshot) at the same time.

   _Note that you do **not** need to install bun or any of the runtime deps locally! Just use the dev container instead._

1. Clone the repository:

```bash
git clone https://github.com/miridius/video-bot.git
cd video-bot
```

2. Create and fill in `.env.telegram` and/or `.env.prod` (see `.env.telegram.example`):

```bash
cp .env.telegram.example .env.telegram
```

3. Create and fill in `.env.dev` and/or `.env.prod` (depending which bots you want to run) with your bot token(s) (see `.env.example`):

```bash
cp .env.example .env.dev
cp .env.example .env.prod
```

4. Start the bot(s) using _one_ of the following commands:

```bash
# dev bot, mounts your whole working directory and restarts on code changes
# (alternatively, run ./dev.sh)
docker compose up dev bot-api -d

# prod bot, bakes in the source at build time and is not affected by code changes
# (alternatively, run ./prod.sh)
docker compose up prod bot-api -d

# both bots at the same time
docker compose up -d
```

5. To run other bun commands like `bun add foo` or `bun repl`, you can start a shell in the dev container:

```bash
# (alternatively, run ./shell.sh)
$ docker compose exec dev bash
bun@61702048407c:/app$ bun repl
>
```
