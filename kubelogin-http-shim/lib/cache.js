'use strict';

/**
 * Client-side on-disk token cache.
 *
 * kubectl runs an exec credential plugin as a fresh process on every invocation, and client-go's credential cache lives only in that process's memory — so without a disk cache each `kubectl` call would make a fresh HTTP round-trip to aad-bridge. This mirrors what the Go kubelogin does with its `--token-cache-dir`: persist the access token keyed by (endpoint, scope, tenant) and reuse it until it nears expiry.
 *
 * The cache is strictly best-effort: any read/write/parse failure degrades to a live fetch (with a stderr warning) rather than breaking token acquisition. Tokens are written 0600 into a 0700 directory; they are bearer secrets, same as kubelogin's own cache, so the directory should stay private to the user.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getScope } = require('./scope');

/** Default cache directory, alongside kubelogin's own `~/.kube/cache/` convention. */
function defaultCacheDir() {
  return path.join(os.homedir(), '.kube', 'cache', 'kubelogin-http-shim');
}

/**
 * Resolve the effective cache directory, or null when caching is disabled.
 *
 * Disabled when `--disable-token-cache` is set, or when the cache dir is explicitly the empty string. A null/absent dir falls back to the default; a non-empty string is used verbatim.
 * @param {object} cfg
 * @returns {string|null}
 */
function resolveCacheDir(cfg) {
  if (cfg.disableTokenCache) return null;
  if (cfg.tokenCacheDir === '') return null; // explicitly disabled
  if (cfg.tokenCacheDir == null) return defaultCacheDir();
  return cfg.tokenCacheDir;
}

/**
 * Stable cache key over everything that determines which token comes back:
 * the endpoint (which identity the bridge serves), the derived scope, and the tenant.
 *
 * Deliberately excludes the request credentials (--token-endpoint-header / mTLS cert):
 * aad-bridge serves a single shared `az login` identity, so a given endpoint returns the
 * same identity's token regardless of which credential authenticated the caller — the
 * credential gates *access to the bridge*, it does not select *which* identity is minted.
 * If the bridge ever became multi-identity per endpoint, this key MUST fold in a hash of
 * the identity-selecting credential (cert file contents / distinguishing header) or callers
 * would read each other's tokens.
 * @param {object} cfg
 * @returns {string} hex sha256 digest
 */
function cacheKey(cfg) {
  const parts = [cfg.tokenEndpoint || '', getScope(cfg.serverID), cfg.tenantID || ''];
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Absolute path of the cache file for this config, or null when caching is disabled.
 * @param {object} cfg
 * @returns {string|null}
 */
function cacheFilePath(cfg) {
  const dir = resolveCacheDir(cfg);
  if (dir === null) return null;
  return path.join(dir, `${cacheKey(cfg)}.json`);
}

/**
 * Return a cached access token that is still comfortably valid, or null on
 * miss / staleness / any error (all treated as a cache miss so the caller re-fetches).
 * @param {object} cfg
 * @param {(msg: string) => void} [warn]
 * @returns {{ token: string, expiresOn: Date }|null}
 */
function readCache(cfg, warn = defaultWarn) {
  const file = cacheFilePath(cfg);
  if (file === null) return null;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // A missing file is the normal cold-cache case; only surface real read errors.
    if (err.code !== 'ENOENT') warn(`[shim] token cache read failed, fetching fresh: ${err.message}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Don't echo err.message: V8 embeds a snippet of the (corrupt) file content, which could carry token bytes. The corrupt case needs no detail to act on.
    warn('[shim] token cache is corrupt, fetching fresh');
    return null;
  }

  const expiresOnSec = Number(parsed && parsed.expiresOn);
  if (typeof (parsed && parsed.token) !== 'string' || parsed.token === '' || !Number.isFinite(expiresOnSec) || expiresOnSec <= 0) {
    warn('[shim] token cache entry is malformed, fetching fresh');
    return null;
  }

  const skew = refreshSkew(cfg);
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresOnSec - skew <= nowSec) return null; // too close to expiry — refresh

  return { token: parsed.token, expiresOn: new Date(expiresOnSec * 1000) };
}

/**
 * Persist an access token best-effort. Never throws: a cache write failure must
 * not fail the credential plugin, since the token has already been obtained.
 * Tokens with unknown expiry (epoch 0) are not cached — we cannot reason about their validity.
 * @param {object} cfg
 * @param {{ token: string, expiresOn: Date }} accessToken
 * @param {(msg: string) => void} [warn]
 */
function writeCache(cfg, accessToken, warn = defaultWarn) {
  const file = cacheFilePath(cfg);
  if (file === null) return;

  const expiresOnSec = accessToken.expiresOn ? Math.floor(accessToken.expiresOn.getTime() / 1000) : 0;
  if (!Number.isFinite(expiresOnSec) || expiresOnSec <= 0) return; // don't cache unknown-expiry tokens

  const record = {
    token: accessToken.token,
    expiresOn: expiresOnSec,
    // Metadata for humans inspecting the cache dir; not consulted on read.
    scope: getScope(cfg.serverID),
    serverId: cfg.serverID,
    tenantId: cfg.tenantID || '',
    endpoint: cfg.tokenEndpoint || '',
    cachedAt: Math.floor(Date.now() / 1000),
  };

  const dir = path.dirname(file);
  // Unique temp name so concurrent writers (parallel kubectl calls) never clobber each other; the rename is atomic on POSIX.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    warn(`[shim] token cache write failed (continuing): ${err.message}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; ignore if the temp file was never created.
    }
  }
}

/** Effective refresh skew in whole seconds (defaults handled by args, but guard here too). */
function refreshSkew(cfg) {
  const s = Number(cfg.tokenCacheRefreshSkew);
  return Number.isFinite(s) && s >= 0 ? Math.floor(s) : 300;
}

function defaultWarn(msg) {
  process.stderr.write(`${msg}\n`);
}

module.exports = {
  defaultCacheDir,
  resolveCacheDir,
  cacheKey,
  cacheFilePath,
  readCache,
  writeCache,
};
