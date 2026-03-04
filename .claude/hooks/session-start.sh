#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install yt-dlp and ffmpeg (needed for video downloading/conversion)
if ! command -v yt-dlp &> /dev/null; then
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod a+rx /usr/local/bin/yt-dlp
fi
if ! command -v ffmpeg &> /dev/null; then
  apt-get update && apt-get install -y --no-install-recommends ffmpeg
  rm -rf /var/lib/apt/lists/*
fi

# Create /storage directory for video cache (used by download-video.ts)
mkdir -p /storage
chmod 777 /storage

# Install JS dependencies (idempotent, uses cached node_modules when possible)
bun install

# Expose secrets to the shell environment via CLAUDE_ENV_FILE.
# The env vars (BOT_TOKEN, TELEGRAM_API_ID, etc.) are configured as
# "Environment variables" in the Claude Code Web environment settings.
# CLAUDE_ENV_FILE makes them available to subsequent shell commands.
# We use fallback defaults so tests can still run without real credentials.
{
  echo "export BOT_TOKEN=\"${BOT_TOKEN:-dummy}\""
  echo "export TELEGRAM_API_ID=\"${TELEGRAM_API_ID:-0}\""
  echo "export TELEGRAM_API_HASH=\"${TELEGRAM_API_HASH:-dummy}\""
  echo "export OWNER_ID=\"${OWNER_ID:-0}\""
} >> "$CLAUDE_ENV_FILE"

# Create .env.telegram for docker compose (bot-api service)
cat > "$CLAUDE_PROJECT_DIR/.env.telegram" <<ENVEOF
TELEGRAM_API_ID=${TELEGRAM_API_ID:-0}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH:-dummy}
ENVEOF

# Create .env.dev for docker compose (dev service)
cat > "$CLAUDE_PROJECT_DIR/.env.dev" <<ENVEOF
BOT_TOKEN=${BOT_TOKEN:-dummy}
OWNER_ID=${OWNER_ID:-0}
ENVEOF
