#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.gateway.runtime.env"
MTLS="${DEPLOY_DIR}/secrets/gateway-mtls"

public_origin="$(
  sed -n 's/^AI_EDITOR_PREPRODUCTION_PUBLIC_ORIGIN=//p' "${ENV_FILE}" | tail -n 1
)"
worker_origin="$(
  sed -n 's/^AI_EDITOR_PREPRODUCTION_WORKER_ORIGIN=//p' "${ENV_FILE}" | tail -n 1
)"
if [[ ! "${public_origin}" =~ ^https://[^/]+$ ]]; then
  echo "Gateway public HTTPS origin is missing." >&2
  exit 1
fi

for _ in $(seq 1 60); do
  if ss -lntH | grep -q '127.0.0.1:47920'; then
    break
  fi
  sleep 1
done
listeners="$(ss -lntH | awk '$4 ~ /:47920$/ { print $4 }')"
if ! grep -q '127.0.0.1:47920' <<<"${listeners}" ||
  grep -Eq '(^|:)0\.0\.0\.0:47920$|\[::\]:47920$' <<<"${listeners}"; then
  echo "Gateway must listen only on 127.0.0.1:47920: ${listeners}" >&2
  exit 1
fi

local_live="$(
  curl --fail --silent --show-error --retry 10 --retry-connrefused \
    --retry-delay 1 --max-time 10 http://127.0.0.1:47920/live
)"
public_live="$(
  curl --fail --silent --show-error --retry 30 --retry-all-errors \
    --retry-delay 2 --max-time 15 "${public_origin}/live"
)"
worker_live="$(
  curl --fail --silent --show-error --max-time 15 \
    --cacert "${MTLS}/ca.pem" \
    --cert "${MTLS}/gateway-client.pem" \
    --key "${MTLS}/gateway-client-key.pem" \
    "${worker_origin}/live"
)"
for value in "${local_live}" "${public_live}" "${worker_live}"; do
  grep -q '"status":"ok"' <<<"${value}" || {
    echo "Split preproduction liveness response is invalid." >&2
    exit 1
  }
done

printf '{"status":"PASS","gateway":"127.0.0.1:47920","worker":"%s","publicOrigin":"%s"}\n' \
  "${worker_origin}" "${public_origin}"
