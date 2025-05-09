# mp4ify bot

A telegram bot that turns links into videos, so that you don't have to deal with opening the cancer that is instagram, reddit, etc. in your browser.

## Usage

Send urls to [@mp4ify_bot](https://t.me/mp4ify_bot), or add it to a group. The bot will try to download the video, converting to mp4 if needed, and send it back to you if successful. Videos must be less than 50MB due to Telegram's bot API limits.

Start your message with `/verbose` to get detailed logs.

## Development

0. Prerequisites
   - Docker
   - Git
   - (Nothing else! It all runs in containers)
1. Clone the repository:

```bash
git clone https://github.com/miridius/video-bot.git
cd video-bot
```

2. Start the bot in development mode (automatically restarts on code changes):

```bash
./dev.sh # optionally pass -d to run in the background
```

3. To run other bun commands like `bun install` or `bun repl`, you can start a shell in the dev container:

```bash
./shell.sh
```
