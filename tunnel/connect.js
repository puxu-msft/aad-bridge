#!/usr/bin/env node
'use strict';

/**
 * connect — the proxy-client, runs in container B (the hidden side).
 *
 * It actively dials A's `listen` tunnel endpoint and keeps that one connection open.
 * For every OPEN frame A sends (one per public client), it opens a fresh TCP connection to B's local provider and pipes bytes both ways over the tunnel.
 * B never needs an inbound port — the connection is outbound only.
 *
 * On connect it sends an 8-byte control magic before AUTH so A can distinguish the tunnel from raw public clients (required when A shares one port; harmless otherwise).
 * Point SERVER_* at A's tunnel endpoint — A's CONTROL_PORT, which in single-port mode is the same as A's PUBLIC_PORT.
 *
 * Flow control: each stream is throttled independently with PAUSE/RESUME frames, so a slow provider pauses only its own stream — the shared tunnel is never paused.
 *
 *   B `connect` ──dials──> A tunnel endpoint  (stays connected, auto-reconnects)
 *        │
 *        └──per stream──> PROVIDER_HOST:PROVIDER_PORT  (inside B)
 *
 * Config via env vars (invalid numeric values are rejected at startup):
 *   SERVER_HOST     A's host/IP reachable from B            (default 127.0.0.1)
 *   SERVER_PORT     A's tunnel port (CONTROL_PORT)          (default 8080)
 *   PROVIDER_HOST   the provider to forward to, inside B    (default 127.0.0.1)
 *   PROVIDER_PORT   the provider's port                     (default 3000)
 *   AUTH_TOKEN      shared secret, must match A's           (default '')
 *   PING_INTERVAL   keepalive period in ms                  (default 15000)
 *   TUNNEL_TIMEOUT_MS  reconnect if no data (incl. PONG) for this long (default 45000)
 *   PROVIDER_TIMEOUT_MS  give up a provider dial after this long (default 10000)
 *   RECONNECT_MAX_MS  backoff cap; the first retry is always immediate (default 10000)
 *   KEEPALIVE_MS    OS keepalive idle time on provider sockets, 0 disables (default 60000)
 */

const net = require('net');
const { FrameType, encodeFrame, FrameParser, CONTROL_MAGIC } = require('./framing');

function die(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}
/** Validate a TCP port (1-65535). Empty/non-numeric => fatal, not a silent wrong port. */
function port(name, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) die(`${name} must be an integer 1-65535 (got "${raw}")`);
  return n;
}
/** Positive-ms env (NaN/<=0 => fatal). Unset/empty => default. */
function posMs(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) die(`${name} must be a positive number of ms (got "${raw}")`);
  return n;
}
/** Non-negative-ms env where 0 is meaningful (e.g. "disable"). */
function nonNegMs(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) die(`${name} must be a number of ms >= 0 (got "${raw}")`);
  return n;
}

const SERVER_HOST = process.env.SERVER_HOST || '127.0.0.1';
const SERVER_PORT = port('SERVER_PORT', process.env.SERVER_PORT ?? '8080');
const PROVIDER_HOST = process.env.PROVIDER_HOST || '127.0.0.1';
const PROVIDER_PORT = port('PROVIDER_PORT', process.env.PROVIDER_PORT ?? '3000');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const PING_INTERVAL = posMs('PING_INTERVAL', 15000);
const TUNNEL_TIMEOUT_MS = posMs('TUNNEL_TIMEOUT_MS', 45000);
const PROVIDER_TIMEOUT_MS = posMs('PROVIDER_TIMEOUT_MS', 10000);
const KEEPALIVE_MS = nonNegMs('KEEPALIVE_MS', 60000); // 0 disables

const RECONNECT_MAX_MS = posMs('RECONNECT_MAX_MS', 10000); // backoff cap (first retry is immediate)
const RECONNECT_STEP_MS = 500; // base step after the immediate first retry
const LIVENESS_CHECK_MS = Math.max(200, Math.floor(TUNNEL_TIMEOUT_MS / 4));
let reconnectDelay = 0; // first reconnect attempt is immediate

if (TUNNEL_TIMEOUT_MS <= 2 * PING_INTERVAL) {
  console.warn(
    `[connect] WARNING: TUNNEL_TIMEOUT_MS (${TUNNEL_TIMEOUT_MS}) <= 2x PING_INTERVAL (${PING_INTERVAL}); ` +
      'a healthy tunnel may be dropped on normal jitter. Use TUNNEL_TIMEOUT_MS >= ~2.5x PING_INTERVAL.',
  );
}

// Read-pause reasons, ref-counted on a socket so one resume can't override the other.
const R_TUNNEL = 1; // our tunnel send buffer is full (aggregate)
const R_PEER = 2; // peer asked us to pause this specific stream

function log(...args) {
  console.log(new Date().toISOString(), '[connect]', ...args);
}

/** host:port for logs, bracketing IPv6 literals -> [::1]:8080. */
function addr(host, port) {
  return String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Read-pause a source socket, ref-counted by reason (idempotent per reason). */
function pauseRead(sock, reason) {
  const prev = sock._pf || 0;
  sock._pf = prev | reason;
  if (prev === 0) sock.pause();
}
/** Clear one read-pause reason; resume only when no reasons remain. */
function resumeRead(sock, reason) {
  const prev = sock._pf || 0;
  if (prev === 0) return;
  sock._pf = prev & ~reason;
  if (sock._pf === 0) sock.resume();
}

function connectToServer() {
  const providers = new Map(); // streamId -> provider socket
  const pausedForTunnel = new Set(); // provider sockets read-paused because the tunnel write buffer filled
  const parser = new FrameParser();
  let pingTimer = null;
  let liveTimer = null;
  let established = false; // flipped on first byte received from A (proves a real tunnel)
  // lastRecv keys on RECEIVED data only — NOT on our own PING writes — so a dead or zombie listener (no PONG) is detected even though we keep pinging.
  let lastRecv = 0;

  const control = net.connect(SERVER_PORT, SERVER_HOST);
  control.setNoDelay(true);
  log(`connecting to ${addr(SERVER_HOST, SERVER_PORT)} ...`);

  /** Write a frame back to A. Returns false if the send buffer is full. */
  const sendToTunnel = (frame) => (control.destroyed ? false : control.write(frame));

  control.on('connect', () => {
    log(`dialed ${addr(SERVER_HOST, SERVER_PORT)} — sending handshake`);
    // Always lead with the magic so listen can tell us apart from raw public clients (needed in single-port mode; harmless and stripped in two-port).
    // It must precede the AUTH frame.
    control.write(CONTROL_MAGIC);
    sendToTunnel(encodeFrame(FrameType.AUTH, 0, Buffer.from(AUTH_TOKEN)));
    // Immediate PING: a real listener replies PONG promptly, which both confirms the tunnel (resets backoff) and primes the liveness clock.
    // A zombie that misroutes us as a public stream never replies -> we time out and redial.
    sendToTunnel(encodeFrame(FrameType.PING, 0));
    lastRecv = Date.now();
    pingTimer = setInterval(() => sendToTunnel(encodeFrame(FrameType.PING, 0)), PING_INTERVAL);
    liveTimer = setInterval(() => {
      if (Date.now() - lastRecv > TUNNEL_TIMEOUT_MS) {
        log(`no reply from listener for ${TUNNEL_TIMEOUT_MS}ms — assuming tunnel dead, reconnecting`);
        clearInterval(liveTimer);
        liveTimer = null;
        control.destroy();
      }
    }, LIVENESS_CHECK_MS);
    liveTimer.unref();

    // Tunnel write buffer drained: resume provider sources throttled by R_TUNNEL.
    control.on('drain', () => {
      for (const s of pausedForTunnel) resumeRead(s, R_TUNNEL);
      pausedForTunnel.clear();
    });
  });

  /** A new public client appeared on A: open a connection to our local provider. */
  function openProvider(streamId) {
    // allowHalfOpen so the provider's FIN doesn't auto-close our write side to it.
    const provider = net.connect({ host: PROVIDER_HOST, port: PROVIDER_PORT, allowHalfOpen: true });
    provider.setNoDelay(true);
    if (KEEPALIVE_MS > 0) provider.setKeepAlive(true, KEEPALIVE_MS); // reap a silently-dead provider
    providers.set(streamId, provider);

    // Bound the provider dial: a provider that never accepts must not hang the stream forever.
    const dialTimer = setTimeout(() => {
      log(`stream ${streamId} provider dial timed out after ${PROVIDER_TIMEOUT_MS}ms`);
      provider.destroy();
    }, PROVIDER_TIMEOUT_MS);
    dialTimer.unref();

    provider.on('connect', () => {
      clearTimeout(dialTimer);
      log(`stream ${streamId} <-> provider ${addr(PROVIDER_HOST, PROVIDER_PORT)} (${providers.size} active)`);
    });
    // provider -> tunnel: if the shared tunnel's buffer fills, throttle THIS provider (others may still flow); resumed when the tunnel drains.
    provider.on('data', (chunk) => {
      if (sendToTunnel(encodeFrame(FrameType.DATA, streamId, chunk)) === false) {
        pauseRead(provider, R_TUNNEL);
        pausedForTunnel.add(provider);
      }
    });
    // tunnel -> provider: when our write buffer to the provider drains, tell A it may resume sending DATA for this stream.
    provider.on('drain', () => {
      if (provider._askedPause) {
        provider._askedPause = false;
        sendToTunnel(encodeFrame(FrameType.RESUME, streamId));
      }
    });
    // Provider half-closed (sent FIN, done sending): propagate it so A ends its write to the client, while the client->provider direction keeps flowing.
    provider.on('end', () => sendToTunnel(encodeFrame(FrameType.SHUTDOWN, streamId)));
    provider.on('close', () => {
      clearTimeout(dialTimer);
      pausedForTunnel.delete(provider);
      if (providers.delete(streamId)) sendToTunnel(encodeFrame(FrameType.CLOSE, streamId));
      log(`stream ${streamId} closed (${providers.size} active)`);
    });
    provider.on('error', (err) => {
      log(`provider error on stream ${streamId}:`, err.message);
      provider.destroy();
    });
  }

  function handleFrame(frame) {
    const provider = providers.get(frame.streamId);
    switch (frame.type) {
      case FrameType.OPEN:
        openProvider(frame.streamId);
        break;
      case FrameType.DATA:
        if (provider && !provider.destroyed) {
          // tunnel -> provider.
          // If the provider can't keep up, ask A to pause just this stream (the tunnel keeps flowing for everyone else).
          if (provider.write(frame.payload) === false && !provider._askedPause) {
            provider._askedPause = true;
            sendToTunnel(encodeFrame(FrameType.PAUSE, frame.streamId));
          }
        }
        break;
      case FrameType.PAUSE:
        // A's public client for this stream is congested — stop reading this provider.
        if (provider) pauseRead(provider, R_PEER);
        break;
      case FrameType.RESUME:
        if (provider) resumeRead(provider, R_PEER);
        break;
      case FrameType.SHUTDOWN:
        // A's client half-closed (done sending) — end our write to the provider; the provider->client direction stays open.
        if (provider && !provider.destroyed) provider.end();
        break;
      case FrameType.CLOSE:
        if (providers.delete(frame.streamId) && provider) {
          // A read-paused socket ignores the peer FIN, so end() would linger half-open forever — force-reap it.
          // Unpaused sockets close gracefully (flush their tail).
          if (provider._pf) provider.destroy();
          else provider.end();
        }
        break;
      case FrameType.PONG:
        break;
      default:
        break;
    }
  }

  control.on('data', (chunk) => {
    lastRecv = Date.now();
    if (!established) {
      // First reply from A proves this is a real tunnel (not a misrouted public stream) — only now is it safe to reset the reconnect backoff (next drop retries immediately).
      established = true;
      reconnectDelay = 0;
      log('tunnel authenticated and ready');
    }
    let frames;
    try {
      frames = parser.push(chunk);
    } catch (err) {
      log('framing error from tunnel:', err.message);
      control.destroy();
      return;
    }
    for (const frame of frames) handleFrame(frame);
  });

  control.on('error', (err) => log('tunnel connection error:', err.message));
  control.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    if (liveTimer) clearInterval(liveTimer); // must clear per-connection, or reconnects leak intervals
    for (const p of providers.values()) p.destroy();
    providers.clear();
    pausedForTunnel.clear();
    const delay = reconnectDelay;
    reconnectDelay = delay === 0 ? RECONNECT_STEP_MS : Math.min(delay * 2, RECONNECT_MAX_MS);
    log(delay === 0 ? 'tunnel closed — reconnecting now' : `tunnel closed — reconnecting in ${delay} ms`);
    // NOTE: do NOT unref() this timer.
    // While disconnected it is the only handle keeping the event loop alive; unref'ing it makes the process exit instead of retrying.
    // `connect` must stay up and keep dialing until listen returns.
    setTimeout(connectToServer, delay);
  });
}

log(
  `starting — tunnel ${addr(SERVER_HOST, SERVER_PORT)}, provider ${addr(PROVIDER_HOST, PROVIDER_PORT)}, ` +
    `ping ${PING_INTERVAL}ms, timeout ${TUNNEL_TIMEOUT_MS}ms, auth ${AUTH_TOKEN ? 'on' : 'OFF'}`,
);
connectToServer();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
