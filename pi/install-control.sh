#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with: sudo $0"
  exit 1
fi

allowed_host="${HOMECAM_ALLOWED_HOST:-}"
if [[ -z "${allowed_host}" ]]; then
  echo "Set HOMECAM_ALLOWED_HOST to the HomeCam server IP."
  echo "Example: sudo HOMECAM_ALLOWED_HOST=192.168.50.10 $0"
  exit 2
fi

install -d -m 0755 /etc/homecam /usr/local/lib/homecam
install -m 0755 "$(dirname "$0")/homecam-control.py" /usr/local/lib/homecam/homecam-control.py
install -m 0644 "$(dirname "$0")/homecam-control.service" /etc/systemd/system/homecam-control.service

created_token=0
if [[ ! -f /etc/homecam/control.env ]]; then
  token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  cat > /etc/homecam/control.env <<EOF
HOMECAM_CONTROL_TOKEN=${token}
HOMECAM_ALLOWED_HOST=${allowed_host}
HOMECAM_CONTROL_PORT=${HOMECAM_CONTROL_PORT:-9110}
EOF
  chmod 0600 /etc/homecam/control.env
  created_token=1
fi

systemctl daemon-reload
systemctl enable --now homecam-control
if [[ "${created_token}" -eq 1 ]]; then
  echo "HomeCam control service is running. Copy this token to the server .env:"
  grep '^HOMECAM_CONTROL_TOKEN=' /etc/homecam/control.env
else
  echo "HomeCam control service is running. The existing controller token was preserved."
fi
