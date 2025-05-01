#!/bin/sh
set -eu
docker build -t dev .
docker run --rm -it \
  -v "$(pwd):/app" \
  -v "/app/node_modules" \
  -v "/app/.pnpm-store" \
  -w /app \
  -u $(id -u):$(id -g) \
  dev bash