'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'kubelogin-http-shim');
const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';

function stubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function run(args, env = {}) {
  // Isolate the disk cache per call so caching (now on by default) never touches
  // the real ~/.kube/cache and tests stay hermetic. Callers can pin AAD_TOKEN_CACHE_DIR
  // (e.g. to share a cache across two runs) via env, which wins over this default.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-e2e-'));
  const childEnv = { ...process.env, AAD_TOKEN_CACHE_DIR: cacheDir, ...env };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('end-to-end: emits a valid ExecCredential kubectl can consume (v1beta1 default)', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'eyJ-real-token', expires_on: 1893456000 }));
  });
  try {
    const { code, stdout } = await run([
      'get-token',
      '--login', 'azurecli',
      '--server-id', AKS,
      '--token-endpoint', `http://127.0.0.1:${port}/token`,
      '--token-endpoint-header', 'Authorization=Bearer s3cr3t',
    ]);
    assert.equal(code, 0);
    const ec = JSON.parse(stdout);
    assert.equal(ec.kind, 'ExecCredential');
    assert.equal(ec.apiVersion, 'client.authentication.k8s.io/v1beta1');
    assert.equal(ec.status.token, 'eyJ-real-token');
    assert.equal(ec.status.expirationTimestamp, new Date(1893456000 * 1000).toISOString());
  } finally {
    server.close();
  }
});

test('end-to-end: echoes the apiVersion from KUBERNETES_EXEC_INFO', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
  });
  try {
    const { code, stdout } = await run(
      ['get-token', '--server-id', AKS, '--token-endpoint', `http://127.0.0.1:${port}/token`],
      { KUBERNETES_EXEC_INFO: JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential' }) },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).apiVersion, 'client.authentication.k8s.io/v1');
  } finally {
    server.close();
  }
});

test('end-to-end: honors AAD_TOKEN_ENDPOINT env and tolerates unknown kubelogin flags', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok2', expires_in: 600 }));
  });
  try {
    const { code, stdout, stderr } = await run(
      ['get-token', '--server-id', AKS, '--environment', 'AzurePublicCloud', '--pop-enabled'],
      { AAD_TOKEN_ENDPOINT: `http://127.0.0.1:${port}/token` },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).status.token, 'tok2');
    assert.match(stderr, /ignoring unsupported flag/);
  } finally {
    server.close();
  }
});

test('end-to-end: non-zero exit and stderr on endpoint failure', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ needs_login: true }));
  });
  try {
    const { code, stdout, stderr } = await run([
      'get-token', '--server-id', AKS, '--token-endpoint', `http://127.0.0.1:${port}/token`,
    ]);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /status 503/);
  } finally {
    server.close();
  }
});

test('end-to-end: --help exits 0 without contacting an endpoint', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /kubectl exec credential plugin/);
});

test('end-to-end: missing --server-id fails fast', async () => {
  const { code, stderr } = await run(['get-token', '--token-endpoint', 'http://127.0.0.1:1/token']);
  assert.equal(code, 1);
  assert.match(stderr, /--server-id is required/);
});

test('end-to-end: a second call is served from the disk cache, skipping the endpoint', async () => {
  let hits = 0;
  const { server, port } = await stubServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'cached-tok', expires_on: 1893456000 })); // far-future expiry
  });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-e2e-hit-'));
  const args = ['get-token', '--server-id', AKS, '--token-endpoint', `http://127.0.0.1:${port}/token`];
  try {
    const first = await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    const second = await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(JSON.parse(first.stdout).status.token, 'cached-tok');
    assert.equal(JSON.parse(second.stdout).status.token, 'cached-tok');
    assert.equal(hits, 1, 'the second invocation must be served from cache');
  } finally {
    server.close();
  }
});

test('end-to-end: --disable-token-cache hits the endpoint on every call', async () => {
  let hits = 0;
  const { server, port } = await stubServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok', expires_on: 1893456000 }));
  });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-e2e-nocache-'));
  const args = ['get-token', '--server-id', AKS, '--token-endpoint', `http://127.0.0.1:${port}/token`, '--disable-token-cache'];
  try {
    await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    assert.equal(hits, 2, 'caching disabled: both invocations hit the endpoint');
  } finally {
    server.close();
  }
});

test('end-to-end: a cached token inside the refresh skew is refetched and the file rewritten', async () => {
  let hits = 0;
  const { server, port } = await stubServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Token has ~120s of life; with a 300s skew it's "stale" the moment it lands, so every call refetches.
    res.end(JSON.stringify({ access_token: `tok-${hits}`, expires_in: 120 }));
  });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-e2e-stale-'));
  const args = ['get-token', '--server-id', AKS, '--token-endpoint', `http://127.0.0.1:${port}/token`, '--token-cache-refresh-skew', '300'];
  try {
    const first = await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    const second = await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    assert.equal(JSON.parse(first.stdout).status.token, 'tok-1');
    assert.equal(JSON.parse(second.stdout).status.token, 'tok-2'); // refetched, not the stale cached one
    assert.equal(hits, 2, 'a within-skew token must be refreshed, not served from cache');
    // The cache file was written both times (best-effort persistence of the fresh token).
    const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
  } finally {
    server.close();
  }
});

test('end-to-end: a corrupt cache file degrades to a live fetch and is overwritten', async () => {
  let hits = 0;
  const { server, port } = await stubServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'fresh-tok', expires_on: 1893456000 }));
  });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-e2e-corrupt-'));
  const args = ['get-token', '--server-id', AKS, '--token-endpoint', `http://127.0.0.1:${port}/token`];
  try {
    // Seed the exact cache file the shim will look for with garbage.
    const first = await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    assert.equal(hits, 1);
    const file = fs.readdirSync(cacheDir).find((f) => f.endsWith('.json'));
    fs.writeFileSync(path.join(cacheDir, file), 'garbage{not json');

    const second = await run(args, { AAD_TOKEN_CACHE_DIR: cacheDir });
    assert.equal(second.code, 0);
    assert.equal(JSON.parse(second.stdout).status.token, 'fresh-tok');
    assert.equal(hits, 2, 'corrupt cache must fall back to a live fetch');
    assert.match(second.stderr, /corrupt/);
    // And the corrupt file was replaced with a valid entry.
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8')));
  } finally {
    server.close();
  }
});
