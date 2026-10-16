#!/bin/sh
./e2e.sh full && HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up prod bot-api --build -d
