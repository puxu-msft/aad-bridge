'use strict';

// Shared helpers for the aad-bridge test suite (zero-dependency, node:test).

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');

/** Create a throwaway temp directory. */
function tmpDir(prefix = 'aadb-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a fake Node IncomingMessage good enough for request.js / auth.js.
 * For non-GET methods it emits the body on the next tick.
 */
function fakeReq({ method = 'GET', url = '/token', body = '', headers = {}, socket = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = Object.assign({ remoteAddress: '127.0.0.1' }, socket);
  if (method !== 'GET') {
    process.nextTick(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  }
  return req;
}

/**
 * Write an executable stub that mimics `az account get-access-token`.
 * Returns its path and an invocation counter.
 * With `marker` it writes that text to stderr and exits non-zero (to exercise re-auth detection).
 */
function writeAzStub(dir, { expiresInSec = 3600, marker = '', exitCode = 1 } = {}) {
  const countFile = path.join(dir, 'az-count');
  fs.writeFileSync(countFile, '0');
  const body = marker
    ? `process.stderr.write(${JSON.stringify(marker)}); process.exit(${exitCode});`
    : `const get=(f)=>{const i=args.indexOf(f);return i>=0?args[i+1]:'';};
const out={accessToken:'TOK.'+get('--resource')+'.'+get('--subscription'),expires_on:Math.floor(Date.now()/1000)+${expiresInSec},tokenType:'Bearer'};
process.stdout.write(JSON.stringify(out));`;
  const script = `#!/usr/bin/env node
const fs=require('fs');
const cf=${JSON.stringify(countFile)};
fs.writeFileSync(cf,String(Number(fs.readFileSync(cf,'utf8'))+1));
const args=process.argv.slice(2);
${body}
`;
  const p = path.join(dir, 'az-stub.js');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return { path: p, count: () => Number(fs.readFileSync(countFile, 'utf8')) };
}

/** Minimal config object for unit tests, overridable per case. */
function testConfig(overrides = {}) {
  return Object.assign(
    {
      azPath: 'az',
      azureConfigDir: '',
      passTenant: false,
      tokenTimeoutMs: 5000,
      refreshSkewSeconds: 300,
      cacheMaxEntries: 256,
      secret: '',
      allowNoAuth: false,
      tls: null,
      allowedResources: new Set(),
      allowAnyResource: false,
      allowedSubscriptions: new Set(),
      subscription: '',
      keepaliveMinutes: 0,
      accessLog: false,
      version: 'test',
      auditLogPath: '',
      envFile: null,
    },
    overrides
  );
}

/** Resolve a free ephemeral TCP port on loopback. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

module.exports = { tmpDir, fakeReq, writeAzStub, testConfig, freePort };
