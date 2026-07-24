#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.gateway.runtime.env"
COMPOSE_FILE="${DEPLOY_DIR}/gateway.compose.yaml"
MTLS="${DEPLOY_DIR}/secrets/gateway-mtls"

docker_compose() {
  sudo docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

if [[ ! -s "${ENV_FILE}" ]]; then
  echo "Missing Gateway runtime environment: ${ENV_FILE}" >&2
  exit 1
fi

origin="$(
  sed -n 's/^AI_EDITOR_DIRECT_PUBLIC_ORIGIN=//p' "${ENV_FILE}" |
    tail -n 1
)"
configured_origin="$(
  sed -n 's/^AI_EDITOR_PREPRODUCTION_PUBLIC_ORIGIN=//p' "${ENV_FILE}" |
    tail -n 1
)"
expected_ipv4="$(
  sed -n 's/^AI_EDITOR_DIRECT_EXPECTED_IPV4=//p' "${ENV_FILE}" |
    tail -n 1
)"
worker_origin="$(
  sed -n 's/^AI_EDITOR_PREPRODUCTION_WORKER_ORIGIN=//p' "${ENV_FILE}" |
    tail -n 1
)"
if [[ ! "${origin}" =~ ^https://([A-Za-z0-9.-]+)$ ]]; then
  echo "Stable direct Gateway origin is invalid." >&2
  exit 1
fi
hostname="${BASH_REMATCH[1]}"
if [[ "${configured_origin}" != "${origin}" ]]; then
  echo "Gateway runtime public origin does not match direct ingress." >&2
  exit 1
fi
if [[ ! "${expected_ipv4}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Stable direct Gateway IPv4 is invalid." >&2
  exit 1
fi
if [[ ! "${worker_origin}" =~ ^https://[^/]+:47930$ ]]; then
  echo "Gateway Worker origin must be an HTTPS origin on 47930." >&2
  exit 1
fi
if ! getent ahostsv4 "${hostname}" |
  awk '{ print $1 }' |
  grep -Fxq "${expected_ipv4}"; then
  echo "Gateway DNS does not resolve to ${expected_ipv4}: ${hostname}" >&2
  exit 1
fi

for _ in $(seq 1 90); do
  if ss -lntH | grep -q '127.0.0.1:47920' &&
    ss -lntH | grep -Eq '(^|[[:space:]])[^[:space:]]*:443'; then
    break
  fi
  sleep 1
done

gateway_listeners="$(ss -lntH | awk '$4 ~ /:47920$/ { print $4 }')"
if ! grep -Fxq '127.0.0.1:47920' <<<"${gateway_listeners}" ||
  grep -Eq '(^|:)0\.0\.0\.0:47920$|\[::\]:47920$' <<<"${gateway_listeners}"; then
  echo "Gateway must listen only on 127.0.0.1:47920: ${gateway_listeners}" >&2
  exit 1
fi

local_live="$(
  curl --fail --silent --show-error --retry 10 --retry-connrefused \
    --retry-delay 1 --max-time 10 http://127.0.0.1:47920/live
)"
public_headers_file="$(mktemp)"
trap 'rm -f "${public_headers_file}"' EXIT
public_live="$(
  curl --fail --silent --show-error --retry 30 --retry-all-errors \
    --retry-delay 2 --max-time 20 --tlsv1.2 \
    --dump-header "${public_headers_file}" "${origin}/live"
)"
public_ready="$(
  curl --fail --silent --show-error --retry 10 --retry-all-errors \
    --retry-delay 1 --max-time 20 --tlsv1.2 "${origin}/ready"
)"
worker_live="$(
  curl --fail --silent --show-error --max-time 15 \
    --cert-type PEM \
    --key-type PEM \
    --cacert "${MTLS}/ca.pem" \
    --cert "${MTLS}/gateway-client.pem" \
    --key "${MTLS}/gateway-client-key.pem" \
    "${worker_origin}/live"
)"
for value in "${local_live}" "${public_live}" "${worker_live}"; do
  grep -q '"status":"ok"' <<<"${value}" || {
    echo "Stable direct deployment liveness response is invalid." >&2
    exit 1
  }
done
grep -q '"status":"ready"' <<<"${public_ready}" || {
  echo "Stable direct Gateway readiness response is invalid." >&2
  exit 1
}
grep -Eiq '^strict-transport-security:.*max-age=' "${public_headers_file}" || {
  echo "Stable direct ingress is missing HSTS." >&2
  exit 1
}

certificate="$(
  timeout 20 openssl s_client \
    -connect "${hostname}:443" \
    -servername "${hostname}" \
    </dev/null 2>/dev/null |
    openssl x509 -outform PEM
)"
openssl x509 -in <(printf '%s\n' "${certificate}") \
  -checkhost "${hostname}" -noout >/dev/null
openssl x509 -in <(printf '%s\n' "${certificate}") \
  -checkend 1209600 -noout >/dev/null

quick_running=false
if [[ -n "$(docker_compose ps --status running -q cloudflared-quick)" ]]; then
  quick_running=true
fi

printf '{"status":"PASS","gateway":"%s","worker":"%s","tls":"trusted","hsts":true,"quickTunnelRunning":%s}\n' \
  "${origin}" "${worker_origin}" "${quick_running}"
