'use strict';

// Shared helpers for the integration tests: spawn the real listen/connect/provider processes on ephemeral ports and drive them as black boxes.

const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');

/** Ask the OS for an unused TCP port so parallel test runs never collide. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn `node <file>` from the package root with extra env.
 *  Inherits process.env so NODE_V8_COVERAGE (set by c8) propagates into the child for coverage. */
function spawnNode(file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {}); // drain to avoid backpressure stalls
  return child;
}

/** Resolve once something is accepting TCP connections on the port. */
function waitListening(port, host = '127.0.0.1', timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, host);
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${port} never listened`));
        else setTimeout(attempt, 40).unref();
      });
    };
    attempt();
  });
}

/** Resolve when the child's future stdout matches `re` (does not see past output). */
function waitForLog(child, re, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d;
      if (re.test(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${re} (saw: ${buf.slice(-200)})`));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
    };
    child.stdout.on('data', onData);
  });
}

/** GET through the tunnel's public port. Resolves {status, body} or {error}. */
function httpGet(port, p = '/') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ error: 'TIMEOUT' });
    });
  });
}

/** Graceful SIGTERM (lets listen/connect flush coverage on exit), SIGKILL fallback. */
function kill(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch {
      return done();
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 1500).unref();
  });
}

module.exports = { getFreePort, spawnNode, waitListening, waitForLog, httpGet, kill };
