#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREVIEW_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_ENV="${PREVIEW_DIR}/.runtime.env"
COMPOSE_FILE="${PREVIEW_DIR}/compose.yaml"
MODE="quick"
PUBLIC_ORIGIN=""
WITH_CLASH=0
EXECUTOR="mock"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/start-preview.sh [--quick] [--named https://preview.example.com]
                             [--with-clash] [--executor mock|chatgpt-sub]

Quick mode creates a temporary trycloudflare.com URL. Named mode requires
state/cloudflared/config.yml and its credentials JSON.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      MODE="quick"
      shift
      ;;
    --named)
      MODE="named"
      PUBLIC_ORIGIN="${2:-}"
      shift 2
      ;;
    --with-clash)
      WITH_CLASH=1
      shift
      ;;
    --executor)
      EXECUTOR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${EXECUTOR}" != "mock" && "${EXECUTOR}" != "chatgpt-sub" ]]; then
  echo "--executor must be mock or chatgpt-sub" >&2
  exit 2
fi
if [[ "${MODE}" == "named" && ! "${PUBLIC_ORIGIN}" =~ ^https://[^/]+$ ]]; then
  echo "--named requires an HTTPS origin without a path" >&2
  exit 2
fi

for command in docker openssl curl; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is missing: ${command}" >&2
    exit 1
  }
done
docker compose version >/dev/null

install -d -m 700 \
  "${PREVIEW_DIR}/state/gateway" \
  "${PREVIEW_DIR}/state/provider-worker" \
  "${PREVIEW_DIR}/state/cloudflared" \
  "${PREVIEW_DIR}/state/mihomo" \
  "${PREVIEW_DIR}/secrets"
touch "${RUNTIME_ENV}"
chmod 600 "${RUNTIME_ENV}"

set_env() {
  local name="$1"
  local value="$2"
  local temporary="${RUNTIME_ENV}.${$}.tmp"
  awk -F= -v key="${name}" '$1 != key { print }' "${RUNTIME_ENV}" > "${temporary}"
  printf '%s=%s\n' "${name}" "${value}" >> "${temporary}"
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${RUNTIME_ENV}"
}

get_env() {
  local name="$1"
  sed -n "s/^${name}=//p" "${RUNTIME_ENV}" | tail -n 1
}

if [[ -z "$(get_env AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET)" ]]; then
  set_env AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET \
    "$(openssl rand -base64 48 | tr -d '\r\n')"
fi
set_env AI_EDITOR_PREVIEW_EXECUTOR "${EXECUTOR}"
set_env AI_EDITOR_PREVIEW_UID "$(id -u)"
set_env AI_EDITOR_PREVIEW_GID "$(id -g)"
set_env AI_EDITOR_CLOUDFLARED_IMAGE \
  "$(get_env AI_EDITOR_CLOUDFLARED_IMAGE || true)"
set_env AI_EDITOR_MIHOMO_IMAGE \
  "$(get_env AI_EDITOR_MIHOMO_IMAGE || true)"
if [[ -z "$(get_env AI_EDITOR_CLOUDFLARED_IMAGE)" ]]; then
  set_env AI_EDITOR_CLOUDFLARED_IMAGE cloudflare/cloudflared:latest
fi
if [[ -z "$(get_env AI_EDITOR_MIHOMO_IMAGE)" ]]; then
  set_env AI_EDITOR_MIHOMO_IMAGE metacubex/mihomo:latest
fi
if [[ -z "$(get_env AI_EDITOR_CLOUDFLARED_PROTOCOL)" ]]; then
  set_env AI_EDITOR_CLOUDFLARED_PROTOCOL http2
fi
# Clash fake-IP DNS can leak through VMware NAT without the matching TUN
# route. Pin the two documented Cloudflare tunnel region hosts to real edge
# addresses for this disposable preview only. Operators can override either
# value in .runtime.env if Cloudflare rotates the selected edge.
if [[ -z "$(get_env AI_EDITOR_CLOUDFLARED_REGION1_IP)" ]]; then
  set_env AI_EDITOR_CLOUDFLARED_REGION1_IP 198.41.192.27
fi
if [[ -z "$(get_env AI_EDITOR_CLOUDFLARED_REGION2_IP)" ]]; then
  set_env AI_EDITOR_CLOUDFLARED_REGION2_IP 198.41.200.233
fi

compose() {
  docker compose --env-file "${RUNTIME_ENV}" -f "${COMPOSE_FILE}" "$@"
}

if [[ "${WITH_CLASH}" -eq 1 ]]; then
  if [[ ! -s "${PREVIEW_DIR}/state/mihomo/config.yaml" ]]; then
    echo "Mihomo config is missing. Run prepare-mihomo-config.py first." >&2
    exit 1
  fi
  chmod 600 "${PREVIEW_DIR}/state/mihomo/config.yaml"
  set_env AI_EDITOR_WORKER_HTTPS_PROXY http://127.0.0.1:7890
else
  set_env AI_EDITOR_WORKER_HTTPS_PROXY ""
fi

if [[ "${MODE}" == "quick" ]]; then
  set_env AI_EDITOR_PREVIEW_PUBLIC_ORIGIN https://pending.invalid
else
  set_env AI_EDITOR_PREVIEW_PUBLIC_ORIGIN "${PUBLIC_ORIGIN}"
fi

compose build
# Real-auth Gateway startup intentionally refuses to create an administrator
# in a background service. Run the one-time bootstrap in the foreground so
# its generated password is shown only to the operator. On later starts this
# is an idempotent no-op because the account database already exists.
compose run --rm --no-deps -T gateway node gateway/dist/bootstrap-cli.js
if [[ "${WITH_CLASH}" -eq 1 ]]; then
  compose --profile clash up -d mihomo
fi
compose up -d provider-worker

if [[ "${MODE}" == "quick" ]]; then
  compose --profile quick up -d --force-recreate cloudflared-quick
  PUBLIC_ORIGIN=""
  for _ in $(seq 1 90); do
    PUBLIC_ORIGIN="$(
      compose --profile quick logs --no-color cloudflared-quick 2>&1 \
        | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
        | grep -Ev '^https://api\.trycloudflare\.com$' \
        | tail -n 1 || true
    )"
    [[ -n "${PUBLIC_ORIGIN}" ]] && break
    sleep 1
  done
  if [[ -z "${PUBLIC_ORIGIN}" ]]; then
    echo "Cloudflare quick tunnel did not publish a URL within 90 seconds." >&2
    compose --profile quick logs --no-color --tail 80 cloudflared-quick >&2
    exit 1
  fi
  TUNNEL_CONNECTED=0
  for _ in $(seq 1 90); do
    if compose --profile quick logs --no-color cloudflared-quick 2>&1 \
      | grep -q 'Registered tunnel connection'; then
      TUNNEL_CONNECTED=1
      break
    fi
    sleep 1
  done
  if [[ "${TUNNEL_CONNECTED}" -ne 1 ]]; then
    echo "Cloudflare quick tunnel published a URL but did not connect within 90 seconds." >&2
    compose --profile quick logs --no-color --tail 120 cloudflared-quick >&2
    exit 1
  fi
else
  if [[ ! -s "${PREVIEW_DIR}/state/cloudflared/config.yml" ]]; then
    echo "Named tunnel config is missing: state/cloudflared/config.yml" >&2
    exit 1
  fi
fi

set_env AI_EDITOR_PREVIEW_PUBLIC_ORIGIN "${PUBLIC_ORIGIN}"
printf '%s\n' "${PUBLIC_ORIGIN}" > "${PREVIEW_DIR}/state/preview-origin.txt"
chmod 600 "${PREVIEW_DIR}/state/preview-origin.txt"

compose up -d --force-recreate gateway provider-worker
if [[ "${MODE}" == "named" ]]; then
  compose --profile named up -d cloudflared-named
fi

"${SCRIPT_DIR}/verify-preview.sh"
echo "Preview origin: ${PUBLIC_ORIGIN}"
echo "Use this only for the temporary invitation preview acceptance."
