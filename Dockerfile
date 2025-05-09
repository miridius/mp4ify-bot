FROM oven/bun

# Add python and ffmpeg for youtube-dl
RUN apt-get update && \
  apt-get install -y python3 ffmpeg && \
  # Clean up apt cache
  apt-get clean && \
  # Remove unnecessary files
  rm -rf /var/lib/apt/lists/*

# Install deps for development
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install

# Start the app
CMD ["bun", "start"]