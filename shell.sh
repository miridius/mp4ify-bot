#!/bin/sh
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose exec -it dev bash
