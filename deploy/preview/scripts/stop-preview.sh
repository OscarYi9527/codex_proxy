#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREVIEW_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_ENV="${PREVIEW_DIR}/.runtime.env"

if [[ ! -f "${RUNTIME_ENV}" ]]; then
  echo "Preview runtime file does not exist; nothing to stop."
  exit 0
fi

docker compose \
  --env-file "${RUNTIME_ENV}" \
  -f "${PREVIEW_DIR}/compose.yaml" \
  --profile quick \
  --profile named \
  --profile clash \
  --profile openvpn \
  down
