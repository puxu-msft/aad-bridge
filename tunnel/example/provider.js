#!/usr/bin/env node
'use strict';

/**
 * provider — a trivial HTTP server used only to demo/test the tunnel.
 * Stands in for whatever real service lives inside container B.
 *
 *   PROVIDER_PORT  listen port  (default 3000)
 *   PROVIDER_HOST  bind addr    (default 127.0.0.1)
 */

const http = require('http');

const PORT = Number(process.env.PROVIDER_PORT || 3000);
const HOST = process.env.PROVIDER_HOST || '127.0.0.1';

/** host:port for logs, bracketing IPv6 literals -> [::1]:3000. */
const addr = (host, port) => (String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        from: 'provider inside B',
        method: req.method,
        url: req.url,
        seenBy: addr(HOST, PORT),
        time: new Date().toISOString(),
      }) + '\n',
    );
  })
  .listen(PORT, HOST, () => {
    console.log(`[provider] listening on ${addr(HOST, PORT)}`);
  });
