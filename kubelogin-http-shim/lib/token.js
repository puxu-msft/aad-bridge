'use strict';

/**
 * Fetches an AAD access token from the aad-bridge HTTP(S) token endpoint, mirroring the wire contract of the Go fork's HTTPTokenCredential (pkg/internal/token/httptokencredential.go).
 *
 * Request  (POST): JSON body { scope, tenantId, serverId }
 *          (GET):  same fields as query parameters
 * Response: OAuth2 token response { access_token, token_type, expires_in, expires_on }
 *           expires_on (absolute epoch seconds) takes precedence over expires_in.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const { getScope, serverIDFromScope } = require('./scope');

// Bounds how much of a non-2xx response body is surfaced in errors.
const MAX_ERROR_BODY_BYTES = 2048;

// Abort a stalled request so a black-holed network can't hang kubectl forever.
const REQUEST_TIMEOUT_MS = 30000;

/**
 * @param {object} cfg parsed+validated config from lib/args
 * @returns {Promise<{ token: string, expiresOn: Date }>}
 */
async function fetchToken(cfg) {
  const scope = getScope(cfg.serverID);
  const payload = {
    scope,
    tenantId: cfg.tenantID || '',
    serverId: serverIDFromScope(scope),
  };

  const { requestOptions, body } = buildRequest(cfg, payload);
  const res = await doRequest(requestOptions, body);

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const snippet = sanitizeForLog(res.body.slice(0, MAX_ERROR_BODY_BYTES));
    throw new Error(`token endpoint returned status ${res.statusCode}: ${snippet}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`failed to decode token endpoint response: ${err.message}`);
  }
  if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
    throw new Error('token endpoint response did not contain an access_token');
  }

  return { token: parsed.access_token, expiresOn: resolveExpiry(parsed) };
}

/**
 * Build node http/https request options + body for the configured method.
 * @param {object} cfg
 * @param {{scope: string, tenantId: string, serverId: string}} payload
 */
function buildRequest(cfg, payload) {
  const url = new URL(cfg.tokenEndpoint);
  const headers = { Accept: 'application/json' };
  let body = null;

  if (cfg.method === 'GET') {
    url.searchParams.set('scope', payload.scope);
    url.searchParams.set('tenantId', payload.tenantId);
    url.searchParams.set('serverId', payload.serverId);
  } else {
    body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  // Inline headers first, then headers loaded from files (so a file can carry a bearer secret without it ever appearing in argv or the kubeconfig).
  for (const h of cfg.headers.concat(readHeaderFiles(cfg.headerFiles || []))) {
    const idx = h.indexOf('=');
    headers[h.slice(0, idx)] = h.slice(idx + 1);
  }

  const requestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: cfg.method,
    headers,
  };

  if (url.protocol === 'https:') {
    applyTLS(requestOptions, cfg);
  }

  return { requestOptions, body };
}

/** Attach CA, client cert (mTLS), and insecure-skip options for HTTPS. */
function applyTLS(requestOptions, cfg) {
  requestOptions.minVersion = 'TLSv1.2';
  if (cfg.caFile) {
    requestOptions.ca = readFileOrThrow(cfg.caFile, 'token endpoint CA file');
  }
  if (cfg.certFile && cfg.keyFile) {
    requestOptions.cert = readFileOrThrow(cfg.certFile, 'token endpoint client certificate');
    requestOptions.key = readFileOrThrow(cfg.keyFile, 'token endpoint client key');
  }
  if (cfg.insecureSkipTLSVerify) {
    requestOptions.rejectUnauthorized = false;
    process.stderr.write(`[shim] WARNING: TLS verification disabled for ${cfg.tokenEndpoint}\n`);
  }
}

/** Strip control/escape characters so a hostile endpoint can't inject terminal sequences via error output. */
function sanitizeForLog(s) {
  // Collapse any run of C0 control chars (incl. ESC/newlines) and DEL into a single space.
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function readFileOrThrow(p, label) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    throw new Error(`failed to read ${label}: ${err.message}`);
  }
}

/**
 * Read header files, each containing one `key=value` header per line.
 * Blank lines and `#` comments are ignored.
 * Keeping the secret in a file (rather than a --token-endpoint-header flag) keeps it out of argv / the kubeconfig.
 * @param {string[]} paths
 * @returns {string[]} header strings in `key=value` form
 */
function readHeaderFiles(paths) {
  const out = [];
  for (const p of paths) {
    const content = readFileOrThrow(p, `token endpoint header file ${p}`).toString('utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '' || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) {
        throw new Error(`header file ${p} line ${i + 1} is not in key=value format`);
      }
      out.push(line);
    }
  }
  return out;
}

/**
 * Perform the request and buffer the response body.
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function doRequest(options, body) {
  const transport = options.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => reject(new Error(`failed to call token endpoint: ${err.message}`)));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`token endpoint timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Resolve token expiry, preferring absolute expires_on over relative expires_in.
 * @param {{expires_on?: number, expires_in?: number}} resp
 * @returns {Date}
 */
function resolveExpiry(resp) {
  const on = Number(resp.expires_on);
  if (Number.isFinite(on) && on > 0) return new Date(on * 1000);
  const inSec = Number(resp.expires_in);
  if (Number.isFinite(inSec) && inSec > 0) return new Date(Date.now() + inSec * 1000);
  return new Date(0);
}

module.exports = { fetchToken, buildRequest, resolveExpiry, MAX_ERROR_BODY_BYTES };
