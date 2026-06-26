#!/usr/bin/env bash
#
# setup-kubeconfig.sh — wire a kubeconfig user to kubelogin-http-shim using kubectl's native `config set-credentials`, so you never hand-edit YAML.
#
# This is the drop-in equivalent of `kubelogin convert-kubeconfig`, but it points the exec command at this shim instead of the Go kubelogin binary.
#
# Usage:
#   setup-kubeconfig.sh \
#     --user clusterUser_myrg_mycluster \
#     --server-id 6dae42f8-4368-4678-94ff-3960e28e3630 \
#     --token-endpoint https://aad-bridge.internal:8765/token \
#     [--header "Authorization=Bearer <secret>"] \
#     [--header-file /etc/aad-bridge/token-header] \
#     [--ca-file /etc/aad-bridge/ca.pem] \
#     [--cert /etc/aad-bridge/client.crt --key /etc/aad-bridge/client.key] \
#     [--method POST] \
#     [--command kubelogin-http-shim] \
#     [--api-version client.authentication.k8s.io/v1beta1] \
#     [--kubeconfig PATH]
#
set -euo pipefail

USER_NAME=""
SERVER_ID=""
TOKEN_ENDPOINT=""
HEADER=""
HEADER_FILE=""
CA_FILE=""
CERT=""
KEY=""
METHOD=""
COMMAND="kubelogin-http-shim"
API_VERSION="client.authentication.k8s.io/v1beta1"
KUBECONFIG_ARG=()

die() { echo "setup-kubeconfig: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)           USER_NAME="$2"; shift 2 ;;
    --server-id)      SERVER_ID="$2"; shift 2 ;;
    --token-endpoint) TOKEN_ENDPOINT="$2"; shift 2 ;;
    --header)         HEADER="$2"; shift 2 ;;
    --header-file)    HEADER_FILE="$2"; shift 2 ;;
    --ca-file)        CA_FILE="$2"; shift 2 ;;
    --cert)           CERT="$2"; shift 2 ;;
    --key)            KEY="$2"; shift 2 ;;
    --method)         METHOD="$2"; shift 2 ;;
    --command)        COMMAND="$2"; shift 2 ;;
    --api-version)    API_VERSION="$2"; shift 2 ;;
    --kubeconfig)     KUBECONFIG_ARG=(--kubeconfig "$2"); shift 2 ;;
    -h|--help)        sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

[[ -n "$USER_NAME" ]]      || die "--user is required"
[[ -n "$SERVER_ID" ]]      || die "--server-id is required"
[[ -n "$TOKEN_ENDPOINT" ]] || die "--token-endpoint is required"
command -v kubectl >/dev/null 2>&1 || die "kubectl not found in PATH"

# Build the --exec-arg list mirroring what the shim parses.
ARGS=(
  "--exec-command=${COMMAND}"
  "--exec-api-version=${API_VERSION}"
  "--exec-arg=get-token"
  "--exec-arg=--login=azurecli"
  "--exec-arg=--server-id=${SERVER_ID}"
  "--exec-arg=--token-endpoint=${TOKEN_ENDPOINT}"
)
[[ -n "$METHOD" ]] && ARGS+=("--exec-arg=--token-endpoint-method=${METHOD}")
[[ -n "$HEADER" ]] && ARGS+=("--exec-arg=--token-endpoint-header=${HEADER}")
[[ -n "$HEADER_FILE" ]] && ARGS+=("--exec-arg=--token-endpoint-header-file=${HEADER_FILE}")
[[ -n "$CA_FILE" ]] && ARGS+=("--exec-arg=--token-endpoint-ca-file=${CA_FILE}")
[[ -n "$CERT" ]] && ARGS+=("--exec-arg=--token-endpoint-cert=${CERT}")
[[ -n "$KEY" ]] && ARGS+=("--exec-arg=--token-endpoint-key=${KEY}")

kubectl "${KUBECONFIG_ARG[@]}" config set-credentials "$USER_NAME" "${ARGS[@]}"

# The kubeconfig may now reference a bearer secret (cleartext via --header, or a path via --header-file). Tighten permissions on whatever holds a secret.
TARGET="${KUBECONFIG_ARG[1]:-${KUBECONFIG:-$HOME/.kube/config}}"
if [[ -f "$TARGET" ]]; then
  chmod 600 "$TARGET" || echo "setup-kubeconfig: warning: could not chmod 600 $TARGET" >&2
fi
if [[ -n "$HEADER_FILE" && -f "$HEADER_FILE" ]]; then
  chmod 600 "$HEADER_FILE" || echo "setup-kubeconfig: warning: could not chmod 600 $HEADER_FILE" >&2
fi

echo "configured user '${USER_NAME}' to use ${COMMAND} (${API_VERSION})" >&2
if [[ -n "$HEADER" && -z "$CERT" ]]; then
  echo "setup-kubeconfig: note: a bearer secret was written to ${TARGET} in cleartext;" >&2
  echo "                 prefer --header-file (keeps it out of the kubeconfig) or mTLS (--cert/--key)." >&2
fi
