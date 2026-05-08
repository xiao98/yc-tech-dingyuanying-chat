#!/usr/bin/env bash
# YC TECH 丁元英 Chat — P3a deploy entrypoint.
# ==================================================================
# Goal criterion 8: every required env var is checked BEFORE any
# business operation (docker pull / build / up / certbot). Missing
# any variable => exit 1 with the FIRST missing var named in the
# error message. This keeps half-deployed states from being possible.
#
# Usage:
#   bash deploy.sh                  # full deploy (loads .env)
#   env -i bash deploy.sh           # negative test — must exit 1
#
# The script is idempotent:
#   * First run: nginx HTTP-only -> certbot certonly -> nginx reload
#                with cert -> docker compose up -d -> health-check.
#   * Later runs: detects existing /etc/letsencrypt/live/$DOMAIN/
#                 fullchain.pem and skips the certbot bootstrap step.

set -euo pipefail

# ---- 1. Locate repo root + load .env ---------------------------------
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# `.env` is optional (vars may already be exported by the orchestrator),
# but if it exists we source it before validation.
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; . .env; set +a
fi

# ---- 2. Fail-fast env validation -------------------------------------
# Every required variable. Order is the canonical order — the FIRST
# missing var is the one reported. Any addition must be reflected in
# .env.sample and README "P3a Verification" section.
REQUIRED_VARS=(
  YCAPI_BASE_URL
  YCAPI_ADMIN_KEY
  NEWAPI_ADMIN_BASE_URL
  NEWAPI_ADMIN_KEY
  ALIPAY_APP_ID
  ALIPAY_PRIVATE_KEY_PATH
  ALIPAY_PUBLIC_KEY_PATH
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  MONGO_URI
  JWT_SECRET
  DOMAIN
  SUBKEY_ENCRYPTION_KEY
  SKILL_MD_PATH
  UPSTREAM_BASE_URL
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "[deploy.sh] FATAL: missing required env var(s): ${missing[*]}" >&2
  echo "[deploy.sh] First missing: ${missing[0]}" >&2
  echo "[deploy.sh] See .env.sample for the full list and provenance notes." >&2
  exit 1
fi

echo "[deploy.sh] All ${#REQUIRED_VARS[@]} required env vars present."

# ---- 3. Resolve compose CLI ------------------------------------------
# Prefer Docker Compose v2 plugin; fall back to docker-compose v1.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[deploy.sh] FATAL: neither 'docker compose' nor 'docker-compose' available." >&2
  exit 1
fi

# ---- 4. First-run TLS bootstrap --------------------------------------
CERT_PATH="$REPO_ROOT/nginx/letsencrypt/live/$DOMAIN/fullchain.pem"
if [[ ! -f "$CERT_PATH" ]]; then
  echo "[deploy.sh] No existing TLS cert for $DOMAIN — running certbot bootstrap."

  # 4a. Render a minimal HTTP-only nginx so the LE webroot challenge can
  #     answer on port 80. The full template still substitutes $DOMAIN
  #     but nginx will fail to reload the 443 server block until certs
  #     exist — so we boot just nginx with `restart: no` first using a
  #     stripped-down conf via env override is overkill. Simpler: the
  #     compose template's port-80 server block does NOT depend on
  #     certs, and the 443 block fails fast on missing files. Bring
  #     nginx up with port 80 only by using `--profile` would also be
  #     overkill. Practical path: start nginx and tolerate the 443
  #     reload failure — but the cleanest is to bring it up directly.
  "${COMPOSE[@]}" up -d nginx || true
  sleep 2

  # 4b. Run certbot once. `--webroot -w /var/www/certbot` matches the
  #     `location /.well-known/acme-challenge/` block in nginx.conf.template.
  "${COMPOSE[@]}" run --rm \
    --entrypoint "" \
    certbot \
    certbot certonly \
      --webroot -w /var/www/certbot \
      -d "$DOMAIN" \
      --agree-tos \
      -m "admin@$DOMAIN" \
      -n \
      --no-eff-email

  # 4c. Reload nginx so it picks up the freshly issued cert.
  "${COMPOSE[@]}" restart nginx
else
  echo "[deploy.sh] TLS cert for $DOMAIN already present — skipping certbot bootstrap."
fi

# ---- 5. Bring up the full stack --------------------------------------
echo "[deploy.sh] Starting full stack..."
"${COMPOSE[@]}" up -d

# ---- 6. Health-check ------------------------------------------------
echo "[deploy.sh] Waiting up to 60s for https://$DOMAIN/api/health ..."
deadline=$(( $(date +%s) + 60 ))
while (( $(date +%s) < deadline )); do
  if curl -fsS -o /dev/null "https://$DOMAIN/api/health"; then
    echo "[deploy.sh] OK — health endpoint returned 200."
    exit 0
  fi
  sleep 3
done

echo "[deploy.sh] WARN: /api/health did not return 200 within 60s." >&2
echo "[deploy.sh] Stack is up; investigate with '${COMPOSE[*]} logs --tail=200'." >&2
exit 2
