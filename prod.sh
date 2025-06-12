#!/bin/sh
./e2e.sh && UID=$(id -u) GID=$(id -g) docker compose up prod bot-api --build -d