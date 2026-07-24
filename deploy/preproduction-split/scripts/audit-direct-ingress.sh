#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.gateway.runtime.env"

if [[ ! -s "${ENV_FILE}" ]]; then
  echo "Missing Gateway runtime environment: ${ENV_FILE}" >&2
  exit 1
fi

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

memory_mib="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
disk_gib="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
cpu_count="$(nproc)"
dns_ipv4="$(
  getent ahostsv4 "${hostname}" 2>/dev/null |
    awk '{ print $1 }' |
    sort -u |
    paste -sd, -
)"
gateway_listener="$(
  ss -lntH |
    awk '$4 ~ /:47920$/ { print $4 }' |
    paste -sd, -
)"
port_80_listener="$(
  ss -lntH |
    awk '$4 ~ /:80$/ { print $4 }' |
    paste -sd, -
)"
port_443_listener="$(
  ss -lntH |
    awk '$4 ~ /:443$/ { print $4 }' |
    paste -sd, -
)"
ufw_status="$(sudo -n ufw status 2>/dev/null | head -n 1 || true)"

dns_ready=false
if tr ',' '\n' <<<"${dns_ipv4}" | grep -Fxq "${expected_ipv4}"; then
  dns_ready=true
fi
gateway_loopback=false
if grep -Fxq '127.0.0.1:47920' <<<"${gateway_listener}"; then
  gateway_loopback=true
fi
mvp_capacity_ready=false
if (( cpu_count >= 2 && memory_mib >= 3500 && disk_gib >= 20 )); then
  mvp_capacity_ready=true
fi
long_term_capacity_ready=false
if (( cpu_count >= 4 && memory_mib >= 7000 && disk_gib >= 80 )); then
  long_term_capacity_ready=true
fi
ingress_ports_ready=false
if [[ -z "${port_80_listener}" && -z "${port_443_listener}" ]]; then
  ingress_ports_ready=true
elif sudo -n ss -lntpH |
  awk '$4 ~ /:(80|443)$/ { print }' |
  grep -Eq 'caddy|docker-proxy'; then
  ingress_ports_ready=true
fi
status=BLOCKED
if [[ "${dns_ready}" == true &&
  "${gateway_loopback}" == true &&
  "${mvp_capacity_ready}" == true &&
  "${ingress_ports_ready}" == true ]]; then
  status=READY
fi

cat <<EOF
{
  "status": "${status}",
  "origin": "${origin}",
  "expectedIpv4": "${expected_ipv4}",
  "dnsIpv4": "${dns_ipv4}",
  "dnsReady": ${dns_ready},
  "cpuCount": ${cpu_count},
  "memoryMiB": ${memory_mib},
  "diskFreeGiB": ${disk_gib},
  "mvpCapacityReady": ${mvp_capacity_ready},
  "longTermCapacityReady": ${long_term_capacity_ready},
  "ingressPortsReady": ${ingress_ports_ready},
  "gatewayLoopbackOnly": ${gateway_loopback},
  "gatewayListener": "${gateway_listener}",
  "port80Listener": "${port_80_listener}",
  "port443Listener": "${port_443_listener}",
  "ufwStatus": "${ufw_status}"
}
EOF
