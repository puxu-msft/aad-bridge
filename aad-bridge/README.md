# aad-bridged

Centralized AAD token broker.
A **single `az login`** runs on one headless server; this daemon hands out **short-lived AAD access tokens** over HTTP(S) to internal machines, so developers never log in individually.
It is the server half of `aad-bridge` — the client half is the forked [kubelogin](../kubelogin/) `azurecli` login method pointed at `--token-endpoint`.

```
 headless server                                   internal dev machine
 ┌───────────────────────────┐                     ┌──────────────────────────┐
 │ az login  (device code)   │                     │ kubectl                  │
 │   └─ ~/.azure (MSAL cache) │   HTTPS (+mTLS)     │   └─ kubelogin           │
 │ aad-bridged ──────────────┼──── /token ◄────────┼──── --login azurecli     │
 │   • resource allowlist    │  access_token JSON  │     --token-endpoint ... │
 │   • token cache + refresh │ ───────────────────►│   └─ ExecCredential      │
 │   • audit log             │                     │       └─ AKS API server  │
 └───────────────────────────┘                     └──────────────────────────┘
```

Only minutes-lived access tokens for **allowlisted resources** cross the wire.
The refresh token never leaves the server.

## Wire contract

Matches the forked kubelogin's `HTTPTokenCredential`.

**Request** — `POST /token` (default) with JSON body, or `GET /token` with query params:

```json
{ "scope": "6dae42f8-4368-4678-94ff-3960e28e3630/.default",
  "tenantId": "<tenant-guid>",
  "serverId": "6dae42f8-4368-4678-94ff-3960e28e3630" }
```

The daemon resolves the resource from `serverId` (or derives it from `scope` by stripping `/.default`) and rejects anything not in `ALLOWED_RESOURCES`.

**Response** — OAuth2 token response:

```json
{ "access_token": "eyJ0...", "token_type": "Bearer",
  "expires_on": 1750859200, "expires_in": 3400 }
```

`expires_on` (absolute epoch seconds) is authoritative; kubelogin prefers it.

## Server setup

```bash
# 1. Install (example layout used by the systemd unit)
sudo mkdir -p /opt/aad-bridge && sudo cp -r aad-bridge /opt/aad-bridge/
sudo useradd --system --home /var/lib/aad-bridge --shell /usr/sbin/nologin aad-bridge
sudo mkdir -p /var/lib/aad-bridge/.azure /etc/aad-bridge
sudo chown -R aad-bridge:aad-bridge /var/lib/aad-bridge

# 2. One-time interactive login as the service identity (device code)
sudo -u aad-bridge AZURE_CONFIG_DIR=/var/lib/aad-bridge/.azure \
  /opt/aad-bridge/aad-bridge/scripts/login.sh

# 3. TLS cert (use your internal CA; self-signed shown for a quick start)
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout /etc/aad-bridge/server.key -out /etc/aad-bridge/server.crt \
  -subj "/CN=aad-bridge.internal" \
  -addext "subjectAltName=DNS:aad-bridge.internal"

# 4. Config + run
sudo cp aad-bridge/aad-bridge.env.example /etc/aad-bridge/aad-bridge.env
sudo "$EDITOR" /etc/aad-bridge/aad-bridge.env     # set SECRET, TLS paths
sudo cp aad-bridge/aad-bridged.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aad-bridged

# health
curl --cacert /etc/aad-bridge/server.crt https://aad-bridge.internal:8765/healthz
```

Run ad-hoc (no systemd):

```bash
SECRET=$(openssl rand -base64 32) \
AZURE_CONFIG_DIR=$HOME/.azure \
TLS_CERT=server.crt TLS_KEY=server.key \
node aad-bridge/server.js
```

### Config file (`aad-bridge.env`)

On startup the daemon **auto-loads `aad-bridge.env` from the current directory** if present — no `source` / `set -a` needed.
It only fills in vars that aren't already set, so precedence stays **CLI flags > real environment > `aad-bridge.env`**.
Point elsewhere with `--env-file <path>`, or disable with `--no-env-file`.

```bash
cp aad-bridge.env.example aad-bridge.env   # edit SECRET, TLS paths, ...
node dist/aad-bridged.js                    # picks up ./aad-bridge.env automatically
```

This is independent of the systemd `EnvironmentFile=` mechanism: systemd injects the file as real env vars, while the daemon's own loader handles the bundle-next-to-a-config case.
The file format is the same.

**Comments and Windows paths.**
Keep comments on their own lines — an inline `# comment` after a value is stripped by the daemon's loader but **not** by systemd, so a shared file stays portable only if comments are separate.
Path values support shell-style expansion: a leading `~`/`~/` becomes the daemon user's home, and `$VAR` / `${VAR}` expand from the environment — e.g. `AZURE_CONFIG_DIR=~/.azure` or `AUDIT_LOG=${HOME}/aad-bridge/audit.log`.
Use native Windows paths (`AUDIT_LOG=C:\ProgramData\aad-bridge\audit.log`); backslashes are preserved literally, and a path with spaces should be quoted (`TLS_CERT="C:\Program Files\aad-bridge\server.crt"`).
If the audit-log path is unwritable, the daemon warns and falls back to stdout rather than crashing.

## Build & distribute

The daemon bundles into a **single self-contained file** with no dependencies — copy it to any host with Node ≥18 and run it directly:

```bash
npm run build          # -> dist/aad-bridged.js  (zero-dep, ~27 KiB)

scp dist/aad-bridged.js server:/opt/aad-bridge/
node /opt/aad-bridge/aad-bridged.js --help
```

The bundler ([build.js](build.js)) inlines `server.js` + `lib/*.js` into one file and is itself dependency-free, so there is no toolchain to install.
When deploying the bundle, point the systemd unit's `ExecStart` at it: `ExecStart=/usr/bin/node /opt/aad-bridge/aad-bridged.js`.

A self-signed cert+key pair for quick starts can be generated with [scripts/gen-certs.sh](scripts/gen-certs.sh) (see below).

## Client setup (dev machines)

Distribute the daemon's CA cert and the shared secret, then point kubelogin at the endpoint.
`kubelogin convert-kubeconfig` writes the exec block:

```bash
export KUBELOGIN_TOKEN_ENDPOINT_SECRET="<the SECRET>"

kubelogin convert-kubeconfig \
  --login azurecli \
  --token-endpoint https://aad-bridge.internal:8765/token \
  --token-endpoint-header "Authorization=Bearer ${KUBELOGIN_TOKEN_ENDPOINT_SECRET}" \
  --token-endpoint-ca-file /etc/aad-bridge/ca.pem
```

Resulting kubeconfig user block:

```yaml
users:
- name: clusterUser_myrg_mycluster
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: kubelogin
      args:
        - get-token
        - --login=azurecli
        - --server-id=6dae42f8-4368-4678-94ff-3960e28e3630
        - --token-endpoint=https://aad-bridge.internal:8765/token
        - --token-endpoint-header=Authorization=Bearer <SECRET>
        - --token-endpoint-ca-file=/etc/aad-bridge/ca.pem
```

`kubectl` caches the returned token until expiry, so the daemon is hit roughly once per token lifetime per cluster — not per command.

> The secret appears in the kubeconfig.
> Prefer **mTLS** (`TLS_CLIENT_CA` on the server + per-machine client certs) where the secret is unnecessary and access is revocable per machine.

## Connectivity

The deployment model is **direct**: dev machines reach the daemon's HTTPS endpoint on the internal network, and kubelogin points straight at `https://<daemon-host>:8765/token`.
Make sure the daemon's server cert lists that host in its SAN (`gen-certs.sh --cn <daemon-host> --san DNS:<daemon-host>`), bind to the internal interface, and firewall the port to the dev subnet.

If you ever need to front an **isolated** daemon host (cloud VM / NAT / restricted segment that can't accept inbound), the sibling [`tunnel/`](../tunnel/) reverse tunnel can expose it without opening a port: run `connect` next to the daemon (`PROVIDER_PORT=8765`, dialing out) and `listen` on a relay the dev machines can reach.
Keep the daemon on **HTTPS** so TLS terminates at the daemon and the relay only ever forwards ciphertext — mTLS client certs survive end-to-end, so the relay stays untrusted.
In that case the server cert's SAN must list the **relay** host (what kubelogin connects to), not the daemon host.

## Configuration

Every setting has a CLI flag and an env var; **CLI flags win**.
Run `node server.js --help` for the full list.
Key ones:

| Flag / env | Default | Purpose |
|-----|---------|---------|
| `--secret` / `SECRET` | — | Shared bearer secret (required unless mTLS or dev no-auth) |
| `--tls-cert` `--tls-key` / `TLS_CERT` `TLS_KEY` | — | Enable HTTPS with custom certs |
| `--tls-client-ca` / `TLS_CLIENT_CA` | — | Enable mTLS (per-machine client certs) |
| `--allowed-resources` / `ALLOWED_RESOURCES` | AKS server app ID | Resource allowlist (app IDs and/or resource URLs) |
| `--subscription` / `SUBSCRIPTION` | az default | Subscription passed to `az` for every mint |
| `--allowed-subscriptions` / `ALLOWED_SUBSCRIPTIONS` | any | Restrict the effective subscription a caller may use |
| `--azure-config-dir` / `AZURE_CONFIG_DIR` | `~/.azure` | Where the daemon's `az login` cache lives |
| `--refresh-skew-seconds` / `REFRESH_SKEW_SECONDS` | `300` | Refresh a cached token this early |
| `--keepalive-minutes` / `KEEPALIVE_MINUTES` | `360` | Keep the refresh token warm (0 = off) |
| `--audit-log` / `AUDIT_LOG` | stdout | Per-request audit log path |
| `--cache-max-entries` / `CACHE_MAX_ENTRIES` | `256` | LRU cap on the token cache (0 = unbounded) |
| `--no-access-log` / `ACCESS_LOG=0` | on | Disable the per-request access log |
| `--insecure-no-auth` / `ALLOW_NO_AUTH` | off | **DEV ONLY** — disable caller auth |
| `--allow-any-resource` / `ALLOW_ANY_RESOURCE` | off | **DEV ONLY** — skip the resource allowlist |

See [`aad-bridge.env.example`](aad-bridge.env.example) for the full annotated env file.

### Scope protection: resources and subscriptions

Two independent axes constrain what the daemon will mint:

- **Resource allowlist** (`ALLOWED_RESOURCES`) — *what* audience. Defaults to just the AKS server app ID. Add ARM (`https://management.azure.com/`), Key Vault, etc. as your needs grow. A caller can never obtain a token for a resource not on the list (403).
- **Subscription** (`SUBSCRIPTION` + optional `ALLOWED_SUBSCRIPTIONS`) — *which* subscription context `az` mints in. Set a default and, if you like, an allowlist; a request asking for a subscription outside it is rejected (403). Useful once you broaden beyond the AKS app-id token (which is subscription-independent) to ARM-scoped tokens.

### Dev / test mode

For local iteration, skip TLS, auth, and the allowlist via CLI flags (each prints a loud warning and must never be used on a shared network):

```bash
AZ_PATH=az node aad-bridge/server.js \
  --insecure-no-auth --allow-any-resource --subscription Dev-Sub --keepalive-minutes 0
```

## Operations

- **Re-login.** When the refresh token dies (conditional access / ~90-day idle / MFA), `/token` returns `503 {"needs_login":true}` and `/healthz` reports `needs_login`. Re-run `scripts/login.sh` as the service user. Wire `/healthz` into monitoring.
- **Audit.** With one shared identity, **Azure-side logs cannot distinguish developers** — every `kubectl` action is attributed to the one principal, and Kubernetes RBAC sees that principal's groups. The daemon's audit log (caller IP + mTLS CN → resource) is your *only* per-developer record. Retain and protect it. If per-developer Azure attribution becomes a requirement, move to the per-developer identity model (the wire contract is unchanged).
- **Blast radius.** Tokens are short-lived and resource-scoped; a leaked one expires in minutes and only works against allowlisted resources. Keep `ALLOWED_RESOURCES` minimal.
- **Network.** Bind to the internal interface and firewall `/token` to the dev subnet. Never expose to the internet.
- **Graceful shutdown.** On `SIGINT`/`SIGTERM` the daemon stops the keepalive, drains in-flight requests (`server.close`), and flushes the audit log before exiting — so a systemd restart or redeploy won't cut active token mints or lose audit lines.

## Observability

This is an internal-network dev tool, so it leans toward exposing debugging information rather than locking it down.

- **`/healthz`** — liveness plus `version`, `pid`, `uptimeSec`, login state, and the active allowlists. Returns `503` with `status:"needs_login"` when the refresh token has died.
- **`/debug`** — a full dump for troubleshooting: redacted config (the bearer **secret is never shown**), token-cache metadata (resource / expiry / staleness — **token values are never shown**), recent requests, and the last error in full. Unauthenticated, like `/healthz`.
- **Access log** — one JSON line per request to stdout for *every* path (`/token`, `/healthz`, `/debug`, `404`s), with `method`, `path`, `status`, `ms`, and `ip`. On by default; disable with `--no-access-log` / `ACCESS_LOG=0`. This is separate from the security audit log (which records token issuance, denials, and the mTLS CN).

```bash
curl -s localhost:8765/debug | jq .          # config + cache + recent requests
curl -s localhost:8765/healthz | jq .status  # ok | needs_login
```

## Platform support

Runs on **Linux, macOS, and native Windows** (Node ≥18).
The daemon shells out to the Azure CLI; on Windows `az` is the `az.cmd` batch launcher, which Node won't spawn directly, so [lib/az.js](lib/az.js) routes through `cmd.exe` with verbatim, self-quoted arguments (subscription display names may contain spaces).
WSL2 works with no special handling.

The helper scripts ([scripts/login.sh](scripts/login.sh), [scripts/gen-certs.sh](scripts/gen-certs.sh)) and the systemd unit are Linux-oriented.
On native Windows, run `az login --use-device-code` directly, generate certs with `New-SelfSignedCertificate` (or openssl), and host the bundle as a service via NSSM or `sc.exe`.

## Testing

Zero-dependency suite built on Node's built-in test runner and coverage:

```bash
npm test            # node --test, 52 tests
npm run test:coverage
```

Unit tests cover config precedence, env-file parsing (including inline-comment and Windows-path handling), request parsing, token-cache (TTL / single-flight / refresh / LRU eviction), auth (bearer + mTLS), the audit fallback, and the az wrapper (expiry, re-auth detection, Windows cmd.exe routing).
The request handling lives in [lib/app.js](lib/app.js) and is driven in-process by [test/app.test.js](test/app.test.js) — `/token` (auth, allowlists, re-auth → 503), `/healthz`, `/debug`, the access log, and graceful shutdown.
A separate e2e test spawns the real `server.js` and exercises it over HTTP against a stub `az`.
Library coverage is ~95% lines / ~98% functions.

## Files

| Path | Role |
|------|------|
| `server.js` | Entry: load config, listen, banner, graceful-shutdown signals |
| `lib/app.js` | Request handling: routing, `/token` `/healthz` `/debug`, access log, keepalive, shutdown |
| `lib/config.js` | Env + CLI config and validation |
| `lib/args.js` | Zero-dep CLI flag parser |
| `lib/envfile.js` | Auto-load co-located `aad-bridge.env` |
| `lib/request.js` | Parse kubelogin's GET/POST token request |
| `lib/auth.js` | Timing-safe bearer + mTLS CN |
| `lib/az.js` | `az account get-access-token` wrapper + re-auth detection |
| `lib/token-cache.js` | Per-resource cache with single-flight refresh |
| `lib/audit.js` | Structured audit log |
| `build.js` | Zero-dep bundler → `dist/aad-bridged.js` |
| `scripts/login.sh` | One-time device-code login helper |
| `scripts/gen-certs.sh` | Generate self-signed server (+ mTLS client) certs |
| `test/*.test.js` | node:test unit + e2e suite |
