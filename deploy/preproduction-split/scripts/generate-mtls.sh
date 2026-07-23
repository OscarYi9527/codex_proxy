#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <worker-public-ip> <output-directory>" >&2
  exit 2
fi

WORKER_IP="$1"
OUTPUT="$(realpath -m "$2")"
if [[ ! "${WORKER_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Worker address must be an IPv4 literal." >&2
  exit 2
fi
if [[ -e "${OUTPUT}" && -n "$(find "${OUTPUT}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Refusing to overwrite non-empty certificate directory: ${OUTPUT}" >&2
  exit 1
fi

umask 077
install -d -m 700 "${OUTPUT}"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "${OUTPUT}/ca-key.pem"
openssl req -x509 -new -sha256 -days 825 \
  -key "${OUTPUT}/ca-key.pem" \
  -subj '/CN=TORVYE Preproduction Provider CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out "${OUTPUT}/ca.pem"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "${OUTPUT}/worker-key.pem"
openssl req -new -sha256 \
  -key "${OUTPUT}/worker-key.pem" \
  -subj '/CN=worker-preprod-sg' \
  -out "${OUTPUT}/worker.csr"
cat > "${OUTPUT}/worker.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:${WORKER_IP},IP:127.0.0.1
EOF
openssl x509 -req -sha256 -days 397 \
  -in "${OUTPUT}/worker.csr" \
  -CA "${OUTPUT}/ca.pem" \
  -CAkey "${OUTPUT}/ca-key.pem" \
  -CAcreateserial \
  -extfile "${OUTPUT}/worker.ext" \
  -out "${OUTPUT}/worker.pem"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "${OUTPUT}/gateway-client-key.pem"
openssl req -new -sha256 \
  -key "${OUTPUT}/gateway-client-key.pem" \
  -subj '/CN=gateway-preprod-cn' \
  -out "${OUTPUT}/gateway-client.csr"
cat > "${OUTPUT}/gateway-client.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EOF
openssl x509 -req -sha256 -days 397 \
  -in "${OUTPUT}/gateway-client.csr" \
  -CA "${OUTPUT}/ca.pem" \
  -CAkey "${OUTPUT}/ca-key.pem" \
  -CAcreateserial \
  -extfile "${OUTPUT}/gateway-client.ext" \
  -out "${OUTPUT}/gateway-client.pem"

openssl verify -CAfile "${OUTPUT}/ca.pem" \
  "${OUTPUT}/worker.pem" "${OUTPUT}/gateway-client.pem"
rm -f \
  "${OUTPUT}/worker.csr" \
  "${OUTPUT}/worker.ext" \
  "${OUTPUT}/gateway-client.csr" \
  "${OUTPUT}/gateway-client.ext" \
  "${OUTPUT}/ca.srl"
chmod 600 "${OUTPUT}"/*.pem
echo "mTLS material generated in ${OUTPUT}; protect ca-key.pem offline."
