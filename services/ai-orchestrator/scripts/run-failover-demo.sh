#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(dirname "${script_dir}")
demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/homecam-ai-demo.XXXXXX")
port="${AI_DEMO_PORT:-18090}"
token="local-demo-token"
server_pid=""

cleanup() {
  if [ -n "${server_pid}" ]; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  rm -rf "${demo_dir}"
}
trap cleanup EXIT INT TERM

PORT="${port}" \
AI_DATABASE_PATH="${demo_dir}/orchestrator.db" \
AI_ORCHESTRATOR_TOKEN="${token}" \
AI_LEASE_MS=500 \
AI_WORKER_OFFLINE_MS=700 \
AI_RETRY_BASE_MS=50 \
AI_SWEEP_MS=60000 \
node "${service_dir}/src/server.js" >"${demo_dir}/server.log" 2>&1 &
server_pid=$!

attempt=0
until curl --fail --silent "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 50 ]; then
    cat "${demo_dir}/server.log"
    exit 1
  fi
  sleep 0.1
done

AI_ORCHESTRATOR_URL="http://127.0.0.1:${port}" \
AI_ORCHESTRATOR_TOKEN="${token}" \
node "${script_dir}/demo-failover.mjs"
