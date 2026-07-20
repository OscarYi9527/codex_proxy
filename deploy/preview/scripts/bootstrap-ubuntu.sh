#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as the normal Ubuntu user; it will use sudo." >&2
  exit 1
fi

VMWARE_HOST_CIDR="${AI_EDITOR_VMWARE_HOST_CIDR:-192.168.149.0/24}"

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  git \
  jq \
  openssh-server \
  open-vm-tools \
  openssl \
  python3 \
  python3-yaml \
  ufw

sudo systemctl enable --now docker
sudo systemctl enable --now ssh
sudo systemctl enable --now open-vm-tools
sudo usermod -aG docker "${USER}"

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from "${VMWARE_HOST_CIDR}" to any port 22 proto tcp
sudo ufw --force enable

memory_mb="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
disk_gb="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
if (( memory_mb < 7000 )); then
  echo "At least 7 GB RAM is required for the preview VM; found ${memory_mb} MB." >&2
  exit 1
fi
if (( disk_gb < 20 )); then
  echo "At least 20 GB free disk is required; found ${disk_gb} GB." >&2
  exit 1
fi

echo "Ubuntu preview prerequisites are ready."
echo "Sign out and back in once so Docker group membership takes effect."
echo "VMware Tools and SSH are enabled; inbound access is limited to ${VMWARE_HOST_CIDR}."
