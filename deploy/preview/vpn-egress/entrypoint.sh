#!/bin/sh
set -eu

OPENVPN_CONFIG="${AI_EDITOR_OPENVPN_CONFIG:-/run/ai-editor-vpn/client.ovpn}"
OPENVPN_AUTH="${AI_EDITOR_OPENVPN_AUTH:-/run/ai-editor-vpn/auth}"
OPENVPN_LOG=/run/ai-editor-vpn/openvpn.log
OPENVPN_READY=/run/ai-editor-vpn/ready

require_private_file() {
  path="$1"
  label="$2"
  if [ ! -s "${path}" ]; then
    echo "${label} is missing or empty: ${path}" >&2
    exit 1
  fi
  mode="$(stat -c '%a' "${path}")"
  case "${mode}" in
    600|400) ;;
    *)
      echo "${label} must have mode 0600 or 0400 inside the container; got ${mode}." >&2
      exit 1
      ;;
  esac
}

require_private_file "${OPENVPN_CONFIG}" "OpenVPN configuration"
require_private_file "${OPENVPN_AUTH}" "OpenVPN auth file"

auth_lines="$(awk 'END { print NR }' "${OPENVPN_AUTH}")"
if [ "${auth_lines}" -lt 2 ]; then
  echo "OpenVPN auth file must contain username and password on separate lines." >&2
  exit 1
fi

install -d -m 0750 -o root -g root /run/ai-editor-vpn
install -d -m 0750 -o tinyproxy -g tinyproxy /run/tinyproxy
rm -f "${OPENVPN_READY}" "${OPENVPN_LOG}"

cleanup() {
  trap - TERM INT EXIT
  if [ -n "${TINYPROXY_PID:-}" ]; then
    kill "${TINYPROXY_PID}" 2>/dev/null || true
  fi
  if [ -n "${OPENVPN_PID:-}" ]; then
    kill "${OPENVPN_PID}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

openvpn \
  --config "${OPENVPN_CONFIG}" \
  --auth-user-pass "${OPENVPN_AUTH}" \
  --auth-nocache \
  --remote-cert-tls server \
  --log "${OPENVPN_LOG}" &
OPENVPN_PID=$!

ready=0
attempt=0
while [ "${attempt}" -lt 60 ]; do
  attempt=$((attempt + 1))
  if grep -q 'Initialization Sequence Completed' "${OPENVPN_LOG}" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "${OPENVPN_PID}" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "${ready}" -ne 1 ]; then
  echo "OpenVPN did not become ready." >&2
  tail -80 "${OPENVPN_LOG}" >&2 2>/dev/null || true
  exit 1
fi

touch "${OPENVPN_READY}"
tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf &
TINYPROXY_PID=$!

while kill -0 "${OPENVPN_PID}" 2>/dev/null \
  && kill -0 "${TINYPROXY_PID}" 2>/dev/null; do
  sleep 2
done

echo "VPN egress process exited unexpectedly." >&2
tail -80 "${OPENVPN_LOG}" >&2 2>/dev/null || true
exit 1
