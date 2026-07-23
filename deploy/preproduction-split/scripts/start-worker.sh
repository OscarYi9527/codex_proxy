#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.worker.runtime.env"
COMPOSE_FILE="${DEPLOY_DIR}/worker.compose.yaml"

docker_compose() {
  sudo docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

for file in \
  "${ENV_FILE}" \
  "${DEPLOY_DIR}/secrets/worker-mtls/ca.pem" \
  "${DEPLOY_DIR}/secrets/worker-mtls/worker.pem" \
  "${DEPLOY_DIR}/secrets/worker-mtls/worker-key.pem"; do
  if [[ ! -s "${file}" ]]; then
    echo "Required Worker secret is missing or empty: ${file}" >&2
    exit 1
  fi
done
if ! grep -Eq '^AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET=.{32,}$' "${ENV_FILE}"; then
  echo "Worker signing secret is missing or too short." >&2
  exit 1
fi

install -d -m 700 "${DEPLOY_DIR}/state/worker"
chmod 600 "${ENV_FILE}" "${DEPLOY_DIR}/secrets/worker-mtls/"*.pem
docker_compose build provider-worker
docker_compose up -d --force-recreate provider-worker
"${SCRIPT_DIR}/verify-worker.sh"
