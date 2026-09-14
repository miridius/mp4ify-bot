#!/bin/sh
UID=$(id -u) GID=$(id -g) docker compose up --build --remove-orphans test
