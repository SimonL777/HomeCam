#!/bin/sh
set -eu

mkdir -p /var/lib/homecam/config /tmp/homecam-vod
chown -R node:node /var/lib/homecam/config /tmp/homecam-vod

exec su-exec node "$@"
