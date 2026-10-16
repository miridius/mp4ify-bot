#!/bin/sh
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up --build dev bot-api -d
