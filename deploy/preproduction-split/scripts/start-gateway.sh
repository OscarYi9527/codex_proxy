#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.gateway.runtime.env"
COMPOSE_FILE="${DEPLOY_DIR}/gateway.compose.yaml"

docker_compose() {
  sudo docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

set_env() {
  local name="$1"
  local value="$2"
  local temporary="${ENV_FILE}.${$}.tmp"
  awk -F= -v key="${name}" '$1 != key { print }' "${ENV_FILE}" > "${temporary}"
  printf '%s=%s\n' "${name}" "${value}" >> "${temporary}"
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${ENV_FILE}"
}

for file in \
  "${ENV_FILE}" \
  "${DEPLOY_DIR}/secrets/gateway-mtls/ca.pem" \
  "${DEPLOY_DIR}/secrets/gateway-mtls/gateway-client.pem" \
  "${DEPLOY_DIR}/secrets/gateway-mtls/gateway-client-key.pem"; do
  if [[ ! -s "${file}" ]]; then
    echo "Required Gateway secret is missing or empty: ${file}" >&2
    exit 1
  fi
done
if ! grep -Eq '^AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET=.{32,}$' "${ENV_FILE}"; then
  echo "Gateway signing secret is missing or too short." >&2
  exit 1
fi
worker_origin="$(sed -n 's/^AI_EDITOR_PREPRODUCTION_WORKER_ORIGIN=//p' "${ENV_FILE}" | tail -n 1)"
if [[ ! "${worker_origin}" =~ ^https://[^/]+:47930$ ]]; then
  echo "Gateway Worker origin must be an HTTPS origin on 47930." >&2
  exit 1
fi

install -d -m 700 "${DEPLOY_DIR}/state/gateway"
chmod 600 "${ENV_FILE}" "${DEPLOY_DIR}/secrets/gateway-mtls/"*.pem
set_env AI_EDITOR_PREPRODUCTION_PUBLIC_ORIGIN https://pending.invalid
docker_compose up -d --force-recreate cloudflared-quick

public_origin=""
for _ in $(seq 1 120); do
  public_origin="$(
    docker_compose logs --no-color cloudflared-quick 2>&1 \
      | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
      | grep -Ev '^https://api\.trycloudflare\.com$' \
      | tail -n 1 || true
  )"
  [[ -n "${public_origin}" ]] && break
  sleep 1
done
if [[ -z "${public_origin}" ]]; then
  echo "Cloudflare Quick Tunnel did not publish an HTTPS origin." >&2
  docker_compose logs --no-color --tail 100 cloudflared-quick >&2
  exit 1
fi
set_env AI_EDITOR_PREPRODUCTION_PUBLIC_ORIGIN "${public_origin}"
printf '%s\n' "${public_origin}" > "${DEPLOY_DIR}/state/gateway-public-origin.txt"
chmod 600 "${DEPLOY_DIR}/state/gateway-public-origin.txt"

docker_compose build gateway
docker_compose run --rm --no-deps -T gateway node gateway/dist/bootstrap-cli.js
docker_compose up -d --force-recreate gateway
"${SCRIPT_DIR}/verify-gateway.sh"
echo "Gateway preview origin: ${public_origin}"
