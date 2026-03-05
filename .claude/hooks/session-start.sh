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
# Fallback defaults allow tests to run without real credentials.
{
  echo "export BOT_TOKEN=\"${BOT_TOKEN:-dummy}\""
  echo "export OWNER_ID=\"${OWNER_ID:-0}\""
} >> "$CLAUDE_ENV_FILE"

# Create .env.dev for the bot (used by docker compose and fallback e2e)
cat > "$CLAUDE_PROJECT_DIR/.env.dev" <<ENVEOF
BOT_TOKEN=${BOT_TOKEN:-dummy}
OWNER_ID=${OWNER_ID:-0}
ENVEOF
