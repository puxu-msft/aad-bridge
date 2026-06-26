'use strict';

// Black-box integration tests: spawn the real provider, listen and connect processes and exercise the tunnel end to end over loopback TCP.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { getFreePort, spawnNode, waitListening, waitForLog, httpGet, kill } = require('./helpers');
const { CONTROL_MAGIC, encodeFrame, FrameType } = require('../framing');

/** The control handshake a real connector sends: magic then an AUTH frame. */
function handshake(token) {
  return Buffer.concat([CONTROL_MAGIC, encodeFrame(FrameType.AUTH, 0, Buffer.from(token))]);
}

/** Bring up provider + listen on fresh ports. Caller starts connect via startConnect(). */
async function setupBase({ auth = 'tkn', tunnelNotReady } = {}) {
  const providerPort = await getFreePort();
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const procs = [];

  const provider = spawnNode('example/provider.js', {
    PROVIDER_PORT: String(providerPort),
    PROVIDER_HOST: '127.0.0.1',
  });
  procs.push(provider);
  await waitListening(providerPort);

  const listen = spawnNode('listen.js', {
    CONTROL_PORT: String(controlPort),
    PUBLIC_PORT: String(publicPort),
    AUTH_TOKEN: auth,
    ...(tunnelNotReady ? { TUNNEL_NOT_READY: tunnelNotReady } : {}),
  });
  procs.push(listen);
  await waitListening(publicPort);

  // Set up the establish-wait BEFORE spawning connect so we never miss the log.
  function startConnect(connectAuth = auth) {
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(controlPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: connectAuth,
    });
    procs.push(connect);
    return { connect, established };
  }

  const teardown = () => Promise.all(procs.map(kill));
  return { providerPort, controlPort, publicPort, listen, procs, startConnect, teardown };
}

test('forwards a public request through to B\'s provider', { timeout: 20000 }, async () => {
  const env = await setupBase();
  try {
    const { established } = env.startConnect();
    await established;
    const res = await httpGet(env.publicPort, '/ping');
    assert.equal(res.status, 200);
    assert.match(res.body, /provider inside B/);
    assert.match(res.body, /"url":"\/ping"/);
  } finally {
    await env.teardown();
  }
});

test('multiplexes concurrent public connections independently', { timeout: 20000 }, async () => {
  const env = await setupBase();
  try {
    const { established } = env.startConnect();
    await established;
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => httpGet(env.publicPort, '/c' + i)),
    );
    results.forEach((res, i) => {
      assert.equal(res.status, 200, `request ${i} status`);
      assert.match(res.body, new RegExp(`"url":"/c${i}"`));
    });
  } finally {
    await env.teardown();
  }
});

test('rejects public connections while no tunnel is connected', { timeout: 20000 }, async () => {
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const listen = spawnNode('listen.js', {
    CONTROL_PORT: String(controlPort),
    PUBLIC_PORT: String(publicPort),
    TUNNEL_NOT_READY: 'reject',
  });
  try {
    await waitListening(publicPort);
    const res = await httpGet(publicPort, '/');
    assert.ok(res.error, `expected rejection, got HTTP ${res.status}`);
  } finally {
    await kill(listen);
  }
});

test('rejects during an outage, then recovers after connect reconnects', { timeout: 30000 }, async () => {
  const env = await setupBase({ tunnelNotReady: 'reject' });
  try {
    const first = env.startConnect();
    await first.established;
    assert.equal((await httpGet(env.publicPort, '/up')).status, 200);

    const lost = waitForLog(env.listen, /tunnel lost/);
    await kill(first.connect);
    await lost;
    assert.ok((await httpGet(env.publicPort, '/down')).error, 'expected rejection during outage');

    const second = env.startConnect();
    await second.established;
    assert.equal((await httpGet(env.publicPort, '/back')).status, 200);
  } finally {
    await env.teardown();
  }
});

test('rejects a tunnel client presenting the wrong auth token', { timeout: 20000 }, async () => {
  const env = await setupBase({ auth: 'right' });
  try {
    const { connect, established } = env.startConnect('wrong');
    established.catch(() => {}); // it will never establish; swallow the timeout
    // Wrong token -> listen drops it -> connect loops on reconnect.
    await waitForLog(connect, /reconnecting/);
    const res = await httpGet(env.publicPort, '/');
    assert.ok(res.error, `expected rejection (no authed tunnel), got HTTP ${res.status}`);
  } finally {
    await env.teardown();
  }
});

// Regression: connect must NOT exit when listen is unreachable — it keeps dialing in the background and recovers once listen comes up.
test('connect survives listen being absent and recovers when it returns', { timeout: 30000 }, async () => {
  const providerPort = await getFreePort();
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const procs = [];
  try {
    // Start connect FIRST — nothing is listening on controlPort yet.
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(controlPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await waitForLog(connect, /reconnecting/); // it tried, failed, is backing off
    await delay(800);
    assert.equal(connect.exitCode, null, 'connect must stay alive while listen is absent');

    // Now bring up provider + listen; connect should reconnect on its own.
    const provider = spawnNode('example/provider.js', {
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
    });
    procs.push(provider);
    await waitListening(providerPort);

    const listen = spawnNode('listen.js', {
      CONTROL_PORT: String(controlPort),
      PUBLIC_PORT: String(publicPort),
      AUTH_TOKEN: 'tkn',
    });
    procs.push(listen);
    await waitListening(publicPort);
    await waitForLog(listen, /tunnel established/);
    assert.equal((await httpGet(publicPort, '/recovered')).status, 200);
  } finally {
    await Promise.all(procs.map(kill));
  }
});

// Security: a control connection that connects but never authenticates is dropped.
test('drops a control connection that never authenticates', { timeout: 20000 }, async () => {
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const listen = spawnNode('listen.js', {
    CONTROL_PORT: String(controlPort),
    PUBLIC_PORT: String(publicPort),
    AUTH_TOKEN: 'x',
    AUTH_TIMEOUT_MS: '300',
  });
  try {
    await waitListening(controlPort);
    // Connect a raw socket to the control port and send nothing.
    const dropped = await new Promise((resolve) => {
      const s = net.connect(controlPort, '127.0.0.1');
      s.on('close', () => resolve(true));
      s.on('error', () => resolve(true));
      setTimeout(() => {
        s.destroy();
        resolve(false);
      }, 3000).unref();
    });
    assert.ok(dropped, 'silent control connection should be dropped by the auth timeout');
  } finally {
    await kill(listen);
  }
});

// SINGLE-PORT mode: tunnel + public clients share one port (CONTROL mirrors PUBLIC).
test('single-port mode serves tunnel and public clients on one port', { timeout: 20000 }, async () => {
  const providerPort = await getFreePort();
  const sharedPort = await getFreePort();
  const procs = [];
  try {
    const provider = spawnNode('example/provider.js', {
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
    });
    procs.push(provider);
    await waitListening(providerPort);

    // Only PUBLIC_PORT set -> CONTROL mirrors it -> single-port mode auto-enables.
    const listen = spawnNode('listen.js', {
      PUBLIC_PORT: String(sharedPort),
      AUTH_TOKEN: 'tkn',
    });
    procs.push(listen);
    await waitForLog(listen, /single-port listening/);
    await waitListening(sharedPort);

    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort), // dials the SAME port public clients use
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;

    // A raw public client on the shared port reaches B's provider.
    const res = await httpGet(sharedPort, '/via-single-port');
    assert.equal(res.status, 200);
    assert.match(res.body, /provider inside B/);
    assert.match(res.body, /"url":"\/via-single-port"/);

    // A second request also works on the same port.
    assert.equal((await httpGet(sharedPort, '/again')).status, 200);
  } finally {
    await Promise.all(procs.map(kill));
  }
});

// Liveness: listener drops a tunnel that authenticated then went silent (no PING).
test('listener drops a silently-dead tunnel after TUNNEL_TIMEOUT_MS', { timeout: 20000 }, async () => {
  const sharedPort = await getFreePort();
  const listen = spawnNode('listen.js', {
    PUBLIC_PORT: String(sharedPort),
    AUTH_TOKEN: 'tkn',
    TUNNEL_TIMEOUT_MS: '700',
    AUTH_TIMEOUT_MS: '5000',
  });
  try {
    await waitListening(sharedPort);
    const sock = net.connect(sharedPort, '127.0.0.1');
    await new Promise((res, rej) => {
      sock.on('connect', res);
      sock.on('error', rej);
    });
    const established = waitForLog(listen, /tunnel established/);
    sock.write(handshake('tkn')); // authenticate, then go silent (no PING)
    await established;

    const t0 = Date.now();
    const closedAfter = await new Promise((res) => {
      sock.on('close', () => res(Date.now() - t0));
      sock.on('error', () => {});
      setTimeout(() => res(-1), 6000).unref();
    });
    assert.ok(closedAfter >= 0, 'listener should have dropped the silent tunnel');
    assert.ok(closedAfter >= 500, `dropped too early (${closedAfter}ms) — not the liveness timeout`);
  } finally {
    await kill(listen);
  }
});

// Liveness: connector keys on RECEIVED data — a listener that never PONGs must trigger a redial (this hangs if connect wrongly reset liveness on its PINGs).
test('connector redials when the listener never replies', { timeout: 20000 }, async () => {
  const port = await getFreePort();
  let connections = 0;
  const mock = net.createServer((s) => {
    connections += 1;
    s.on('data', () => {}); // consume handshake + PINGs, never reply
    s.on('error', () => {});
  });
  await new Promise((res) => mock.listen(port, '127.0.0.1', res));

  const connect = spawnNode('connect.js', {
    SERVER_PORT: String(port),
    AUTH_TOKEN: 'tkn',
    TUNNEL_TIMEOUT_MS: '700',
    PING_INTERVAL: '200',
  });
  try {
    await waitForLog(connect, /no reply from listener/);
    const sawSecond = await new Promise((res) => {
      const iv = setInterval(() => {
        if (connections >= 2) {
          clearInterval(iv);
          res(true);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(iv);
        res(connections >= 2);
      }, 8000).unref();
    });
    assert.ok(sawSecond, `connector should redial; saw ${connections} connection(s)`);
  } finally {
    await kill(connect);
    await new Promise((res) => mock.close(res));
  }
});

// Liveness must not false-positive: a healthy idle tunnel (PINGs flowing) survives well past TUNNEL_TIMEOUT_MS.
test('a healthy idle tunnel is not falsely dropped', { timeout: 20000 }, async () => {
  const providerPort = await getFreePort();
  const sharedPort = await getFreePort();
  const procs = [];
  try {
    const provider = spawnNode('example/provider.js', {
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
    });
    procs.push(provider);
    await waitListening(providerPort);

    const listen = spawnNode('listen.js', {
      PUBLIC_PORT: String(sharedPort),
      AUTH_TOKEN: 'tkn',
      TUNNEL_TIMEOUT_MS: '1500',
    });
    procs.push(listen);
    await waitListening(sharedPort);

    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
      PING_INTERVAL: '300',
      TUNNEL_TIMEOUT_MS: '1500',
    });
    procs.push(connect);
    await established;

    await delay(2200); // idle longer than TUNNEL_TIMEOUT_MS
    assert.equal((await httpGet(sharedPort, '/still-alive')).status, 200);
  } finally {
    await Promise.all(procs.map(kill));
  }
});

// Zombie/no-livelock: a stale tunnel occupies the slot; the real connector keeps redialing (misrouted as public) until the listener reaps the stale one, then takes over.
// Proves redials don't refresh the dead tunnel's liveness deadline.
test('recovers when a stale tunnel holds the slot (no livelock)', { timeout: 30000 }, async () => {
  const providerPort = await getFreePort();
  const sharedPort = await getFreePort();
  const procs = [];
  let stale;
  try {
    const provider = spawnNode('example/provider.js', {
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
    });
    procs.push(provider);
    await waitListening(providerPort);

    const listen = spawnNode('listen.js', {
      PUBLIC_PORT: String(sharedPort),
      AUTH_TOKEN: 'tkn',
      TUNNEL_TIMEOUT_MS: '800',
    });
    procs.push(listen);
    await waitListening(sharedPort);

    // A connector that authenticates, claims the slot, then dies silently.
    stale = net.connect(sharedPort, '127.0.0.1');
    await new Promise((res, rej) => {
      stale.on('connect', res);
      stale.on('error', rej);
    });
    stale.on('error', () => {});
    const firstUp = waitForLog(listen, /tunnel established/);
    stale.write(handshake('tkn'));
    await firstUp;

    // The real connector redials into the occupied slot until the stale one is reaped.
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
      PING_INTERVAL: '200',
      TUNNEL_TIMEOUT_MS: '800',
    });
    procs.push(connect);

    let recovered = false;
    const deadline = Date.now() + 22000;
    while (Date.now() < deadline) {
      const r = await httpGet(sharedPort, '/recovered');
      if (r.status === 200) {
        recovered = true;
        break;
      }
      await delay(400);
    }
    assert.ok(recovered, 'real connector should take over after the stale tunnel is reaped');
  } finally {
    if (stale) stale.destroy();
    await Promise.all(procs.map(kill));
  }
});

// THE headline flow-control fix: a public client that stops reading must throttle only its own stream — the shared tunnel keeps flowing and liveness is NOT tripped.
// With the old tunnel-wide pause, this would freeze lastRecv and falsely drop the tunnel.
test('a stalled consumer does not trip tunnel liveness', { timeout: 25000 }, async () => {
  const sharedPort = await getFreePort();
  const providerPort = await getFreePort();
  const BLOB = Buffer.alloc(8 * 1024 * 1024, 0x7a); // bigger than socket buffers
  const provider = net.createServer((s) => {
    s.on('error', () => {});
    s.write(BLOB); // stream a large blob back on every stream
  });
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  try {
    const listen = spawnNode('listen.js', {
      PUBLIC_PORT: String(sharedPort),
      AUTH_TOKEN: 'tkn',
      TUNNEL_TIMEOUT_MS: '1200',
    });
    procs.push(listen);
    await waitListening(sharedPort);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
      PING_INTERVAL: '300',
      TUNNEL_TIMEOUT_MS: '1200',
    });
    procs.push(connect);
    await established;

    // Stalled consumer: connect and NEVER read -> backpressure on this stream only.
    const stalled = net.connect(sharedPort, '127.0.0.1');
    await new Promise((res, rej) => {
      stalled.on('connect', res);
      stalled.on('error', rej);
    });
    stalled.pause(); // do not consume the blob

    let dropped = false;
    waitForLog(listen, /liveness timeout|tunnel lost/, 2400)
      .then(() => {
        dropped = true;
      })
      .catch(() => {});
    await delay(2600); // > 2x TUNNEL_TIMEOUT_MS
    assert.equal(dropped, false, 'tunnel must NOT be dropped by a stalled consumer');

    // A fresh stream still flows through the live tunnel.
    const got = await new Promise((res) => {
      const fresh = net.connect(sharedPort, '127.0.0.1');
      let n = 0;
      fresh.on('data', (d) => {
        n += d.length;
        if (n > 4096) {
          fresh.destroy();
          res(n);
        }
      });
      fresh.on('error', () => res(0));
      setTimeout(() => {
        fresh.destroy();
        res(n);
      }, 4000).unref();
    });
    assert.ok(got > 4096, `fresh stream should receive data through the live tunnel (got ${got})`);

    // Release backpressure: the stalled stream must now deliver the FULL blob intact — proving the PAUSE/RESUME cycle neither lost nor corrupted bytes.
    const recv = await new Promise((res) => {
      const chunks = [];
      let n = 0;
      stalled.on('data', (d) => {
        chunks.push(d);
        n += d.length;
        if (n >= BLOB.length) res(Buffer.concat(chunks));
      });
      stalled.resume();
      setTimeout(() => res(Buffer.concat(chunks)), 8000).unref();
    });
    assert.equal(recv.length, BLOB.length, `stalled stream should deliver all ${BLOB.length} bytes after resume`);
    assert.ok(recv.equals(BLOB), 'payload corrupted across the backpressure cycle');
    stalled.destroy();
  } finally {
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});

// Large payload must pass through intact (exercises backpressure + reassembly + close).
test('large payload passes through intact', { timeout: 25000 }, async () => {
  const sharedPort = await getFreePort();
  const providerPort = await getFreePort();
  const SIZE = 5 * 1024 * 1024;
  const blob = Buffer.allocUnsafe(SIZE);
  for (let i = 0; i < SIZE; i++) blob[i] = i & 0xff;
  const provider = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', () => {});
    s.end(blob); // write blob then FIN
  });
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  try {
    const listen = spawnNode('listen.js', { PUBLIC_PORT: String(sharedPort), AUTH_TOKEN: 'tkn' });
    procs.push(listen);
    await waitListening(sharedPort);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;

    const recv = await new Promise((res) => {
      const c = net.connect(sharedPort, '127.0.0.1');
      const chunks = [];
      c.on('data', (d) => chunks.push(d));
      c.on('end', () => res(Buffer.concat(chunks)));
      c.on('error', () => res(Buffer.concat(chunks)));
      setTimeout(() => {
        c.destroy();
        res(Buffer.concat(chunks));
      }, 18000).unref();
    });
    assert.equal(recv.length, SIZE, `expected ${SIZE} bytes, got ${recv.length}`);
    assert.ok(recv.equals(blob), 'payload corrupted in transit');
  } finally {
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});

// MAX_STREAMS caps concurrent public streams.
test('enforces MAX_STREAMS cap', { timeout: 20000 }, async () => {
  const sharedPort = await getFreePort();
  const providerPort = await getFreePort();
  const provider = net.createServer((s) => s.on('error', () => {})); // accept + hold open
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  const clients = [];
  try {
    const listen = spawnNode('listen.js', {
      PUBLIC_PORT: String(sharedPort),
      AUTH_TOKEN: 'tkn',
      MAX_STREAMS: '2',
    });
    procs.push(listen);
    await waitListening(sharedPort);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;

    for (let i = 0; i < 2; i++) {
      const c = net.connect(sharedPort, '127.0.0.1');
      c.on('error', () => {});
      clients.push(c);
      await new Promise((res, rej) => {
        c.on('connect', res);
        c.on('error', rej);
      });
    }
    await delay(400); // let both OPENs register as streams

    const refused = waitForLog(listen, /MAX_STREAMS .* reached/, 4000);
    const c3 = net.connect(sharedPort, '127.0.0.1');
    c3.on('error', () => {});
    clients.push(c3);
    await refused; // throws if the cap log never fires
  } finally {
    clients.forEach((c) => c.destroy());
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});

// Invalid numeric config is rejected loudly at startup, not silently coerced.
test('rejects invalid numeric config at startup', { timeout: 10000 }, async () => {
  const exitCode = await new Promise((res) => {
    const p = spawnNode('listen.js', { PUBLIC_PORT: String(9100), TUNNEL_TIMEOUT_MS: 'abc' });
    p.on('exit', (code) => res(code));
    setTimeout(() => {
      p.kill('SIGKILL');
      res(null);
    }, 4000).unref();
  });
  assert.equal(exitCode, 1, 'invalid TUNNEL_TIMEOUT_MS should exit(1)');
});

// C1 regression: closing a stream while its source is paused under backpressure must still reap the socket.
// With end() on a paused (non-reading) socket it lingers forever; the fix force-destroys a paused socket on CLOSE.
// We assert the provider stream is reaped.
test('a paused stream is reaped when it closes (no FD leak)', { timeout: 25000 }, async () => {
  const sharedPort = await getFreePort();
  const providerPort = await getFreePort();
  const BLOB = Buffer.alloc(8 * 1024 * 1024, 0x55);
  const provider = net.createServer((s) => {
    s.on('error', () => {});
    s.write(BLOB);
  });
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  try {
    const listen = spawnNode('listen.js', { PUBLIC_PORT: String(sharedPort), AUTH_TOKEN: 'tkn' });
    procs.push(listen);
    await waitListening(sharedPort);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;

    const stalled = net.connect(sharedPort, '127.0.0.1');
    await new Promise((res, rej) => {
      stalled.on('connect', res);
      stalled.on('error', rej);
    });
    stalled.pause(); // never read -> connect's provider gets PAUSE'd under backpressure
    await delay(900); // let the blob back up and the PAUSE propagate

    // Close while still paused; the paused provider MUST be reaped (logs "stream N closed").
    const reaped = waitForLog(connect, /stream \d+ closed/, 6000);
    stalled.destroy();
    await reaped; // throws if the paused provider lingered (the C1 bug)
  } finally {
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});

// Half-close: a public client that sends its request then shutdown-writes (FIN) must have that FIN propagate to the provider (so a read-until-EOF protocol can respond), while the provider->client direction stays open to deliver the response.
// On the OLD code (allowHalfOpen:false, no SHUTDOWN), the client FIN tore the stream down before the provider could reply — this test would hang/fail.
test('half-close propagates: client FIN -> provider, response still flows back', { timeout: 20000 }, async () => {
  const sharedPort = await getFreePort();
  const providerPort = await getFreePort();
  // Provider: read the whole request until EOF (client half-close), then reply + close.
  const provider = net.createServer({ allowHalfOpen: true }, (s) => {
    const chunks = [];
    s.on('error', () => {});
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => s.end(Buffer.concat([Buffer.from('REPLY:'), ...chunks])));
  });
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  try {
    const listen = spawnNode('listen.js', { PUBLIC_PORT: String(sharedPort), AUTH_TOKEN: 'tkn' });
    procs.push(listen);
    await waitListening(sharedPort);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;

    const reply = await new Promise((res) => {
      const c = net.connect(sharedPort, '127.0.0.1');
      const chunks = [];
      c.on('connect', () => c.end('PING')); // write request, then FIN (shutdown-write)
      c.on('data', (d) => chunks.push(d));
      c.on('end', () => res(Buffer.concat(chunks).toString()));
      c.on('error', () => res(''));
      setTimeout(() => {
        c.destroy();
        res(Buffer.concat(chunks).toString());
      }, 8000).unref();
    });
    assert.equal(reply, 'REPLY:PING', 'client FIN must reach the provider and the reply must flow back');
  } finally {
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});

// TUNNEL_NOT_READY=park (default): a public client that arrives BEFORE the tunnel is parked and served once the tunnel establishes (two-port).
test('park mode (default) serves a client that arrived before the tunnel', { timeout: 20000 }, async () => {
  const env = await setupBase(); // default wait
  try {
    const reqPromise = httpGet(env.publicPort, '/waited'); // fire before any tunnel -> parks
    await delay(400);
    const { established } = env.startConnect();
    await established;
    const res = await reqPromise;
    assert.equal(res.status, 200, 'parked request should be served once the tunnel is up');
    assert.match(res.body, /"url":"\/waited"/);
  } finally {
    await env.teardown();
  }
});

// Same, single-port: a client-speaks-first (non-magic) connection before the tunnel parks.
test('park mode single-port serves a client that arrived before the tunnel', { timeout: 20000 }, async () => {
  const providerPort = await getFreePort();
  const sharedPort = await getFreePort();
  const procs = [];
  try {
    const provider = spawnNode('example/provider.js', {
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
    });
    procs.push(provider);
    await waitListening(providerPort);
    const listen = spawnNode('listen.js', { PUBLIC_PORT: String(sharedPort), AUTH_TOKEN: 'tkn' });
    procs.push(listen);
    await waitListening(sharedPort);

    const reqPromise = httpGet(sharedPort, '/waited-sp'); // non-magic -> parked
    await delay(400);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;
    const res = await reqPromise;
    assert.equal(res.status, 200);
    assert.match(res.body, /"url":"\/waited-sp"/);
  } finally {
    await Promise.all(procs.map(kill));
  }
});

// Park mode is bounded: a parked client is dropped after PARK_TIMEOUT_MS if no tunnel appears.
test('park mode drops a parked client after PARK_TIMEOUT_MS', { timeout: 10000 }, async () => {
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const listen = spawnNode('listen.js', {
    CONTROL_PORT: String(controlPort),
    PUBLIC_PORT: String(publicPort),
    PARK_TIMEOUT_MS: '600',
  });
  try {
    await waitListening(publicPort);
    const res = await httpGet(publicPort, '/never'); // parks; no tunnel ever
    assert.ok(res.error, `expected drop after wait timeout, got HTTP ${res.status}`);
  } finally {
    await kill(listen);
  }
});

// Half-close, provider-initiated: provider sends a greeting + FIN, then the client keeps writing — the client->provider direction must stay open.
test('half-close: provider FIN reaches client; client->provider stays open', { timeout: 20000 }, async () => {
  const sharedPort = await getFreePort();
  const providerPort = await getFreePort();
  const received = [];
  const provider = net.createServer({ allowHalfOpen: true }, (s) => {
    s.on('error', () => {});
    s.on('data', (d) => received.push(d));
    s.end('GREETING'); // write a greeting then FIN (provider half-closes its write side)
  });
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  try {
    const listen = spawnNode('listen.js', { PUBLIC_PORT: String(sharedPort), AUTH_TOKEN: 'tkn' });
    procs.push(listen);
    await waitListening(sharedPort);
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(sharedPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;

    const result = await new Promise((res) => {
      const c = net.connect(sharedPort, '127.0.0.1');
      const chunks = [];
      let gotEnd = false;
      c.on('data', (d) => chunks.push(d));
      c.on('end', () => {
        gotEnd = true;
        c.write('AFTER-FIN'); // provider already FIN'd; our write side must still work
        c.end();
      });
      c.on('close', () => res({ greeting: Buffer.concat(chunks).toString(), gotEnd }));
      c.on('error', () => res({ greeting: Buffer.concat(chunks).toString(), gotEnd }));
      setTimeout(() => {
        c.destroy();
        res({ greeting: Buffer.concat(chunks).toString(), gotEnd });
      }, 6000).unref();
    });
    assert.equal(result.greeting, 'GREETING', 'provider greeting should arrive');
    assert.ok(result.gotEnd, 'client should see the provider FIN (half-close)');
    await delay(300);
    assert.ok(
      received.some((d) => d.toString().includes('AFTER-FIN')),
      'a client write after the provider FIN must still reach the provider',
    );
  } finally {
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});

// CRITICAL regression: a parked client that RSTs while waiting must NOT crash the listener (a parked socket with no 'error' handler would take the whole process down).
test('a parked client RST does not crash the listener', { timeout: 20000 }, async () => {
  const providerPort = await getFreePort();
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const procs = [];
  try {
    const provider = spawnNode('example/provider.js', {
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
    });
    procs.push(provider);
    await waitListening(providerPort);
    const listen = spawnNode('listen.js', {
      CONTROL_PORT: String(controlPort),
      PUBLIC_PORT: String(publicPort),
      AUTH_TOKEN: 'tkn',
    });
    procs.push(listen);
    await waitListening(publicPort);

    // Park several clients (no tunnel yet), then abruptly RST them.
    for (let i = 0; i < 5; i++) {
      const c = net.connect(publicPort, '127.0.0.1');
      c.on('error', () => {});
      await new Promise((res) => {
        c.on('connect', res);
        c.on('error', res);
      });
      if (c.resetAndDestroy) c.resetAndDestroy();
      else c.destroy();
    }
    await delay(400);
    assert.equal(listen.exitCode, null, 'listener must survive parked-client RSTs');

    // And still serve a real request once the tunnel comes up.
    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(controlPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;
    assert.equal((await httpGet(publicPort, '/alive')).status, 200);
  } finally {
    await Promise.all(procs.map(kill));
  }
});

// A client that connects during an outage is parked and served after reconnect.
test('a client parked during an outage is served after reconnect', { timeout: 30000 }, async () => {
  const env = await setupBase(); // park (default)
  try {
    const first = env.startConnect();
    await first.established;
    const lost = waitForLog(env.listen, /tunnel lost/);
    await kill(first.connect);
    await lost;

    const reqPromise = httpGet(env.publicPort, '/parked-thru-outage'); // parks during the outage
    await delay(300);
    const second = env.startConnect();
    await second.established;
    const res = await reqPromise;
    assert.equal(res.status, 200, 'parked-during-outage client should be served on reconnect');
    assert.match(res.body, /"url":"\/parked-thru-outage"/);
  } finally {
    await env.teardown();
  }
});

// A parked client that sent its request then half-closed (FIN) must still be served correctly once the tunnel comes up — the kernel-buffered request and the FIN both flow on resume (read-until-EOF protocol).
test('a parked client that half-closed its request is served on drain', { timeout: 20000 }, async () => {
  const providerPort = await getFreePort();
  const controlPort = await getFreePort();
  const publicPort = await getFreePort();
  const provider = net.createServer({ allowHalfOpen: true }, (s) => {
    const chunks = [];
    s.on('error', () => {});
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => s.end('REPLY:' + Buffer.concat(chunks).toString()));
  });
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const procs = [];
  try {
    const listen = spawnNode('listen.js', {
      CONTROL_PORT: String(controlPort),
      PUBLIC_PORT: String(publicPort),
      AUTH_TOKEN: 'tkn',
    });
    procs.push(listen);
    await waitListening(publicPort);

    const replyPromise = new Promise((res) => {
      const c = net.connect(publicPort, '127.0.0.1');
      const chunks = [];
      c.on('connect', () => c.end('PING')); // request + FIN (shutdown-write) before any tunnel
      c.on('data', (d) => chunks.push(d));
      c.on('end', () => res(Buffer.concat(chunks).toString()));
      c.on('error', () => res(''));
      setTimeout(() => {
        c.destroy();
        res(Buffer.concat(chunks).toString());
      }, 8000).unref();
    });
    await delay(400); // ensure it parked (request + FIN sit in the kernel buffer)

    const established = waitForLog(listen, /tunnel established/);
    const connect = spawnNode('connect.js', {
      SERVER_PORT: String(controlPort),
      PROVIDER_PORT: String(providerPort),
      PROVIDER_HOST: '127.0.0.1',
      AUTH_TOKEN: 'tkn',
    });
    procs.push(connect);
    await established;
    assert.equal(await replyPromise, 'REPLY:PING', 'a parked half-closed request must be served on drain');
  } finally {
    await Promise.all(procs.map(kill));
    await new Promise((r) => provider.close(r));
  }
});
