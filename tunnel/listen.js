#!/usr/bin/env node
'use strict';

/**
 * listen — the proxy server, runs in container A (the exposed side).
 *
 * Two endpoints exist:
 *   - PUBLIC   (PUBLIC_HOST:PUBLIC_PORT)   where real TCP clients connect.
 *   - CONTROL  (CONTROL_HOST:CONTROL_PORT) where `connect` (container B) dials the tunnel.
 *
 * Address resolution & mode:
 *   - If only one of CONTROL_* / PUBLIC_* is set, the other mirrors it.
 *   - When CONTROL and PUBLIC resolve to the SAME host:port => SINGLE-PORT mode:
 *     one listener serves both, classified by TUNNEL STATE (not by sniffing):
 *       * tunnel connected  => a new connection is a public passthrough stream.
 *       * no tunnel         => a new connection is a connector candidate; it must present CONTROL_MAGIC + AUTH or it is dropped.
 *   - Otherwise => two listeners (control + public).
 *   - Zero config => both default to 0.0.0.0:8080 => single-port.
 *
 * Flow control: each public stream is throttled independently with PAUSE/RESUME frames, so a slow consumer pauses only its own source — the shared tunnel is NEVER paused (no head-of-line blocking, and liveness is never starved).
 *
 * Liveness: TCP does not report a silently-dead peer on an idle connection, so the tunnel is kept honest at the app layer — `connect` PINGs; if no data (incl. PING) arrives for TUNNEL_TIMEOUT_MS the tunnel is dropped.
 *
 * Config via env vars (invalid numeric values are rejected at startup):
 *   PUBLIC_PORT / PUBLIC_HOST     public endpoint        (default 8080 / 0.0.0.0)
 *   CONTROL_PORT / CONTROL_HOST   tunnel endpoint        (default: mirror PUBLIC)
 *   AUTH_TOKEN        shared secret `connect` must present (default '' = no auth)
 *   AUTH_TIMEOUT_MS   drop un-authenticated control sockets after (default 10000)
 *   TUNNEL_TIMEOUT_MS drop the tunnel after this long with no data (default 45000)
 *   MAX_PENDING       cap on simultaneous un-authed candidates (default 64)
 *   MAX_STREAMS       cap on simultaneous public streams (default 1024)
 *   TUNNEL_NOT_READY  'park' (default) holds a public client until a tunnel exists, or 'reject'
 *   PARK_TIMEOUT_MS   drop a parked client after this long with no tunnel (default 30000)
 *   KEEPALIVE_MS      OS keepalive idle time on passthrough sockets, 0 disables (default 60000)
 */

const net = require('net');
const { FrameType, encodeFrame, FrameParser, CONTROL_MAGIC } = require('./framing');

function die(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}
/** Validate a TCP port (1-65535). Empty/non-numeric => fatal, not a silent random port. */
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
/** Positive-integer env (NaN/<1 => fatal). */
function posInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) die(`${name} must be a positive integer (got "${raw}")`);
  return n;
}

const PUBLIC_HOST = process.env.PUBLIC_HOST ?? process.env.CONTROL_HOST ?? '0.0.0.0';
const CONTROL_HOST = process.env.CONTROL_HOST ?? PUBLIC_HOST;
const PUBLIC_PORT = port('PUBLIC_PORT', process.env.PUBLIC_PORT ?? process.env.CONTROL_PORT ?? '8080');
const CONTROL_PORT = port('CONTROL_PORT', process.env.CONTROL_PORT ?? String(PUBLIC_PORT));
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const AUTH_TIMEOUT_MS = posMs('AUTH_TIMEOUT_MS', 10000);
const TUNNEL_TIMEOUT_MS = posMs('TUNNEL_TIMEOUT_MS', 45000);
const MAX_PENDING = posInt('MAX_PENDING', 64);
const MAX_STREAMS = posInt('MAX_STREAMS', 1024);
const KEEPALIVE_MS = nonNegMs('KEEPALIVE_MS', 60000); // 0 disables
const singlePort = CONTROL_HOST === PUBLIC_HOST && CONTROL_PORT === PUBLIC_PORT;

// Two-port mode with the same port but different hosts means two listen() calls on the same port — they collide (EADDRINUSE).
// Catch it early with a clear message.
if (!singlePort && CONTROL_PORT === PUBLIC_PORT) {
  die(`CONTROL and PUBLIC share port ${PUBLIC_PORT} but different hosts (${CONTROL_HOST} vs ${PUBLIC_HOST}); the listeners will collide. Use distinct ports for two-port mode.`);
}

// Behavior when a public client connects but no tunnel is established yet: 'park' (default) holds it until a tunnel appears; 'reject' resets it immediately.
const TUNNEL_NOT_READY = (process.env.TUNNEL_NOT_READY || 'park').toLowerCase();
if (TUNNEL_NOT_READY !== 'park' && TUNNEL_NOT_READY !== 'reject') {
  die(`TUNNEL_NOT_READY must be 'park' or 'reject' (got "${process.env.TUNNEL_NOT_READY}")`);
}
const parkMode = TUNNEL_NOT_READY === 'park';
const PARK_TIMEOUT_MS = posMs('PARK_TIMEOUT_MS', 30000); // drop a parked client after this long with no tunnel

// How often the liveness checker runs. Detection lands within one extra tick.
const LIVENESS_CHECK_MS = Math.max(200, Math.floor(TUNNEL_TIMEOUT_MS / 4));
// Hard ceiling on bytes a connection may send before authenticating (magic + one AUTH frame is tiny).
// Stops an un-authed client from buffering memory.
const PREAUTH_MAX_BYTES = 512;

// Read-pause reasons, ref-counted on a socket so one resume can't override the other.
const R_TUNNEL = 1; // our tunnel send buffer is full (aggregate)
const R_PEER = 2; // peer asked us to pause this specific stream

let tunnel = null; // the current authenticated control socket, or null
const streams = new Map(); // streamId -> public client socket
const pausedForTunnel = new Set(); // sockets read-paused because the tunnel write buffer filled
const pending = new Set(); // candidate descriptors not yet authenticated
const parked = new Set(); // public connections parked until a tunnel exists (TUNNEL_NOT_READY=park)
let nextStreamId = 1;

function log(...args) {
  console.log(new Date().toISOString(), '[listen]', ...args);
}

/** host:port for logs, bracketing IPv6 literals -> [::1]:8080. */
function addr(host, port) {
  return String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Enable OS TCP keepalive so a silently-dead peer is eventually detected. */
function enableKeepAlive(socket) {
  if (KEEPALIVE_MS > 0) socket.setKeepAlive(true, KEEPALIVE_MS);
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

/** Write a frame to the active tunnel. Returns false if no tunnel / write buffered. */
function sendToTunnel(frame) {
  if (!tunnel || tunnel.destroyed) return false;
  return tunnel.write(frame);
}

/** TUNNEL_NOT_READY=park: hold a public connection until a tunnel exists, then serve it.
 *  The socket is PAUSED — its bytes stay in the kernel receive buffer (TCP flow control backpressures the client), so we never buffer in userspace.
 *  A peer RST still fires 'error'/'close' and is reaped; a clean FIN is silent while paused and is reaped by the park timeout, or processed normally when we resume on drain.
 *  `initial` is any bytes already read off the socket (single-port reads the non-magic prefix before parking). */
function parkPublic(socket, initial) {
  if (parked.size >= MAX_STREAMS) {
    log(`MAX_STREAMS (${MAX_STREAMS}) reached — refusing parked public client`, socket.remoteAddress);
    socket.destroy();
    return;
  }
  socket.pause();
  const onError = () => socket.destroy(); // a parked socket MUST have an error handler, or an RST crashes the process
  const rec = { socket, initial, timer: null, detach: null };
  const onClose = () => {
    clearTimeout(rec.timer);
    socket.removeListener('error', onError);
    parked.delete(rec);
  };
  rec.detach = () => {
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
  };
  rec.timer = setTimeout(() => {
    log('public client parked too long with no tunnel — dropping', socket.remoteAddress);
    socket.destroy();
  }, PARK_TIMEOUT_MS);
  rec.timer.unref();
  socket.on('error', onError);
  socket.once('close', onClose);
  parked.add(rec);
  log(`public ${addr(socket.remoteAddress, socket.remotePort)} parked, no tunnel yet (${parked.size} parked)`);
}

/** A tunnel just established: serve everyone who was parked (kernel-buffered bytes flow on resume). */
function drainParked() {
  for (const rec of [...parked]) {
    parked.delete(rec);
    clearTimeout(rec.timer);
    if (rec.socket.destroyed) continue;
    rec.detach();
    handlePublicConnection(rec.socket, rec.initial); // attaches the data forwarder
    rec.socket.resume(); // ...then let the kernel-buffered bytes flow
  }
}

/** A public client connected: allocate a stream and ask B to open the provider.
 *  `initial` is any bytes already read off the socket before this point. */
function handlePublicConnection(socket, initial) {
  if (!tunnel || tunnel.destroyed) {
    if (parkMode) parkPublic(socket, initial);
    else {
      log('no tunnel connected — rejecting public client', socket.remoteAddress);
      socket.destroy();
    }
    return;
  }
  if (streams.size >= MAX_STREAMS) {
    log(`MAX_STREAMS (${MAX_STREAMS}) reached — refusing public client`, socket.remoteAddress);
    socket.destroy();
    return;
  }

  let streamId = nextStreamId++;
  if (nextStreamId > 0xffffffff) nextStreamId = 1;
  while (streams.has(streamId)) {
    // Skip ids still in use (only reachable after a 4-billion-connection wrap).
    streamId = nextStreamId++;
    if (nextStreamId > 0xffffffff) nextStreamId = 1;
  }
  streams.set(streamId, socket);
  socket.setNoDelay(true);
  enableKeepAlive(socket); // passthrough socket — reap a silently-dead public peer
  log(`public ${addr(socket.remoteAddress, socket.remotePort)} -> stream ${streamId} (${streams.size} active)`);
  sendToTunnel(encodeFrame(FrameType.OPEN, streamId));

  // public -> tunnel: if the shared tunnel's own buffer fills, throttle THIS source (others may still flow); resumed when the tunnel drains.
  const forward = (chunk) => {
    if (sendToTunnel(encodeFrame(FrameType.DATA, streamId, chunk)) === false) {
      pauseRead(socket, R_TUNNEL);
      pausedForTunnel.add(socket);
    }
  };
  if (initial && initial.length) forward(initial);
  socket.on('data', forward);

  // tunnel -> public: when our write buffer to this client drains, tell B it may resume sending DATA for this stream.
  socket.on('drain', () => {
    if (socket._askedPause) {
      socket._askedPause = false;
      sendToTunnel(encodeFrame(FrameType.RESUME, streamId));
    }
  });
  // Client half-closed (sent FIN, done sending): propagate it so B ends its write to the provider, while the provider->client direction keeps flowing.
  socket.on('end', () => sendToTunnel(encodeFrame(FrameType.SHUTDOWN, streamId)));
  socket.on('close', () => {
    pausedForTunnel.delete(socket);
    if (streams.delete(streamId)) sendToTunnel(encodeFrame(FrameType.CLOSE, streamId));
  });
  socket.on('error', () => socket.destroy());
}

/** Apply a frame received from B over the tunnel. */
function handleTunnelFrame(frame) {
  const socket = streams.get(frame.streamId);
  switch (frame.type) {
    case FrameType.DATA:
      if (socket && !socket.destroyed) {
        // tunnel -> public.
        // If this client can't keep up, ask B to pause just this stream (the tunnel keeps flowing for everyone else).
        if (socket.write(frame.payload) === false && !socket._askedPause) {
          socket._askedPause = true;
          sendToTunnel(encodeFrame(FrameType.PAUSE, frame.streamId));
        }
      }
      break;
    case FrameType.PAUSE:
      // B's provider for this stream is congested — stop reading this client.
      if (socket) pauseRead(socket, R_PEER);
      break;
    case FrameType.RESUME:
      if (socket) resumeRead(socket, R_PEER);
      break;
    case FrameType.SHUTDOWN:
      // B's provider half-closed (done sending) — end our write to the client; the client->provider direction stays open.
      if (socket && !socket.destroyed) socket.end();
      break;
    case FrameType.CLOSE:
      if (streams.delete(frame.streamId) && socket) {
        // A read-paused socket ignores the peer FIN, so end() would linger half-open forever — force-reap it.
        // Unpaused sockets close gracefully (flush their tail).
        if (socket._pf) socket.destroy();
        else socket.end();
      }
      break;
    case FrameType.PING:
      sendToTunnel(encodeFrame(FrameType.PONG, 0));
      break;
    default:
      break;
  }
}

/** Drive a control (tunnel) connection: strip the magic, authenticate, then carry multiplexed frames with a received-data liveness watchdog. */
function attachControl(socket) {
  socket.setNoDelay(true);
  if (!tunnel && pending.size >= MAX_PENDING) {
    log('too many un-authenticated connections — dropping');
    socket.destroy();
    return;
  }

  const parser = new FrameParser();
  let authed = false;
  let magicOk = false;
  let pre = Buffer.alloc(0); // bytes buffered while verifying the magic
  let preAuthBytes = 0;
  let liveTimer = null;
  // lastRecv is keyed ONLY on this tunnel socket's own inbound data — never on public traffic or redials — so a dead tunnel's deadline cannot be refreshed.
  let lastRecv = 0;

  const cand = { socket, sawBytes: false, detach: null };
  pending.add(cand);

  const authTimer = setTimeout(() => {
    if (!authed) {
      log('control connection did not authenticate in time — dropping');
      socket.destroy();
    }
  }, AUTH_TIMEOUT_MS);
  authTimer.unref();

  const feed = (chunk) => {
    if (!authed) {
      cand.sawBytes = true;
      preAuthBytes += chunk.length;
      if (preAuthBytes > PREAUTH_MAX_BYTES) {
        log('control connection sent too much before auth — dropping');
        socket.destroy();
        return;
      }
      if (!magicOk) {
        pre = pre.length ? Buffer.concat([pre, chunk]) : chunk;
        const n = Math.min(pre.length, CONTROL_MAGIC.length);
        if (!pre.subarray(0, n).equals(CONTROL_MAGIC.subarray(0, n))) {
          // Not a connector.
          // In single-port park mode this is a public client — hand it off (parked if no tunnel yet, served if one exists).
          if (singlePort && parkMode) {
            pending.delete(cand);
            cand.detach();
            handlePublicConnection(socket, pre);
            return;
          }
          log('control connection bad magic — dropping');
          socket.destroy();
          return;
        }
        if (pre.length < CONTROL_MAGIC.length) return; // wait for the rest of the magic
        magicOk = true;
        chunk = pre.subarray(CONTROL_MAGIC.length);
        pre = null;
        if (!chunk.length) return;
      }
    } else {
      lastRecv = Date.now();
    }

    let frames;
    try {
      frames = parser.push(chunk);
    } catch (err) {
      log('framing error from tunnel:', err.message);
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (!authed) {
        if (frame.type !== FrameType.AUTH) {
          log('tunnel did not authenticate first — dropping');
          socket.destroy();
          return;
        }
        if (AUTH_TOKEN && frame.payload.toString() !== AUTH_TOKEN) {
          log('tunnel auth failed — dropping');
          socket.destroy();
          return;
        }
        if (tunnel && !tunnel.destroyed) {
          log('a tunnel is already active — rejecting second connect');
          socket.destroy();
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        pending.delete(cand);
        tunnel = socket;
        lastRecv = Date.now();

        // Park mode: serve everyone who was parked for a tunnel — silent single-port candidates (server-speaks-first) get reclassified, and parked publics drain.
        // A candidate whose read side already ended (a transient probe / half-closed connection) is NOT a real client; skip it (its auth timeout reaps it).
        if (singlePort && parkMode) {
          for (const c of [...pending]) {
            if (c.sawBytes || c.socket.destroyed || !c.socket.readable) continue;
            pending.delete(c);
            c.detach();
            handlePublicConnection(c.socket);
          }
        }
        drainParked();

        // Received-data liveness watchdog: drop the tunnel if PINGs stop arriving.
        liveTimer = setInterval(() => {
          if (Date.now() - lastRecv > TUNNEL_TIMEOUT_MS) {
            log(`tunnel liveness timeout — no data for ${TUNNEL_TIMEOUT_MS}ms, dropping`);
            clearInterval(liveTimer);
            liveTimer = null;
            socket.destroy();
          }
        }, LIVENESS_CHECK_MS);
        liveTimer.unref();

        // Tunnel write buffer drained: resume sources throttled by R_TUNNEL.
        socket.on('drain', () => {
          for (const s of pausedForTunnel) resumeRead(s, R_TUNNEL);
          pausedForTunnel.clear();
        });
        log(`tunnel established from ${addr(socket.remoteAddress, socket.remotePort)}`);
        continue;
      }
      handleTunnelFrame(frame);
    }
  };

  const onError = (err) => log('tunnel socket error:', err.message);
  // Peer FIN on a control/candidate socket: reap it.
  // A half-closing candidate (a probe) is not a real connector, and the tunnel never legitimately half-closes.
  const onEnd = () => socket.destroy();

  const teardown = () => {
    clearTimeout(authTimer);
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    pending.delete(cand);
    if (tunnel !== socket) return;
    tunnel = null;
    log(`tunnel lost — closing ${streams.size} active stream(s)`);
    for (const s of streams.values()) s.destroy();
    streams.clear();
    pausedForTunnel.clear();
  };

  // Used by reclassification to peel control handlers off a silent candidate before handing the raw socket to handlePublicConnection.
  cand.detach = () => {
    clearTimeout(authTimer);
    socket.removeListener('data', feed);
    socket.removeListener('error', onError);
    socket.removeListener('end', onEnd);
    socket.removeListener('close', teardown);
  };

  socket.on('data', feed);
  socket.on('error', onError);
  socket.on('end', onEnd);
  socket.on('close', teardown);
}

/** SINGLE-PORT dispatch: classify a new connection by tunnel STATE. */
function dispatch(socket) {
  if (tunnel && !tunnel.destroyed) handlePublicConnection(socket);
  else attachControl(socket);
}

function fatal(label) {
  return (err) => {
    console.error(`FATAL: ${label} listener error:`, err.message);
    process.exit(1);
  };
}

if (singlePort) {
  // allowHalfOpen lets a public client half-close (FIN) without auto-closing its write side; control sockets are always destroy()'d so it's moot for them.
  const server = net.createServer({ allowHalfOpen: true }, dispatch);
  server.on('error', fatal('single-port'));
  server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    log(`single-port listening on ${addr(PUBLIC_HOST, PUBLIC_PORT)} — tunnel + public share this port`);
    if (!AUTH_TOKEN) log('WARNING: AUTH_TOKEN not set — any client may open the tunnel.');
  });
} else {
  const controlServer = net.createServer((socket) => attachControl(socket));
  const publicServer = net.createServer({ allowHalfOpen: true }, handlePublicConnection);
  controlServer.on('error', fatal('control'));
  publicServer.on('error', fatal('public'));
  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    log(`control (tunnel) listening on ${addr(CONTROL_HOST, CONTROL_PORT)}`);
    if (!AUTH_TOKEN) log('WARNING: AUTH_TOKEN not set — any client may open the tunnel.');
  });
  publicServer.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    log(`public listening on ${addr(PUBLIC_HOST, PUBLIC_PORT)} — TCP here reaches B's provider`);
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
