#!/usr/bin/env bash
#
# Interactively log the daemon's dedicated Azure identity in via device code.
# Run this once on the headless server (and again if /healthz reports needs_login).
# It uses a dedicated AZURE_CONFIG_DIR so the daemon's identity is isolated from any personal `az login` on the box.
#
# Usage:
#   AZURE_CONFIG_DIR=/var/lib/aad-bridge/.azure ./scripts/login.sh [--tenant <id>]

set -euo pipefail

: "${AZURE_CONFIG_DIR:=/var/lib/aad-bridge/.azure}"
export AZURE_CONFIG_DIR

mkdir -p "$AZURE_CONFIG_DIR"

echo "Logging in with AZURE_CONFIG_DIR=$AZURE_CONFIG_DIR"
echo "A device-code prompt will appear; complete it in a browser on any machine."
echo

# --use-device-code is mandatory on a headless box (no local browser).
az login --use-device-code "$@"

echo
echo "Verifying token issuance for the AKS AAD server app ..."
az account get-access-token \
  --resource 6dae42f8-4368-4678-94ff-3960e28e3630 \
  --query "expiresOn" --output tsv >/dev/null

echo "OK. The daemon can now mint AKS tokens for this identity."
echo "Make sure the daemon runs with AZURE_CONFIG_DIR=$AZURE_CONFIG_DIR"
