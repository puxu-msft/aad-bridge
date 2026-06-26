#!/usr/bin/env node
'use strict';

/**
 * Minimal zero-dependency HTTP server that exposes a zip behind a secret token.
 *
 * Typical use: move ~/.azure (or any dir/file) from machine A to machine B on a
 * trusted LAN. Because this can ship credentials over the wire, it ships locked
 * down by default: a strong token is required, the token compare is timing-safe,
 * the endpoint path is unguessable, and downloads can be capped + time-limited.
 *
 * Config via env vars:
 *   PORT          listen port            (default 8765)
 *   HOST          bind address           (default 0.0.0.0 — needed for remote pull)
 *   SECRET        access token           (auto-generated + printed if unset)
 *   ZIP_SOURCE    dir to zip on the fly, or path to an existing .zip   (required)
 *   MAX_DOWNLOADS stop after N successful pulls, 0 = unlimited         (default 1)
 *   TTL_SECONDS   auto-exit after N seconds, 0 = never                 (default 600)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const ZIP_SOURCE = process.env.ZIP_SOURCE;
const MAX_DOWNLOADS = Number(process.env.MAX_DOWNLOADS ?? 1);
const TTL_SECONDS = Number(process.env.TTL_SECONDS ?? 600);
const SECRET = process.env.SECRET || crypto.randomBytes(24).toString('base64url');

if (!ZIP_SOURCE) {
  console.error('FATAL: ZIP_SOURCE is required (a directory to zip, or a .zip file path).');
  process.exit(1);
}
if (!fs.existsSync(ZIP_SOURCE)) {
  console.error(`FATAL: ZIP_SOURCE does not exist: ${ZIP_SOURCE}`);
  process.exit(1);
}

const ROUTE = `/pull/${SECRET}`;
let downloads = 0;

/** Timing-safe equality that never throws on length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing roughly constant, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Extract the presented token from path or Authorization/X-Auth-Token header. */
function presentedToken(req, url) {
  const m = url.pathname.match(/^\/pull\/(.+)$/);
  if (m) return decodeURIComponent(m[1]);
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']);
  return '';
}

/** Stream a zip to the response: from disk if .zip, else zip the dir on the fly. */
function streamZip(res, downloadName) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'Cache-Control': 'no-store',
  });

  const stat = fs.statSync(ZIP_SOURCE);
  if (stat.isFile()) {
    const stream = fs.createReadStream(ZIP_SOURCE);
    stream.on('error', (err) => {
      console.error('read error:', err.message);
      res.destroy();
    });
    stream.pipe(res);
    return;
  }

  // Directory: `zip -r -q - .` writes the archive to stdout, we pipe it through.
  const zip = spawn('zip', ['-r', '-q', '-', '.'], { cwd: ZIP_SOURCE });
  zip.stdout.pipe(res);
  zip.stderr.on('data', (d) => console.error('zip:', d.toString().trim()));
  zip.on('error', (err) => {
    console.error('failed to spawn zip:', err.message);
    res.destroy();
  });
  res.on('close', () => zip.kill('SIGKILL')); // client hung up — don't leave zip running
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const client = req.socket.remoteAddress;

  if (req.method !== 'GET') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  // Anything that isn't a /pull/... request gets a flat 404 — don't reveal the route.
  const token = presentedToken(req, url);
  const isPullPath = url.pathname.startsWith('/pull/') || url.pathname === '/pull';
  if (!isPullPath || !token || !safeEqual(token, SECRET)) {
    console.warn(`[deny] ${client} ${req.method} ${url.pathname}`);
    res.writeHead(404).end('Not Found');
    return;
  }

  if (MAX_DOWNLOADS > 0 && downloads >= MAX_DOWNLOADS) {
    console.warn(`[deny] ${client} — download cap (${MAX_DOWNLOADS}) reached`);
    res.writeHead(410).end('Gone');
    return;
  }

  downloads += 1;
  const base = path.basename(path.resolve(ZIP_SOURCE)).replace(/[^\w.-]/g, '_') || 'bundle';
  const name = base.endsWith('.zip') ? base : `${base}.zip`;
  console.log(`[ok]   ${client} pull #${downloads} -> ${name}`);
  streamZip(res, name);

  res.on('close', () => {
    if (MAX_DOWNLOADS > 0 && downloads >= MAX_DOWNLOADS) {
      console.log('Download cap reached, shutting down.');
      setTimeout(() => process.exit(0), 100);
    }
  });
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(require('os').networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('zip-bridge listening');
  console.log(`  source     : ${ZIP_SOURCE}`);
  console.log(`  bind       : ${HOST}:${PORT}`);
  console.log(`  max pulls  : ${MAX_DOWNLOADS || 'unlimited'}`);
  console.log(`  ttl        : ${TTL_SECONDS ? TTL_SECONDS + 's' : 'none'}`);
  console.log('  pull from machine B:');
  for (const ip of lan.length ? lan : ['<this-host-ip>']) {
    console.log(`    curl -fSL http://${ip}:${PORT}${ROUTE} -o bundle.zip`);
  }
  if (HOST === '0.0.0.0') {
    console.warn('  WARNING: bound to all interfaces over plain HTTP. Use only on a trusted LAN.');
  }
});

if (TTL_SECONDS > 0) {
  setTimeout(() => {
    console.log(`TTL ${TTL_SECONDS}s elapsed, shutting down.`);
    process.exit(0);
  }, TTL_SECONDS * 1000).unref();
}

process.on('SIGINT', () => process.exit(0));
