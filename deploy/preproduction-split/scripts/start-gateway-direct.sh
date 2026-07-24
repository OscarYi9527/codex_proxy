#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.gateway.runtime.env"
COMPOSE_FILE="${DEPLOY_DIR}/gateway.compose.yaml"
STATE_DIR="${DEPLOY_DIR}/state"
BACKUP_DIR="${STATE_DIR}/direct-cutover-backups"

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
  "${DEPLOY_DIR}/Caddyfile" \
  "${DEPLOY_DIR}/secrets/gateway-mtls/ca.pem" \
  "${DEPLOY_DIR}/secrets/gateway-mtls/gateway-client.pem" \
  "${DEPLOY_DIR}/secrets/gateway-mtls/gateway-client-key.pem"; do
  if [[ ! -s "${file}" ]]; then
    echo "Required stable-ingress file is missing or empty: ${file}" >&2
    exit 1
  fi
done

origin="$(
  sed -n 's/^AI_EDITOR_DIRECT_PUBLIC_ORIGIN=//p' "${ENV_FILE}" |
    tail -n 1
)"
expected_ipv4="$(
  sed -n 's/^AI_EDITOR_DIRECT_EXPECTED_IPV4=//p' "${ENV_FILE}" |
    tail -n 1
)"
if [[ ! "${origin}" =~ ^https://([A-Za-z0-9.-]+)$ ]]; then
  echo "AI_EDITOR_DIRECT_PUBLIC_ORIGIN must be a hostname-only HTTPS origin." >&2
  exit 1
fi
hostname="${BASH_REMATCH[1]}"
if [[ ! "${expected_ipv4}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "AI_EDITOR_DIRECT_EXPECTED_IPV4 must be an IPv4 literal." >&2
  exit 1
fi
if ! getent ahostsv4 "${hostname}" |
  awk '{ print $1 }' |
  grep -Fxq "${expected_ipv4}"; then
  echo "DNS is not ready. Point ${hostname} to ${expected_ipv4} before cutover." >&2
  exit 1
fi
memory_mib="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
disk_gib="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
if (( $(nproc) < 2 || memory_mib < 3500 || disk_gib < 20 )); then
  echo "Domestic Gateway is below the invitation-MVP minimum: 2 CPU, 3500 MiB RAM, 20 GiB free disk." >&2
  exit 1
fi

for port in 80 443; do
  foreign_listener="$(
    sudo ss -lntpH |
      awk -v suffix=":${port}" '$4 ~ suffix "$" && $0 !~ /docker-proxy|caddy/ { print }'
  )"
  if [[ -n "${foreign_listener}" ]]; then
    echo "Port ${port} is occupied by a non-Caddy process: ${foreign_listener}" >&2
    exit 1
  fi
done

install -d -m 700 \
  "${BACKUP_DIR}" \
  "${STATE_DIR}/caddy/data" \
  "${STATE_DIR}/caddy/config"
backup="${BACKUP_DIR}/gateway-runtime-$(date -u +%Y%m%dT%H%M%SZ).env"
cp --preserve=mode,timestamps "${ENV_FILE}" "${backup}"
chmod 600 "${backup}"
previous_origin="$(
  sed -n 's/^AI_EDITOR_PREPRODUCTION_PUBLIC_ORIGIN=//p' "${ENV_FILE}" |
    tail -n 1
)"
cutover_complete=false

rollback() {
  local exit_code=$?
  if [[ "${cutover_complete}" == true ]]; then
    exit "${exit_code}"
  fi
  echo "Stable direct cutover failed; restoring the previous Gateway origin." >&2
  cp --preserve=mode,timestamps "${backup}" "${ENV_FILE}"
  docker_compose up -d --force-recreate gateway >/dev/null 2>&1 || true
  docker_compose stop caddy-direct >/dev/null 2>&1 || true
  exit "${exit_code}"
}
trap rollback ERR

set_env AI_EDITOR_PREPRODUCTION_PUBLIC_ORIGIN "${origin}"
set_env AI_EDITOR_GATEWAY_HOSTNAME "${hostname}"

docker_compose pull caddy-direct
docker_compose up -d --force-recreate caddy-direct
direct_ready=false
for _ in $(seq 1 90); do
  if curl --fail --silent --show-error --max-time 3 \
    --tlsv1.2 "${origin}/live" >/dev/null 2>&1; then
    direct_ready=true
    break
  fi
  if docker_compose logs --no-color --since 30s caddy-direct 2>&1 |
    grep -Eq 'Timeout during connect|likely firewall problem'; then
    echo "ACME cannot reach ${expected_ipv4} on TCP 80/443. Allow both ports in the domestic cloud security group, then rerun the cutover." >&2
    exit 1
  fi
  sleep 2
done
if [[ "${direct_ready}" != true ]]; then
  echo "Stable direct TLS did not become ready within the bounded wait." >&2
  docker_compose logs --no-color --tail 80 caddy-direct >&2 || true
  exit 1
fi
curl --fail --silent --show-error --max-time 20 \
  --tlsv1.2 "${origin}/live" >/dev/null

docker_compose build gateway
docker_compose up -d --force-recreate gateway
"${SCRIPT_DIR}/verify-gateway-direct.sh"

docker_compose stop cloudflared-quick
"${SCRIPT_DIR}/verify-gateway-direct.sh"

printf '%s\n' "${origin}" > "${STATE_DIR}/gateway-public-origin.txt"
chmod 600 "${STATE_DIR}/gateway-public-origin.txt"
cutover_complete=true
trap - ERR

echo "Stable direct Gateway cutover completed."
echo "Previous origin: ${previous_origin}"
echo "Current origin: ${origin}"
echo "Runtime backup: ${backup}"
