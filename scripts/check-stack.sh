#!/usr/bin/env bash
set -u

nas_ip="${1:-}"
web_port="${2:-8095}"
if [[ -z "${nas_ip}" ]]; then
  echo "Usage: $0 NAS_IP [WEB_PORT]"
  exit 2
fi

failed=0

check_tcp() {
  local port="$1"
  local label="$2"
  if nc -z -w 3 "${nas_ip}" "${port}" >/dev/null 2>&1; then
    printf 'PASS  %-18s %s:%s\n' "${label}" "${nas_ip}" "${port}"
  else
    printf 'FAIL  %-18s %s:%s\n' "${label}" "${nas_ip}" "${port}"
    failed=1
  fi
}

check_tcp "${web_port}" "HomeCam web"
check_tcp 8554 "RTSP ingest"

if [[ "${failed}" -ne 0 ]]; then
  echo "One or more services are unreachable. Check Docker Compose on the NAS."
  exit 1
fi

echo "Published TCP service ports are reachable."
echo "HLS and WHEP HTTP stay inside the Compose network; WebRTC media uses UDP 8189."
