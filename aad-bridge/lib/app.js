'use strict';

/**
 * The aad-bridge application: HTTP(S) server, routing, and lifecycle, with no side effects on require.
 * server.js is a thin entry that calls createApp() then listens; tests import createApp() directly and drive it in-process.
 *
 * This is an internal-network dev tool, so it leans toward observability: a rich /healthz, an unauthenticated /debug dump (config with the secret redacted, cache metadata without token values, recent requests), and a per-request access log.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

const { TokenCache } = require('./token-cache');
const { ReauthRequiredError, startInteractiveLogin } = require('./az');
const { authorize } = require('./auth');
const { createAudit } = require('./audit');
const { parseTokenRequest } = require('./request');

// How many recent requests to keep in memory for /debug.
const RECENT_REQUESTS_MAX = 50;
// How long graceful shutdown waits for in-flight requests before forcing exit.
const SHUTDOWN_TIMEOUT_MS = 10_000;

function nowIso() {
  return new Date().toISOString();
}

/** Resolve when `p` settles, or reject after `ms` — used to bound how long a request blocks on an in-flight login. */
function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('login wait timeout')), ms);
      t.unref();
    }),
  ]);
}

/** Build TLS options from configured cert/key/clientCA paths. */
function tlsOptions(config) {
  const opts = {
    cert: fs.readFileSync(config.tls.cert),
    key: fs.readFileSync(config.tls.key),
  };
  if (config.tls.clientCA) {
    opts.ca = fs.readFileSync(config.tls.clientCA);
    opts.requestCert = true;
    opts.rejectUnauthorized = true; // enforce mTLS at the TLS layer
  }
  return opts;
}

/** Config view for /debug — the bearer secret is redacted (a credential is not debug info); everything else is exposed. */
function redactedConfig(c) {
  return {
    port: c.port,
    host: c.host,
    auth: { secret: c.secret ? '***redacted***' : null, allowNoAuth: c.allowNoAuth, mtls: !!(c.tls && c.tls.clientCA) },
    tls: c.tls ? { cert: c.tls.cert, key: c.tls.key, clientCA: c.tls.clientCA || null } : null,
    allowedResources: c.allowAnyResource ? 'any' : [...c.allowedResources],
    subscription: c.subscription || null,
    allowedSubscriptions: c.allowedSubscriptions.size ? [...c.allowedSubscriptions] : 'any',
    azPath: c.azPath,
    azureConfigDir: c.azureConfigDir || '(default ~/.azure)',
    passTenant: c.passTenant,
    refreshSkewSeconds: c.refreshSkewSeconds,
    keepaliveMinutes: c.keepaliveMinutes,
    cacheMaxEntries: c.cacheMaxEntries,
    tokenTimeoutMs: c.tokenTimeoutMs,
    auditLogPath: c.auditLogPath || 'stdout',
    accessLog: c.accessLog,
    envFile: c.envFile,
  };
}

/**
 * Construct the app without listening.
 * @returns {{server, handler, cache, audit, health, startKeepalive, shutdown}}
 */
function createApp(config) {
  const cache = new TokenCache(config);
  const audit = createAudit(config);
  const startedAt = Date.now();
  const health = { loggedIn: null, lastMintAt: null, lastError: null, needsReauth: false, loginInProgress: false };
  const recent = []; // ring buffer of recent requests for /debug

  // Single-flight interactive re-login. When the refresh token dies, kick off `az login` (browser, or device code) on the daemon host so it recovers without a human SSHing in. Concurrent re-auth errors collapse into one login. The tenant comes from the triggering request (multi-tenant: login must target it, or it lands in the home tenant).
  let loginPromise = null;
  function ensureReauth(tenant) {
    if (!config.autoLogin || loginPromise) return loginPromise;
    health.loginInProgress = true;
    const target = tenant || config.loginTenant;
    audit.lifecycle({ event: 'login', detail: `${config.loginUseDeviceCode ? 'device-code' : 'browser'} login started${target ? ' tenant=' + target : ''}` });
    loginPromise = startInteractiveLogin(config, { tenant: target, onOutput: (s) => process.stdout.write(s) })
      .then(() => {
        cache.clear();
        health.needsReauth = false;
        health.loggedIn = true;
        health.lastError = null;
        audit.lifecycle({ event: 'login', detail: 'ok' });
      })
      .catch((err) => {
        health.lastError = err.message;
        audit.lifecycle({ event: 'login', detail: `fail ${err.message}` });
      })
      .finally(() => {
        health.loginInProgress = false;
        loginPromise = null;
      });
    return loginPromise;
  }

  function recordRequest(rec) {
    recent.push(rec);
    if (recent.length > RECENT_REQUESTS_MAX) recent.shift();
  }

  function sendJSON(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function uptimeSec() {
    return Math.floor((Date.now() - startedAt) / 1000);
  }

  function healthBody() {
    return {
      status: health.needsReauth ? 'needs_login' : 'ok',
      version: config.version,
      pid: process.pid,
      uptimeSec: uptimeSec(),
      allowedResources: config.allowAnyResource ? 'any' : [...config.allowedResources],
      subscription: config.subscription || null,
      allowedSubscriptions: config.allowedSubscriptions.size ? [...config.allowedSubscriptions] : 'any',
      ...health,
    };
  }

  function debugBody() {
    return {
      version: config.version,
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: uptimeSec(),
      health,
      config: redactedConfig(config),
      cache: cache.snapshot(),
      recentRequests: recent.slice(),
    };
  }

  async function handleToken(req, res, ip) {
    const auth = authorize(req, config);
    if (!auth.ok) {
      audit.token({ ip, cn: auth.cn, resource: '-', result: 'deny', detail: auth.reason });
      return sendJSON(res, 401, { error: 'unauthorized' });
    }

    let parsed;
    try {
      parsed = await parseTokenRequest(req);
    } catch (err) {
      audit.token({ ip, cn: auth.cn, resource: '-', result: 'error', detail: err.message });
      return sendJSON(res, 400, { error: err.message });
    }

    const { resource, tenant } = parsed;
    if (!resource) {
      audit.token({ ip, cn: auth.cn, resource: '-', result: 'error', detail: 'no resource/serverId/scope' });
      return sendJSON(res, 400, { error: 'could not determine resource from request' });
    }
    if (!config.allowAnyResource && !config.allowedResources.has(resource)) {
      audit.token({ ip, cn: auth.cn, resource, tenant, result: 'deny', detail: 'resource not allowlisted' });
      return sendJSON(res, 403, { error: `resource ${resource} is not allowlisted` });
    }

    // Effective subscription: request value, else the daemon's configured default.
    // When an allowlist is set, the effective subscription must be in it.
    const subscription = parsed.subscription || config.subscription || '';
    if (config.allowedSubscriptions.size && !config.allowedSubscriptions.has(subscription)) {
      audit.token({ ip, cn: auth.cn, resource, tenant, result: 'deny', detail: `subscription ${subscription || '(none)'} not allowlisted` });
      return sendJSON(res, 403, { error: `subscription ${subscription || '(none)'} is not allowlisted` });
    }

    try {
      let entry;
      try {
        entry = await cache.get({ resource, tenant, subscription });
      } catch (err) {
        if (!(err instanceof ReauthRequiredError) || !config.autoLogin) throw err;
        // Refresh token died: launch (or join) the single-flight az login, block this request until it finishes or times out, then retry the mint once.
        health.needsReauth = true;
        health.loggedIn = false;
        health.lastError = err.message;
        const login = ensureReauth(tenant);
        if (login) await withTimeout(login, config.loginTimeoutMs).catch(() => {});
        entry = await cache.get({ resource, tenant, subscription }); // re-throws if login didn't fix it -> outer catch
      }
      health.loggedIn = true;
      health.needsReauth = false;
      health.lastMintAt = nowIso();
      audit.token({ ip, cn: auth.cn, resource, tenant, result: 'ok' });
      const expiresIn = Math.max(0, entry.expiresOn - Math.floor(Date.now() / 1000));
      return sendJSON(res, 200, {
        access_token: entry.token,
        token_type: entry.tokenType || 'Bearer',
        expires_on: entry.expiresOn,
        expires_in: expiresIn,
      });
    } catch (err) {
      const reauth = err instanceof ReauthRequiredError;
      health.loggedIn = false;
      health.needsReauth = reauth;
      health.lastError = err.message;
      audit.token({ ip, cn: auth.cn, resource, tenant, result: 'error', detail: err.message });
      if (reauth) ensureReauth(tenant); // keep a login attempt alive in the background
      return sendJSON(res, reauth ? 503 : 502, {
        error: reauth ? 'server identity needs re-login' : 'failed to obtain token',
        detail: err.message,
        needs_login: reauth || undefined,
        login_in_progress: reauth ? health.loginInProgress : undefined,
      });
    }
  }

  const handler = (req, res) => {
    const ip = req.socket.remoteAddress;
    const start = Date.now();
    const path = (req.url || '/').split('?')[0];

    // Per-request access log + recent-requests ring, for every path (incl. /healthz, /debug, 404s).
    res.on('finish', () => {
      const rec = { ts: nowIso(), event: 'request', method: req.method, path, status: res.statusCode, ms: Date.now() - start, ip };
      recordRequest(rec);
      if (config.accessLog) console.log(JSON.stringify(rec));
    });

    if (path === '/healthz') return sendJSON(res, health.needsReauth ? 503 : 200, healthBody());
    if (path === '/debug') return sendJSON(res, 200, debugBody());
    if (path === '/token' && (req.method === 'GET' || req.method === 'POST')) return handleToken(req, res, ip);
    sendJSON(res, 404, { error: 'not found' });
  };

  const server = config.tls ? https.createServer(tlsOptions(config), handler) : http.createServer(handler);

  let keepaliveTimer = null;

  // Keepalive: periodically mint each allowlisted resource so the server's MSAL refresh token stays warm even when no developer is active, and so /healthz reflects login status proactively.
  function startKeepalive() {
    if (config.keepaliveMinutes <= 0) return;
    const tick = async () => {
      for (const resource of config.allowedResources) {
        try {
          await cache.get({ resource, tenant: '', subscription: config.subscription });
          health.loggedIn = true;
          health.needsReauth = false;
          health.lastMintAt = nowIso();
          audit.lifecycle({ event: 'keepalive', detail: `ok ${resource}` });
        } catch (err) {
          const reauth = err instanceof ReauthRequiredError;
          health.loggedIn = false;
          health.needsReauth = reauth;
          health.lastError = err.message;
          if (reauth) ensureReauth(); // recover unattended when the refresh token dies between dev sessions
          audit.lifecycle({ event: 'keepalive', detail: `fail ${resource}: ${err.message}` });
        }
      }
    };
    tick();
    keepaliveTimer = setInterval(tick, config.keepaliveMinutes * 60 * 1000);
    keepaliveTimer.unref();
  }

  // Graceful shutdown: stop the keepalive, stop accepting connections and drain in-flight requests, then flush the audit log. Resolves even if draining stalls past SHUTDOWN_TIMEOUT_MS.
  function shutdown() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        audit.close().then(resolve); // wait for the audit file flush before resolving
      };
      const force = setTimeout(finish, SHUTDOWN_TIMEOUT_MS);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        finish();
      });
    });
  }

  return { server, handler, cache, audit, health, startKeepalive, shutdown, ensureReauth, healthBody, debugBody };
}

module.exports = { createApp, redactedConfig };
