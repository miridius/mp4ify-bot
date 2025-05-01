#!/bin/sh
set -eu
docker build -t dev .
docker run --rm -it \
  -v "$(pwd):/app" \
  -w /app \
  -u $(id -u):$(id -g) \
  dev bash