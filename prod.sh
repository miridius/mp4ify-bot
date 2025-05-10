#!/bin/sh
UID=$(id -u) GID=$(id -g) docker compose up prod --build -d