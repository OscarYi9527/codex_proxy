#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
MTLS="${DEPLOY_DIR}/secrets/worker-mtls"
WORKER_IP="${AI_EDITOR_PREPRODUCTION_WORKER_IP:-43.156.27.252}"

for _ in $(seq 1 60); do
  if ss -lntH | grep -q ':47930'; then
    break
  fi
  sleep 1
done
listeners="$(ss -lntH | awk '$4 ~ /:47930$/ { print $4 }')"
grep -Eq '(^|:)0\.0\.0\.0:47930$|\[::\]:47930$' <<<"${listeners}" || {
  echo "Provider Worker is not listening publicly on 47930: ${listeners}" >&2
  exit 1
}

openssl verify -CAfile "${MTLS}/ca.pem" "${MTLS}/worker.pem" >/dev/null
openssl x509 -in "${MTLS}/worker.pem" -checkip "${WORKER_IP}" -noout >/dev/null

unauthorized="$(
  curl --silent --show-error --max-time 10 \
    --connect-to "${WORKER_IP}:47930:127.0.0.1:47930" \
    --cacert "${MTLS}/ca.pem" \
    --output /dev/null --write-out '%{http_code}' \
    "https://${WORKER_IP}:47930/live" || true
)"
if [[ "${unauthorized}" == "200" ]]; then
  echo "Provider Worker accepted a client without an mTLS certificate." >&2
  exit 1
fi

printf '{"status":"PASS","worker":"%s:47930","transport":"mtls-required"}\n' \
  "${WORKER_IP}"
