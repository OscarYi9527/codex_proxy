#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
sudo docker compose \
  --env-file "${DEPLOY_DIR}/.gateway.runtime.env" \
  -f "${DEPLOY_DIR}/gateway.compose.yaml" down
