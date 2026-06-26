'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir, writeAzStub, freePort } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');
const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';

function request(port, { method = 'GET', path: p = '/token', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await request(port, { path: '/healthz' });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('server did not become ready');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

test('end-to-end: token issuance, auth and allowlist over HTTP', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir, // no aad-bridge.env here -> clean env
    env: {
      ...process.env,
      SECRET: 's3cr3t',
      AZ_PATH: stub.path,
      PORT: String(port),
      HOST: '127.0.0.1',
      KEEPALIVE_MINUTES: '0',
      ALLOWED_SUBSCRIPTIONS: 'Prod-Sub',
      SUBSCRIPTION: 'Prod-Sub',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  try {
    await waitReady(port);
    const auth = { Authorization: 'Bearer s3cr3t', 'Content-Type': 'application/json' };

    // 1. authorized POST mints a token
    const ok = await request(port, { method: 'POST', headers: auth, body: JSON.stringify({ serverId: AKS }) });
    assert.equal(ok.status, 200);
    const token = JSON.parse(ok.body);
    assert.match(token.access_token, /^TOK\.6dae42f8/);
    assert.equal(token.token_type, 'Bearer');
    assert.ok(token.expires_on > 0);

    // 2. GET also works
    const get = await request(port, { path: `/token?serverId=${AKS}`, headers: auth });
    assert.equal(get.status, 200);

    // 3. no auth -> 401
    const noauth = await request(port, { method: 'POST', body: JSON.stringify({ serverId: AKS }) });
    assert.equal(noauth.status, 401);

    // 4. off-allowlist resource -> 403
    const badRes = await request(port, { method: 'POST', headers: auth, body: JSON.stringify({ serverId: 'deadbeef' }) });
    assert.equal(badRes.status, 403);

    // 5. wrong subscription -> 403
    const badSub = await request(port, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ serverId: AKS, subscription: 'Other-Sub' }),
    });
    assert.equal(badSub.status, 403);

    // 6. healthz
    const health = await request(port, { path: '/healthz' });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).status, 'ok');
  } catch (err) {
    throw new Error(`${err.message}\n--- server stderr ---\n${stderr}`);
  } finally {
    child.kill('SIGKILL');
  }
});
