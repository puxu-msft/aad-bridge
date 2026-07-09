# kubelogin-http-shim

A **zero-dependency kubectl exec credential plugin** that replaces Azure [kubelogin](https://github.com/Azure/kubelogin) for the one path the [aad-bridge](../aad-bridge/) setup actually uses: fetch a short-lived AAD access token from an HTTP endpoint and hand it to `kubectl`.

The Go kubelogin binary supports dozens of login methods (device code, MSI, SPN, PoP, persistent caches…).
The aad-bridge link uses exactly one of them — `azurecli` with `--token-endpoint` — which boils down to four steps:

1. derive the OAuth2 scope from `--server-id` (`<app-id>` + `/.default`)
2. `POST`/`GET` `{scope, tenantId, serverId}` to the token endpoint (with CA / headers / mTLS)
3. read back `{access_token, expires_on}`
4. emit the `ExecCredential` JSON `kubectl` expects on stdout, echoing the apiVersion from `KUBERNETES_EXEC_INFO`

That is the entire kubectl exec credential plugin contract — `kubectl` only cares about `command` + `args` + the stdout JSON, not whether a Go binary produced it.
So this small Node script is a **drop-in** replacement: swap `command: kubelogin` for `command: kubelogin-http-shim` in your kubeconfig and the `args` stay byte-for-byte identical.
Each `kubectl` invocation is a fresh process, and `kubectl`'s own credential cache lives only in that process's memory — so without a local cache every call would re-hit the endpoint. The shim therefore keeps a small on-disk cache (like the Go kubelogin's `--token-cache-dir`) so a token is reused across invocations until it nears expiry. See [Token cache](#token-cache).

```
 kubectl ──exec──> kubelogin-http-shim ──HTTPS (+CA/mTLS)──> aad-bridge /token
                          │                                        │
   KUBERNETES_EXEC_INFO ──┘                       access_token + expires_on
   (apiVersion)                                                    │
        ExecCredential JSON  <──────────────────────────────────────┘
```

## Requirements

- Node.js ≥ 18 on each dev machine (no other dependencies)
- An [aad-bridge](../aad-bridge/) token endpoint to talk to

## Install

Either run from source, or build the single-file bundle and drop it anywhere on `PATH`:

```bash
npm run build                     # -> dist/kubelogin-http-shim.js (~21 KiB, zero-dep)

sudo install -m 0755 dist/kubelogin-http-shim.js /usr/local/bin/kubelogin-http-shim
kubelogin-http-shim --version
```

The bundle inlines `bin/` + `lib/*` into one self-contained file via the dependency-free [build.js](build.js) (same approach as aad-bridge's daemon).

## Wire it into kubeconfig

Use the helper, which calls `kubectl config set-credentials` under the hood (no hand-edited YAML):

```bash
scripts/setup-kubeconfig.sh \
  --user clusterUser_myrg_mycluster \
  --server-id 6dae42f8-4368-4678-94ff-3960e28e3630 \
  --token-endpoint https://aad-bridge.internal:8765/token \
  --header "Authorization=Bearer ${KUBELOGIN_TOKEN_ENDPOINT_SECRET}" \
  --ca-file /etc/aad-bridge/ca.pem
```

Or write the exec block by hand — identical to kubelogin's, only `command` changes:

```yaml
users:
- name: clusterUser_myrg_mycluster
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: kubelogin-http-shim
      args:
        - get-token
        - --login=azurecli
        - --server-id=6dae42f8-4368-4678-94ff-3960e28e3630
        - --token-endpoint=https://aad-bridge.internal:8765/token
        - --token-endpoint-header=Authorization=Bearer <SECRET>
        - --token-endpoint-ca-file=/etc/aad-bridge/ca.pem
```

**Migrating an existing kubeconfig** produced by `kubelogin convert-kubeconfig`: change `command: kubelogin` to `command: kubelogin-http-shim` and you're done — the `args` are already compatible.

## Flags

All flag names match kubelogin's `get-token`, so existing args carry over.

| Flag | Purpose |
|------|---------|
| `--server-id` | AAD server application ID (**required**) → scope |
| `-t`, `--tenant-id` | AAD tenant ID (optional) |
| `--token-endpoint` | HTTP(S) endpoint (**required**, or env `AAD_TOKEN_ENDPOINT`) |
| `--token-endpoint-method` | `GET` or `POST` (default `POST`) |
| `--token-endpoint-header` | static header `key=value`, repeatable (e.g. `Authorization=Bearer …`) |
| `--token-endpoint-header-file` | file of `key=value` headers, repeatable — keeps the secret out of argv / kubeconfig |
| `--token-endpoint-ca-file` | PEM CA bundle to verify the endpoint's TLS cert |
| `--token-endpoint-cert` / `--token-endpoint-key` | **client cert for mTLS** to the endpoint |
| `--token-endpoint-insecure-skip-tls-verify` | skip TLS verification (test only) |
| `--token-cache-dir` | disk cache dir (env `AAD_TOKEN_CACHE_DIR`; default `~/.kube/cache/kubelogin-http-shim`; `""` disables) |
| `--disable-token-cache` | turn off the disk cache (env `AAD_DISABLE_TOKEN_CACHE`) |
| `--token-cache-refresh-skew` | refresh a cached token this many seconds before expiry (env `AAD_TOKEN_CACHE_REFRESH_SKEW`; default `300`) |
| `-l`, `--login` | accepted for compatibility, **ignored** (always HTTP) |

Unrecognized kubelogin flags (e.g. `--environment`, `--pop-enabled`) are tolerated with a warning on stderr rather than failing, keeping the swap painless.
A mistyped `--token-endpoint-*` flag is the exception — it's a hard error, so a misspelled `--token-endpoint-ca-file` can't silently drop CA pinning.

### Keeping the bearer secret out of argv

`--token-endpoint-header=Authorization=Bearer <secret>` puts the secret in the process arguments (visible via `ps` / `/proc/<pid>/cmdline`) and in the kubeconfig.
On shared machines, prefer one of:

- **mTLS** — `--token-endpoint-cert` / `--token-endpoint-key`; no shared secret at all.
- **`--token-endpoint-header-file <path>`** — a `chmod 600` file with one `key=value` header per line (`#` comments and blank lines allowed). The secret lives only in that file; the kubeconfig and argv carry just the path.

```bash
printf 'Authorization=Bearer %s\n' "$SECRET" > ~/.config/aad-bridge/token-header
chmod 600 ~/.config/aad-bridge/token-header
# kubeconfig arg: --token-endpoint-header-file=/home/you/.config/aad-bridge/token-header
```

### mTLS to the endpoint

`--token-endpoint-cert` / `--token-endpoint-key` are an addition over the Go fork, which can only verify the server cert.
They let a dev machine present a client certificate, matching aad-bridge's `TLS_CLIENT_CA` mode where access is revocable per machine and no shared bearer secret is needed.

## Token cache

`kubectl` re-runs the plugin as a new process on every command, so the shim caches the access token on disk to avoid a round-trip to aad-bridge each time. The cache is **on by default**.

- **Location** — `~/.kube/cache/kubelogin-http-shim/` (override with `--token-cache-dir` or `AAD_TOKEN_CACHE_DIR`), one file per `(endpoint, scope, tenant)`, filename `sha256(...).json`.
- **Reuse window** — a cached token is served while more than `--token-cache-refresh-skew` seconds (default 300) remain before its expiry; otherwise the shim fetches a fresh one. This mirrors aad-bridge's own server-side `REFRESH_SKEW_SECONDS` so both layers agree on the safety margin.
- **Best-effort** — any cache read/write/parse error falls back to a live fetch (with a stderr warning); a corrupt or malformed entry is treated as a miss. Tokens with unknown expiry are never cached.
- **Disable** — `--disable-token-cache` (or `AAD_DISABLE_TOKEN_CACHE=1`, or `--token-cache-dir=""`).

> ⚠️ The cache stores the **bearer access token in cleartext** on disk, exactly as the Go kubelogin's own cache does. Files are written `0600` inside a `0700` directory, so keep the cache dir on a filesystem private to the user. On a shared or untrusted machine, disable the cache.

## Not supported (by design)

- **PoP tokens** (`--pop-enabled`) — needs client-side RSA signing; the aad-bridge link uses plain bearer tokens.
- Local `az` login and every other non-HTTP kubelogin login method.

If you need those, keep using the Go kubelogin binary for that cluster.

## Develop & test

```bash
npm test               # node --test, 65 tests
npm run test:coverage  # ~96% lines
npm run build          # bundle
```

Tests are a zero-dependency `node:test` suite: scope/flag parsing, the HTTP token exchange (POST body, GET query, header pass-through, header files, `expires_on` precedence, non-2xx errors with control-char sanitization, CA/mTLS option wiring), ExecCredential rendering (v1 / v1beta1 / default), the disk cache (round-trip, skew, corrupt/malformed misses, disabled, permissions), and an e2e suite that spawns the real CLI against a stub endpoint and asserts a second call is served from cache.

## Files

| Path | Role |
|------|------|
| `bin/kubelogin-http-shim` | entry: parse args → cache lookup → fetch token → write ExecCredential |
| `lib/args.js` | drop-in flag parser + validation |
| `lib/env.js` | env var names shared with the kubelogin fork |
| `lib/scope.js` | `--server-id` → `/.default` scope (mirrors kubelogin `GetScope`) |
| `lib/token.js` | HTTP(S) token exchange: CA / mTLS / headers / GET\|POST |
| `lib/cache.js` | best-effort on-disk token cache (atomic write, refresh skew) |
| `lib/execcredential.js` | `KUBERNETES_EXEC_INFO` → ExecCredential JSON |
| `build.js` | zero-dep bundler → `dist/kubelogin-http-shim.js` |
| `scripts/setup-kubeconfig.sh` | wire a kubeconfig user via `kubectl config set-credentials` |
| `test/*.test.js` | `node:test` unit + e2e suite |
