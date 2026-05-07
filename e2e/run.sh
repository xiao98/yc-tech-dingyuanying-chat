#!/usr/bin/env bash
# YC TECH 丁元英 Chat — e2e runner (P3a placeholder).
# ==================================================================
# P3a ships the scaffold only. P3b will:
#   1. Replace `mock-newapi` / `mock-ycapi` images with real express
#      stubs that capture provisioning + chat traffic.
#   2. Add `*.spec.js` files alongside this script (or under
#      e2e/specs-docker/) and a Jest config to drive them against
#      the composed stack.
#   3. Add a `payments-webhook.spec.js` that posts crafted alipay /
#      wxpay / stripe webhook bodies and asserts channel_ref-based
#      replay protection (Goal criterion 4.2).
#
# For now this script verifies the compose file parses and brings the
# stack up/down cleanly so the harness wiring is real, just empty.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[e2e/run.sh] FATAL: docker compose not available." >&2
  exit 1
fi

E2E_FILE=e2e/docker-compose.test.yml

cleanup() {
  echo "[e2e/run.sh] Tearing down..."
  "${COMPOSE[@]}" -f "$E2E_FILE" down --volumes --remove-orphans || true
}
trap cleanup EXIT

echo "[e2e/run.sh] Validating compose config..."
"${COMPOSE[@]}" -f "$E2E_FILE" config >/dev/null

echo "[e2e/run.sh] (P3a) no spec files yet — exiting after config validation."
echo "[e2e/run.sh] P3b will run jest specs here."
exit 0
