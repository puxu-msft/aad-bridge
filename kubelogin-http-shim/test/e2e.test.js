'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
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
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
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
