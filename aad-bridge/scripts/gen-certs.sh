#!/usr/bin/env bash
#
# Generate self-signed TLS material for aad-bridged.
#
# Always creates a server cert + key (for HTTPS).
# With --mtls it also creates a client CA and one client cert/key pair (for mutual TLS), so you can require per-machine client certs via TLS_CLIENT_CA.
#
# Usage:
#   ./gen-certs.sh                                  # server cert for aad-bridge.internal
#   ./gen-certs.sh --cn aad.lan --san DNS:aad.lan --san IP:10.0.0.5
#   ./gen-certs.sh --mtls --client dev-laptop-01    # also emit a client cert
#
# Outputs (default --out ./certs):
#   server.crt  server.key                          # daemon: TLS_CERT / TLS_KEY
#   ca.crt      ca.key        (only with --mtls)    # daemon: TLS_CLIENT_CA = ca.crt
#   <client>.crt <client>.key (only with --mtls)    # one dev machine's client cert

set -euo pipefail

CN="aad-bridge.internal"
DAYS=825
OUT="./certs"
MTLS=0
CLIENT="client"
SANS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cn) CN="$2"; shift 2 ;;
    --san) SANS+=("$2"); shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --mtls) MTLS=1; shift ;;
    --client) CLIENT="$2"; MTLS=1; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }

# Default SAN to the CN as a DNS name if none provided.
if [[ ${#SANS[@]} -eq 0 ]]; then SANS=("DNS:${CN}"); fi
SAN_CSV=$(IFS=,; echo "${SANS[*]}")

mkdir -p "$OUT"
umask 077  # private keys must not be world/group readable

echo "==> server cert  CN=${CN}  SAN=${SAN_CSV}  days=${DAYS}"
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout "$OUT/server.key" -out "$OUT/server.crt" \
  -subj "/CN=${CN}" -addext "subjectAltName=${SAN_CSV}" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

if [[ "$MTLS" -eq 1 ]]; then
  echo "==> client CA"
  openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
    -keyout "$OUT/ca.key" -out "$OUT/ca.crt" \
    -subj "/CN=aad-bridge client CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

  echo "==> client cert  CN=${CLIENT}"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$OUT/${CLIENT}.key" -out "$OUT/${CLIENT}.csr" \
    -subj "/CN=${CLIENT}" 2>/dev/null
  openssl x509 -req -in "$OUT/${CLIENT}.csr" -days "$DAYS" \
    -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
    -extfile <(printf 'keyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n') \
    -out "$OUT/${CLIENT}.crt" 2>/dev/null
  rm -f "$OUT/${CLIENT}.csr" "$OUT/ca.srl"
fi

echo
echo "Generated in ${OUT}:"
ls -1 "$OUT"
echo
echo "Server (HTTPS):   TLS_CERT=${OUT}/server.crt  TLS_KEY=${OUT}/server.key"
if [[ "$MTLS" -eq 1 ]]; then
  echo "Server (mTLS):    TLS_CLIENT_CA=${OUT}/ca.crt"
  echo "Client machine:   distribute ${OUT}/${CLIENT}.crt + ${OUT}/${CLIENT}.key + ${OUT}/server.crt (as CA)"
fi
echo "Client trust:     kubelogin --token-endpoint-ca-file ${OUT}/server.crt"
echo
echo "NOTE: self-signed, for internal/dev use. For production prefer your org's internal CA."
