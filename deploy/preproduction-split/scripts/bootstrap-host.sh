#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This bootstrap supports Linux only." >&2
  exit 1
fi

sudo -n true
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl git openssl docker.io docker-compose-v2
sudo systemctl enable --now docker

if ! sudo docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is unavailable after installation." >&2
  exit 1
fi

echo "Preproduction host prerequisites are ready."
