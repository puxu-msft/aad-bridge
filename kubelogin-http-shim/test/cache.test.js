'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  defaultCacheDir,
  resolveCacheDir,
  cacheKey,
  cacheFilePath,
  readCache,
  writeCache,
} = require('../lib/cache');

const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';
const EP = 'https://aad-bridge.internal:8765/token';

/** A config with caching enabled, rooted at a throwaway temp dir. */
function cfgWith(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cache-'));
  return {
    dir,
    cfg: {
      serverID: AKS,
      tenantID: 'tenant-1',
      tokenEndpoint: EP,
      tokenCacheDir: dir,
      disableTokenCache: false,
      tokenCacheRefreshSkew: 300,
      ...overrides,
    },
  };
}

const silent = () => {};
function inSec(seconds) {
  return new Date(Date.now() + seconds * 1000);
}

test('resolveCacheDir: default when unset, null when disabled or emptied', () => {
  assert.equal(resolveCacheDir({ tokenCacheDir: null, disableTokenCache: false }), defaultCacheDir());
  assert.equal(resolveCacheDir({ tokenCacheDir: '', disableTokenCache: false }), null);
  assert.equal(resolveCacheDir({ tokenCacheDir: '/x', disableTokenCache: true }), null);
  assert.equal(resolveCacheDir({ tokenCacheDir: '/x', disableTokenCache: false }), '/x');
});

test('cacheKey is stable and varies by endpoint, serverID, and tenant', () => {
  const base = { serverID: AKS, tenantID: 't', tokenEndpoint: EP };
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, tokenEndpoint: 'https://other/token' }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, serverID: 'different' }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, tenantID: 'other' }));
});

test('cacheFilePath is null when caching disabled', () => {
  const { cfg } = cfgWith({ disableTokenCache: true });
  assert.equal(cacheFilePath(cfg), null);
});

test('write then read round-trips the token and expiry', () => {
  const { cfg } = cfgWith();
  const expiresOn = inSec(3600);
  writeCache(cfg, { token: 'tok-abc', expiresOn }, silent);

  const got = readCache(cfg, silent);
  assert.ok(got);
  assert.equal(got.token, 'tok-abc');
  // Serialized to whole seconds, so compare at second granularity.
  assert.equal(Math.floor(got.expiresOn.getTime() / 1000), Math.floor(expiresOn.getTime() / 1000));
});

test('read returns null on a cold cache (no file)', () => {
  const { cfg } = cfgWith();
  assert.equal(readCache(cfg, silent), null);
});

test('read returns null when the token is within the refresh skew', () => {
  const { cfg } = cfgWith({ tokenCacheRefreshSkew: 300 });
  writeCache(cfg, { token: 'tok', expiresOn: inSec(120) }, silent); // 120s < 300s skew
  assert.equal(readCache(cfg, silent), null);
});

test('read returns null and warns on corrupt cache content', () => {
  const { cfg } = cfgWith();
  fs.writeFileSync(cacheFilePath(cfg), 'not json{');
  const warnings = [];
  assert.equal(readCache(cfg, (m) => warnings.push(m)), null);
  assert.ok(warnings.some((w) => /corrupt/.test(w)));
});

test('read returns null on a malformed (missing fields) entry', () => {
  const { cfg } = cfgWith();
  fs.writeFileSync(cacheFilePath(cfg), JSON.stringify({ token: '' }));
  assert.equal(readCache(cfg, silent), null);
});

test('write does not persist a token with unknown expiry (epoch 0)', () => {
  const { cfg } = cfgWith();
  writeCache(cfg, { token: 'tok', expiresOn: new Date(0) }, silent);
  assert.equal(fs.existsSync(cacheFilePath(cfg)), false);
});

test('write is a no-op when caching is disabled', () => {
  const { cfg, dir } = cfgWith({ disableTokenCache: true });
  writeCache(cfg, { token: 'tok', expiresOn: inSec(3600) }, silent);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('cache file is written with 0600 permissions', { skip: process.platform === 'win32' }, () => {
  const { cfg } = cfgWith();
  writeCache(cfg, { token: 'tok', expiresOn: inSec(3600) }, silent);
  const mode = fs.statSync(cacheFilePath(cfg)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a freshly created cache directory is 0700', { skip: process.platform === 'win32' }, () => {
  const { cfg, dir } = cfgWith();
  const created = path.join(dir, 'made-by-shim'); // not pre-existing, so writeCache mkdirs it
  cfg.tokenCacheDir = created;
  writeCache(cfg, { token: 'tok', expiresOn: inSec(3600) }, silent);
  assert.equal(fs.statSync(created).mode & 0o777, 0o700);
});

test('refresh skew of 0 serves any not-yet-expired token', () => {
  const { cfg } = cfgWith({ tokenCacheRefreshSkew: 0 });
  writeCache(cfg, { token: 'tok', expiresOn: inSec(30) }, silent); // 30s left, skew 0
  const got = readCache(cfg, silent);
  assert.ok(got);
  assert.equal(got.token, 'tok');
});

test('a refresh skew larger than the token lifetime always misses', () => {
  const { cfg } = cfgWith({ tokenCacheRefreshSkew: 100000 });
  writeCache(cfg, { token: 'tok', expiresOn: inSec(3600) }, silent); // 1h left, skew ~28h
  assert.equal(readCache(cfg, silent), null);
});

test('creates the cache directory when missing', () => {
  const { cfg, dir } = cfgWith();
  const nested = path.join(dir, 'sub', 'kubelogin-http-shim');
  cfg.tokenCacheDir = nested;
  writeCache(cfg, { token: 'tok', expiresOn: inSec(3600) }, silent);
  assert.ok(fs.existsSync(cacheFilePath(cfg)));
});

test('write failure warns and does not throw', () => {
  const { cfg, dir } = cfgWith();
  // Make the cache dir a *file*, so mkdir/write underneath it fails with ENOTDIR.
  const asFile = path.join(dir, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  cfg.tokenCacheDir = asFile;
  const warnings = [];
  assert.doesNotThrow(() => writeCache(cfg, { token: 'tok', expiresOn: inSec(3600) }, (m) => warnings.push(m)));
  assert.ok(warnings.some((w) => /write failed/.test(w)));
});
