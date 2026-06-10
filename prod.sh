#!/bin/sh
./e2e.sh full && UID=$(id -u) GID=$(id -g) docker compose up prod bot-api --build -d
