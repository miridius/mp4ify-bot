#!/bin/sh
UID=$(id -u) GID=$(id -g) docker compose up --remove-orphans test
