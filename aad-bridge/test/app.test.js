'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../lib/app');
const { tmpDir, writeAzStub, testConfig } = require('./helpers');

const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';

function request(port, { method = 'GET', path = '/token', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => resolve(app.server.address().port)));
}

function makeApp() {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const config = testConfig({ azPath: stub.path, secret: 's3cr3t', allowedResources: new Set([AKS]) });
  return createApp(config);
}

test('app: /healthz reports status, version and uptime', async () => {
  const app = makeApp();
  const port = await listen(app);
  try {
    const res = await request(port, { path: '/healthz' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.version, 'test');
    assert.ok(typeof body.uptimeSec === 'number');
  } finally {
    await app.shutdown();
  }
});

test('app: /token mints, then /debug exposes redacted config + cache metadata + recent requests', async () => {
  const app = makeApp();
  const port = await listen(app);
  try {
    const auth = { Authorization: 'Bearer s3cr3t', 'Content-Type': 'application/json' };
    const mint = await request(port, { method: 'POST', headers: auth, body: JSON.stringify({ serverId: AKS }) });
    assert.equal(mint.status, 200);
    assert.match(JSON.parse(mint.body).access_token, /^TOK\./);

    const dbg = JSON.parse((await request(port, { path: '/debug' })).body);
    assert.equal(dbg.config.auth.secret, '***redacted***'); // secret never exposed
    assert.equal(dbg.cache.length, 1);
    assert.equal(dbg.cache[0].resource, AKS);
    assert.ok(!('token' in dbg.cache[0])); // token value never exposed
    assert.ok(dbg.recentRequests.some((r) => r.path === '/token' && r.status === 200));
  } finally {
    await app.shutdown();
  }
});

test('app: unauthorized /token is 401, unknown path is 404', async () => {
  const app = makeApp();
  const port = await listen(app);
  try {
    assert.equal((await request(port, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await request(port, { path: '/nope' })).status, 404);
  } finally {
    await app.shutdown();
  }
});

test('app: missing resource -> 400, off-allowlist resource -> 403', async () => {
  const app = makeApp();
  const port = await listen(app);
  const auth = { Authorization: 'Bearer s3cr3t', 'Content-Type': 'application/json' };
  try {
    assert.equal((await request(port, { method: 'POST', headers: auth, body: '{}' })).status, 400);
    assert.equal((await request(port, { method: 'POST', headers: auth, body: JSON.stringify({ serverId: 'nope' }) })).status, 403);
  } finally {
    await app.shutdown();
  }
});

test('app: az re-auth failure -> 503 needs_login and /healthz flips', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { marker: "Please run 'az login' to setup account." });
  const app = createApp(testConfig({ azPath: stub.path, secret: 's3cr3t', allowedResources: new Set([AKS]) }));
  const port = await listen(app);
  try {
    const r = await request(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer s3cr3t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: AKS }),
    });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).needs_login, true);
    const h = JSON.parse((await request(port, { path: '/healthz' })).body);
    assert.equal(h.status, 'needs_login');
  } finally {
    await app.shutdown();
  }
});

test('app: keepalive mints each allowlisted resource on start', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const app = createApp(testConfig({ azPath: stub.path, secret: 's', allowedResources: new Set([AKS]), keepaliveMinutes: 60 }));
  try {
    app.startKeepalive(); // tick() fires once immediately
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(stub.count() >= 1);
  } finally {
    await app.shutdown();
  }
});

test('app: auto-login triggers a single az login on re-auth, then clears state', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 }); // exits 0 for any args incl. `login`
  const app = createApp(testConfig({ azPath: stub.path, secret: 's', allowedResources: new Set([AKS]), autoLogin: true }));
  app.health.needsReauth = true;
  await Promise.all([app.ensureReauth(), app.ensureReauth()]); // concurrent -> single-flight
  assert.equal(stub.count(), 1);
  assert.equal(app.health.needsReauth, false);
  assert.equal(app.health.loginInProgress, false);
});

test('app: re-login targets the request tenant (multi-tenant)', async () => {
  const dir = tmpDir();
  const argf = path.join(dir, 'login-args');
  const stub = path.join(dir, 'az.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argf)}, process.argv.slice(2).join(' '));process.stdout.write('ok');`,
    { mode: 0o755 }
  );
  const app = createApp(testConfig({ azPath: stub, secret: 's', autoLogin: true }));
  await app.ensureReauth('TENANT-X');
  assert.match(fs.readFileSync(argf, 'utf8'), /login .*--tenant TENANT-X/);
});

test('app: auto-login disabled never launches login', () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const app = createApp(testConfig({ azPath: stub.path, secret: 's', autoLogin: false }));
  assert.equal(app.ensureReauth(), undefined);
  assert.equal(stub.count(), 0);
});

test('app: /token blocks for the in-flight login, then succeeds on retry', async () => {
  const dir = tmpDir();
  const flag = path.join(dir, 'logged-in');
  const stub = path.join(dir, 'az.js');
  // get-access-token fails re-auth until `login` runs and drops the flag file.
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const f=${JSON.stringify(flag)};
if(a.includes('login')){fs.writeFileSync(f,'1');process.stdout.write('ok');process.exit(0);}
if(!fs.existsSync(f)){process.stderr.write('Please run: az login');process.exit(1);}
process.stdout.write(JSON.stringify({accessToken:'TOK',expires_on:Math.floor(Date.now()/1000)+3600,tokenType:'Bearer'}));`,
    { mode: 0o755 }
  );
  const app = createApp(testConfig({ azPath: stub, secret: 's', allowedResources: new Set([AKS]), autoLogin: true, loginTimeoutMs: 5000 }));
  const port = await listen(app);
  try {
    const r = await request(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer s', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: AKS }),
    });
    assert.equal(r.status, 200);
    assert.match(JSON.parse(r.body).access_token, /^TOK/);
  } finally {
    await app.shutdown();
  }
});

test('app: shutdown drains and stops accepting connections', async () => {
  const app = makeApp();
  const port = await listen(app);
  await app.shutdown();
  await assert.rejects(() => request(port, { path: '/healthz' })); // ECONNREFUSED
});
