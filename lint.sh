#!/bin/sh
UID=$(id -u) GID=$(id -g) docker compose exec dev bun lint
