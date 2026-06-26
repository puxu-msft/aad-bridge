# tunnel — reverse TCP tunnel

A zero-dependency reverse tunnel in two programs:

- **`listen`** runs in **container A** (the exposed side). It exposes a public endpoint for TCP clients and a tunnel endpoint for `connect`. These can be two ports, or **the same port** (single-port mode, see below).
- **`connect`** runs in **container B** (the hidden side). It *actively* dials A's tunnel endpoint — B opens no inbound ports — and forwards each stream to a **provider** inside B.

A TCP client talking to A's public endpoint actually reaches `B:PROVIDER`.

```
   public client ──TCP──► A public endpoint ┐
                                            │  one tunnel connection,
   B `connect` ──dials out──► A tunnel endpoint  many multiplexed streams
                                            │
                                            └──► PROVIDER_HOST:PROVIDER_PORT (inside B)
```

Each public connection on A becomes one logical stream, multiplexed over the single tunnel connection (length-prefixed framing in [`framing.js`](framing.js)).
For every stream, `connect` opens a matching connection to the provider, so many clients are served concurrently and independently.

## Files

| File | Runs in | Role |
|------|---------|------|
| [`listen.js`](listen.js)  | A | Proxy server: public + tunnel endpoints (one or two ports) |
| [`connect.js`](connect.js) | B | Proxy client: dials A, forwards to the provider |
| [`framing.js`](framing.js) | both | Shared wire protocol (multiplexing frames + magic) |
| [`example/provider.js`](example/provider.js) | B | Throwaway HTTP server to test against |

## Configuration (env vars)

**`listen` (A):**

| Var | Default | Meaning |
|-----|---------|---------|
| `PUBLIC_PORT`  | `8080` | Public TCP port for real clients |
| `PUBLIC_HOST`  | `0.0.0.0` | Bind addr for the public endpoint |
| `CONTROL_PORT` | mirrors `PUBLIC_PORT` | Tunnel port `connect` dials in to |
| `CONTROL_HOST` | mirrors `PUBLIC_HOST` | Bind addr for the tunnel endpoint |
| `AUTH_TOKEN`   | `''` | Shared secret `connect` must present (recommended) |
| `AUTH_TIMEOUT_MS` | `10000` | Drop un-authenticated control sockets after this |
| `TUNNEL_TIMEOUT_MS` | `45000` | Drop the tunnel if no data (incl. PING) arrives for this long |
| `MAX_PENDING` | `64` | Cap on simultaneous un-authenticated candidates |
| `MAX_STREAMS` | `1024` | Cap on simultaneous public streams |
| `TUNNEL_NOT_READY` | `park` | When no tunnel exists yet: `park` a public client until one connects, or `reject` it |
| `PARK_TIMEOUT_MS` | `30000` | Drop a parked client after this long if no tunnel appears |
| `KEEPALIVE_MS` | `60000` | OS TCP keepalive idle time on passthrough sockets (0 disables) |

**Single-port vs two-port (auto-detected — no flag):** `CONTROL_*` and `PUBLIC_*` each mirror the other when only one is set.
When they resolve to the **same `host:port`**, `listen` runs **single-port mode** (one listener serves both, see below). Set them to **different** ports to get two separate listeners.
Zero config ⇒ both `0.0.0.0:8080` ⇒ single-port.

**`connect` (B):**

| Var | Default | Meaning |
|-----|---------|---------|
| `SERVER_HOST`   | `127.0.0.1` | A's host/IP reachable from B |
| `SERVER_PORT`   | `8080` | A's tunnel port (= A's `CONTROL_PORT`) |
| `PROVIDER_HOST` | `127.0.0.1` | Provider to forward to, inside B |
| `PROVIDER_PORT` | `3000` | Provider's port |
| `AUTH_TOKEN`    | `''` | Must match A's |
| `PING_INTERVAL` | `15000` | Keepalive period (ms) |
| `TUNNEL_TIMEOUT_MS` | `45000` | Reconnect if no data (incl. PONG) arrives for this long |
| `PROVIDER_TIMEOUT_MS` | `10000` | Give up a provider dial after this long |
| `RECONNECT_MAX_MS` | `10000` | Backoff cap; the first retry after a drop is always immediate |
| `KEEPALIVE_MS` | `60000` | OS TCP keepalive idle time on provider sockets (0 disables) |

> Keep `TUNNEL_TIMEOUT_MS` at roughly **≥ 2.5 × `PING_INTERVAL`** on both ends, or a healthy tunnel may be dropped on normal jitter. `connect` warns at startup if it isn't.

## Single-port mode

When A's tunnel and public endpoints are the same `host:port`, one listener serves both, classified by **tunnel state** — not by sniffing every connection:

- **A tunnel is connected** ⇒ a new connection is a **public client**, passed straight through immediately. No magic check, no delay — server-speaks-first protocols (SMTP/FTP/SSH) work with zero added latency.
- **No tunnel** ⇒ a new connection is a **connector candidate**: it must present the 8-byte control magic + a valid `AUTH` frame (within `AUTH_TIMEOUT_MS`) or it is dropped. A public client arriving during an outage is refused (it can't be served with no tunnel anyway); a silent one is reclassified to public the moment the tunnel comes up.

The control handshake order is `MAGIC` → `AUTH` frame → multiplexed data.
The magic is only how `listen` recognizes the connector while disconnected — it's a public constant, not a secret; the `AUTH_TOKEN` does the actual authentication.

### Liveness (silent-death detection)

TCP does **not** report a peer that vanished without a clean close (power loss, network partition, NAT drop) on an idle connection — the socket can sit `ESTABLISHED` for hours.
So liveness is enforced at two layers:

- **Tunnel (app-level PING/PONG):** `connect` sends a `PING` every `PING_INTERVAL` and `listen` replies `PONG`. Either side drops the connection if **no data is received** for `TUNNEL_TIMEOUT_MS`, keyed on *received* bytes only — a sender's own PINGs don't count, or a dead peer would never be detected.
- **Passthrough streams (OS-level keepalive):** the public socket on A and the provider socket on B have no app-level keepalive, so they enable OS TCP keepalive (`KEEPALIVE_MS`) to eventually reap a silently half-dead peer and free the stream. Detection is the idle time plus the OS probe sequence, so it is a coarse backstop, not a tight timeout — tune the OS keepalive sysctls if you need it faster.

On a tunnel drop, `listen` returns to the disconnected state and `connect` redials.
A connector that reconnected into a not-yet-reaped stale slot gets no `PONG`, times out, and redials until the slot frees — **worst-case recovery ≈ `TUNNEL_TIMEOUT_MS` + reconnect backoff** (up to ~55s with defaults: 45s to reap the stale slot + the 10s backoff cap), with no livelock and nothing reaching a provider in the meantime.

## Quick test on one machine

Four terminals:

```bash
# 1) provider inside "B"
node example/provider.js                       # -> 127.0.0.1:3000

# 2) listen in "A" — zero config => single-port on :8080 (tunnel + public share it)
AUTH_TOKEN=s3cret node listen.js               # single-port :8080

# 3) connect in "B" — dials A's port, forwards to the provider
AUTH_TOKEN=s3cret SERVER_PORT=8080 PROVIDER_PORT=3000 node connect.js

# 4) hit A's port — you reach B's provider
curl http://127.0.0.1:8080/hello
# {"ok":true,"from":"provider inside B",...}
```

For two separate ports instead, give `listen` different control/public ports:

```bash
AUTH_TOKEN=s3cret CONTROL_PORT=7000 PUBLIC_PORT=8080 node listen.js
AUTH_TOKEN=s3cret SERVER_PORT=7000 PROVIDER_PORT=3000 node connect.js   # dials :7000
```

## Build (dist artifacts)

For deployment, build one self-contained file per side.
esbuild inlines the shared `framing.js` into each, so the wire protocol can't drift and each output is a single drop-in script — no `node_modules`, no shared file to ship.

```bash
npm install      # esbuild, build-only
npm run build    # -> dist/listen.js, dist/connect.js
```

- `dist/listen.js`  → copy into container A, `node listen.js`
- `dist/connect.js` → copy into container B, `node connect.js`

`framing.js` stays the single source of truth in the repo; the bundles are regenerated by `npm run build` (also runs on `npm publish` via `prepublishOnly`).

## Across two containers

```bash
# Container A (exposed). Publish only the public + control ports of A.
docker run --rm -p 8080:8080 -p 7000:7000 \
  -e AUTH_TOKEN=s3cret \
  -v "$PWD/tunnel:/app" -w /app node:20-alpine node listen.js

# Container B (hidden). No published ports. provider listens on B:3000.
docker run --rm \
  -e AUTH_TOKEN=s3cret \
  -e SERVER_HOST=<A_HOST_OR_IP> -e SERVER_PORT=7000 \
  -e PROVIDER_HOST=127.0.0.1 -e PROVIDER_PORT=3000 \
  -v "$PWD/tunnel:/app" -w /app node:20-alpine node connect.js
```

Then from anywhere that can reach A: `curl http://<A_HOST>:8080/` hits B's provider.

## Tests

```bash
npm install        # dev deps (node's built-in runner needs none; c8 for coverage)
npm test           # unit (framing) + black-box integration (real processes)
npm run test:coverage   # same, with a c8 coverage report (text + html)
```

`test/framing.test.js` unit-tests the wire protocol.
`test/e2e.test.js` spawns the real `provider`, `listen` and `connect` processes on ephemeral ports and asserts: forwarding, concurrent multiplexing, reject-while-down, outage + auto-recovery, wrong-token rejection, single-port mode, `connect` retrying when `listen` is absent, **liveness** (listener drops a silent tunnel; `connect` redials when no `PONG`; a healthy idle tunnel is not false-dropped), and **no-livelock recovery** when a stale tunnel holds the slot.
Coverage is ~86% of the core files (framing 100%); c8 captures the spawned binaries too.

## Notes

- **Auth:** set `AUTH_TOKEN` on both sides. Without it `listen` accepts any tunnel client. The control channel is plain TCP — run it over a trusted network or wrap it in TLS/WireGuard if it crosses untrusted links.
- **Single tunnel:** `listen` serves one active `connect` at a time; a second one is rejected until the first drops. `connect` auto-reconnects with exponential backoff, so A and B can start in any order.
- **No tunnel yet vs. tunnel dropped:** these are handled separately. **New** connections that arrive while no tunnel exists are, by default, **parked** (paused, bytes preserved) and served the moment a tunnel connects — bounded by `PARK_TIMEOUT_MS` and `MAX_STREAMS`; set `TUNNEL_NOT_READY=reject` to RST them instead. **Existing** streams are always **reset** when the tunnel drops — their state lives on the connector side, which may not be the same connector on reconnect, so they can't be safely resumed (a byte tunnel can't tell whether in-flight data already reached and was acted on by the provider). `connect` reconnects in the background — first retry immediate, then exponential backoff up to `RECONNECT_MAX_MS` (default 10s). Clients retry at the application layer.
- **Backpressure** is handled in both directions on the shared control channel: the source socket pauses when the tunnel's send buffer fills (public→provider), and the tunnel pauses when a destination socket can't keep up (provider→public), resuming on drain — so neither direction buffers without bound.
- **Frame size cap:** the parser rejects any frame advertising a payload over 16 MiB (`MAX_FRAME_LENGTH`) and resets the connection, guarding against a forged/corrupt length exhausting memory.
- **Half-close:** supported. When one side sends FIN (shutdown-write), it propagates as a `SHUTDOWN` frame so the peer half-closes its paired socket while the reverse direction keeps flowing (sockets use `allowHalfOpen: true`). This handles request/response protocols that shutdown-write then read the full response (e.g. `nc -N`, some line/RPC protocols). Full close still propagates via `CLOSE`.
- **IPv6:** supported. Set the relevant host vars to IPv6 literals (`PUBLIC_HOST=::` for dual-stack, `SERVER_HOST=::1`, etc.); the default `0.0.0.0` is IPv4-only.
