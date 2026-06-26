'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchToken, resolveExpiry, buildRequest } = require('../lib/token');

const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';

/** Spin up a one-shot HTTP server that captures the request and replies. */
function stubServer(handler) {
  return new Promise((resolve) => {
    const captured = {};
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        captured.method = req.method;
        captured.url = req.url;
        captured.headers = req.headers;
        captured.body = Buffer.concat(chunks).toString('utf8');
        handler(req, res, captured);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, captured, endpoint: `http://127.0.0.1:${port}/token` });
    });
  });
}

function baseCfg(overrides) {
  return {
    serverID: AKS,
    tenantID: 'tenant-1',
    method: 'POST',
    headers: [],
    headerFiles: [],
    caFile: '',
    certFile: '',
    keyFile: '',
    insecureSkipTLSVerify: false,
    ...overrides,
  };
}

test('POST sends a JSON body with scope/tenantId/serverId and parses the token', async () => {
  const { server, port, captured } = await stubServer((req, res, cap) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'eyJ0', token_type: 'Bearer', expires_on: 1893456000 }));
  });
  try {
    const cfg = baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token`, headers: ['Authorization=Bearer s3cr3t'] });
    const out = await fetchToken(cfg);
    assert.equal(out.token, 'eyJ0');
    assert.equal(out.expiresOn.getTime(), 1893456000 * 1000);

    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['content-type'], 'application/json');
    assert.equal(captured.headers['accept'], 'application/json');
    assert.equal(captured.headers['authorization'], 'Bearer s3cr3t');
    const body = JSON.parse(captured.body);
    assert.equal(body.scope, `${AKS}/.default`);
    assert.equal(body.tenantId, 'tenant-1');
    assert.equal(body.serverId, AKS);
  } finally {
    server.close();
  }
});

test('GET encodes scope/tenantId/serverId as query params', async () => {
  const { server, port, captured } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
  });
  try {
    const cfg = baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token`, method: 'GET' });
    const out = await fetchToken(cfg);
    assert.equal(out.token, 'tok');
    const u = new URL(captured.url, 'http://x');
    assert.equal(u.searchParams.get('scope'), `${AKS}/.default`);
    assert.equal(u.searchParams.get('tenantId'), 'tenant-1');
    assert.equal(u.searchParams.get('serverId'), AKS);
    assert.equal(captured.method, 'GET');
    assert.equal(captured.body, '');
  } finally {
    server.close();
  }
});

test('expires_on takes precedence over expires_in', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok', expires_in: 60, expires_on: 1893456000 }));
  });
  try {
    const out = await fetchToken(baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token` }));
    assert.equal(out.expiresOn.getTime(), 1893456000 * 1000);
  } finally {
    server.close();
  }
});

test('non-2xx surfaces a truncated error body', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'resource not allowed' }));
  });
  try {
    await assert.rejects(
      fetchToken(baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token` })),
      /status 403.*resource not allowed/s,
    );
  } finally {
    server.close();
  }
});

test('strips control/escape characters from an error body to prevent terminal injection', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end("boom\u001b[31m\u0007evil");
  });
  try {
    await fetchToken(baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token` }));
    assert.fail('expected rejection');
  } catch (err) {
    assert.match(err.message, /status 500/);
    assert.doesNotMatch(err.message, /[\u0000-\u001f\u007f]/);
  } finally {
    server.close();
  }
});

test('reads headers from --token-endpoint-header-file, ignoring blanks and comments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-hdr-'));
  const file = path.join(dir, 'token-header');
  fs.writeFileSync(file, '# the bearer secret, kept out of argv\n\nAuthorization=Bearer file-s3cr3t\nX-Extra=1\n');
  const { server, port, captured } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok', expires_in: 600 }));
  });
  try {
    const cfg = baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token`, headerFiles: [file] });
    await fetchToken(cfg);
    assert.equal(captured.headers['authorization'], 'Bearer file-s3cr3t');
    assert.equal(captured.headers['x-extra'], '1');
  } finally {
    server.close();
  }
});

test('inline --token-endpoint-header and header files combine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-hdr-'));
  const file = path.join(dir, 'h');
  fs.writeFileSync(file, 'Authorization=Bearer from-file\n');
  const cfg = baseCfg({
    tokenEndpoint: 'https://x/token', headers: ['X-Inline=yes'], headerFiles: [file],
  });
  const { requestOptions } = buildRequest(cfg, { scope: `${AKS}/.default`, tenantId: '', serverId: AKS });
  assert.equal(requestOptions.headers['X-Inline'], 'yes');
  assert.equal(requestOptions.headers['Authorization'], 'Bearer from-file');
});

test('a malformed header-file line is a clear error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-hdr-'));
  const file = path.join(dir, 'bad');
  fs.writeFileSync(file, 'Authorization=Bearer ok\nnoequalshere\n');
  const cfg = baseCfg({ tokenEndpoint: 'https://x/token', headerFiles: [file] });
  assert.throws(
    () => buildRequest(cfg, { scope: `${AKS}/.default`, tenantId: '', serverId: AKS }),
    /header file .* line 2 is not in key=value format/,
  );
});

test('a missing header-file is a clear error', () => {
  const cfg = baseCfg({ tokenEndpoint: 'https://x/token', headerFiles: ['/no/such/header'] });
  assert.throws(
    () => buildRequest(cfg, { scope: `${AKS}/.default`, tenantId: '', serverId: AKS }),
    /failed to read token endpoint header file/,
  );
});

test('missing access_token is an error', async () => {
  const { server, port } = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token_type: 'Bearer' }));
  });
  try {
    await assert.rejects(
      fetchToken(baseCfg({ tokenEndpoint: `http://127.0.0.1:${port}/token` })),
      /did not contain an access_token/,
    );
  } finally {
    server.close();
  }
});

test('resolveExpiry falls back to expires_in then to epoch zero', () => {
  const now = Date.now();
  const viaIn = resolveExpiry({ expires_in: 100 });
  assert.ok(viaIn.getTime() >= now + 99000 && viaIn.getTime() <= now + 101000);
  assert.equal(resolveExpiry({}).getTime(), 0);
});

test('buildRequest wires CA, mTLS cert/key and insecure-skip for HTTPS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tls-'));
  const caFile = path.join(dir, 'ca.pem');
  const certFile = path.join(dir, 'client.crt');
  const keyFile = path.join(dir, 'client.key');
  fs.writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(certFile, 'CERT');
  fs.writeFileSync(keyFile, 'KEY');

  const cfg = {
    serverID: AKS, tenantID: '', method: 'POST', headers: [],
    tokenEndpoint: 'https://aad-bridge.internal:8765/token',
    caFile, certFile, keyFile, insecureSkipTLSVerify: true,
  };
  const { requestOptions } = buildRequest(cfg, { scope: `${AKS}/.default`, tenantId: '', serverId: AKS });
  assert.equal(requestOptions.minVersion, 'TLSv1.2');
  assert.ok(requestOptions.ca.includes('CA'));
  assert.equal(requestOptions.cert.toString(), 'CERT');
  assert.equal(requestOptions.key.toString(), 'KEY');
  assert.equal(requestOptions.rejectUnauthorized, false);
});

test('buildRequest surfaces a clear error when the CA file is missing', () => {
  const cfg = {
    serverID: AKS, tenantID: '', method: 'POST', headers: [],
    tokenEndpoint: 'https://x/token',
    caFile: '/no/such/ca.pem', certFile: '', keyFile: '', insecureSkipTLSVerify: false,
  };
  assert.throws(
    () => buildRequest(cfg, { scope: `${AKS}/.default`, tenantId: '', serverId: AKS }),
    /failed to read token endpoint CA file/,
  );
});
