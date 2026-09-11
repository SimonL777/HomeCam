#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with: sudo $0"
  exit 1
fi

if ! command -v ffmpeg >/dev/null || ! command -v v4l2-ctl >/dev/null; then
  apt-get update
  apt-get install -y ffmpeg v4l-utils
fi

if ! id -u homecam >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin homecam
fi
usermod -a -G video homecam

install -d -m 0750 -o root -g homecam /etc/homecam
if [[ ! -f /etc/homecam/camera.env ]]; then
  install -m 0640 -o root -g homecam "$(dirname "$0")/camera.env.example" /etc/homecam/camera.env
else
  chown root:homecam /etc/homecam/camera.env
  chmod 0640 /etc/homecam/camera.env
fi
install -m 0644 "$(dirname "$0")/homecam-camera.service" /etc/systemd/system/homecam-camera.service

systemctl daemon-reload
systemctl enable --now homecam-camera
systemctl --no-pager --full status homecam-camera || true
