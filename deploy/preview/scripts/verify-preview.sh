#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREVIEW_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_ENV="${PREVIEW_DIR}/.runtime.env"

if [[ ! -f "${RUNTIME_ENV}" ]]; then
  echo "Missing ${RUNTIME_ENV}" >&2
  exit 1
fi

PUBLIC_ORIGIN="$(
  sed -n 's/^AI_EDITOR_PREVIEW_PUBLIC_ORIGIN=//p' "${RUNTIME_ENV}" | tail -n 1
)"
if [[ ! "${PUBLIC_ORIGIN}" =~ ^https://[^/]+$ ]]; then
  echo "Preview HTTPS origin is not configured." >&2
  exit 1
fi

assert_loopback_listener() {
  local port="$1"
  local label="$2"
  local listeners
  listeners="$(ss -lntH | awk -v expected=":${port}" '$4 ~ expected "$" { print $4 }')"
  if [[ -z "${listeners}" ]]; then
    echo "${label} is not listening on ${port}." >&2
    exit 1
  fi
  if grep -Eq '(^|:)0\.0\.0\.0:|\[::\]:' <<<"${listeners}"; then
    echo "${label} unexpectedly has a non-loopback listener: ${listeners}" >&2
    exit 1
  fi
  if ! grep -q "127.0.0.1:${port}" <<<"${listeners}"; then
    echo "${label} is not bound to 127.0.0.1:${port}: ${listeners}" >&2
    exit 1
  fi
}

for _ in $(seq 1 30); do
  if ss -lntH | grep -q '127.0.0.1:47920' \
    && ss -lntH | grep -q '127.0.0.1:47930'; then
    break
  fi
  sleep 1
done

assert_loopback_listener 47920 Gateway
assert_loopback_listener 47930 "Provider Worker"

LOCAL_LIVE="$(
  curl --fail --silent --show-error --retry 6 --retry-connrefused \
    --retry-delay 1 --max-time 5 http://127.0.0.1:47920/live
)"
WORKER_LIVE="$(
  curl --fail --silent --show-error --retry 6 --retry-connrefused \
    --retry-delay 1 --max-time 5 http://127.0.0.1:47930/live
)"
PUBLIC_LIVE="$(
  curl --fail --silent --show-error \
    --retry 6 --retry-all-errors --retry-delay 2 --max-time 15 \
    "${PUBLIC_ORIGIN}/live"
)"

grep -q '"status":"ok"' <<<"${LOCAL_LIVE}" || {
  echo "Gateway local liveness response is invalid." >&2
  exit 1
}
grep -q '"status":"ok"' <<<"${WORKER_LIVE}" || {
  echo "Provider Worker liveness response is invalid." >&2
  exit 1
}
grep -q '"status":"ok"' <<<"${PUBLIC_LIVE}" || {
  echo "Gateway public liveness response is invalid." >&2
  exit 1
}

if [[ "$(sed -n 's/^AI_EDITOR_WORKER_HTTPS_PROXY=//p' "${RUNTIME_ENV}" | tail -n 1)" != "" ]]; then
  assert_loopback_listener 7890 Mihomo
  status="$(
    curl --proxy http://127.0.0.1:7890 \
      --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --max-time 20 https://api.openai.com/v1/models || true
  )"
  if [[ "${status}" == "000" ]]; then
    echo "Mihomo could not reach the OpenAI HTTPS endpoint." >&2
    exit 1
  fi
fi

printf '{"status":"PASS","gateway":"127.0.0.1:47920","worker":"127.0.0.1:47930","publicOrigin":"%s"}\n' \
  "${PUBLIC_ORIGIN}"
