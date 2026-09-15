#!/bin/sh
set -eu

mkdir -p /var/lib/homecam-ai
chown -R node:node /var/lib/homecam-ai

exec su-exec node "$@"
