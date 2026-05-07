#!/usr/bin/env bash
# YC TECH 丁元英 Chat — e2e runner (P3b).
# ==================================================================
# Drives the criterion 4.2 (payment webhook + replay) and 4.3
# (balance gate) jest specs against an ephemeral mongodb-memory-server
# instance. The signed payloads come from `e2e/mocks/*-simulator.js`,
# which the spec files import as plain modules — so this script does
# NOT need a long-running app container for the in-process specs.
#
# The docker-compose.test.yml stack is still validated up/down so that
# a future P3c smoke test can layer on top without re-doing the harness.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  COMPOSE=()
fi

E2E_FILE=e2e/docker-compose.test.yml

if [ "${SKIP_DOCKER:-}" != "1" ] && [ "${#COMPOSE[@]}" -gt 0 ]; then
  cleanup() {
    echo "[e2e/run.sh] Tearing down compose stack..."
    "${COMPOSE[@]}" -f "$E2E_FILE" down --volumes --remove-orphans || true
  }
  trap cleanup EXIT
  echo "[e2e/run.sh] Validating compose config..."
  "${COMPOSE[@]}" -f "$E2E_FILE" config >/dev/null
else
  echo "[e2e/run.sh] Skipping docker compose (SKIP_DOCKER=1 or docker missing)."
fi

cd "$REPO_ROOT/api"

echo "[e2e/run.sh] Running criterion 4.2 (payment webhooks)..."
PAYMENT_EXIT=0
npx jest server/routes/payment/__tests__/payments.e2e.spec.js --runInBand || PAYMENT_EXIT=$?

echo "[e2e/run.sh] Running criterion 4.3 (balance gate)..."
GATE_EXIT=0
npx jest server/routes/__tests__/balance-gate.e2e.spec.js --runInBand || GATE_EXIT=$?

if [ "$PAYMENT_EXIT" -ne 0 ] || [ "$GATE_EXIT" -ne 0 ]; then
  echo "[e2e/run.sh] FAIL: payment=$PAYMENT_EXIT, gate=$GATE_EXIT"
  exit 1
fi

echo "[e2e/run.sh] PASS: criterion 4.2 + 4.3 e2e suites green."
exit 0
