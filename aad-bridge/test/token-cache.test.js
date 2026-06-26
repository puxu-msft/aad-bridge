'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { TokenCache } = require('../lib/token-cache');
const { tmpDir, writeAzStub, testConfig } = require('./helpers');

test('TokenCache.key separates resource, tenant and subscription', () => {
  assert.notEqual(TokenCache.key('r', 't', 's1'), TokenCache.key('r', 't', 's2'));
  assert.equal(TokenCache.key('r', '', ''), 'r||');
});

test('isStale is true for missing entries and near-expiry tokens', () => {
  const c = new TokenCache(testConfig({ refreshSkewSeconds: 300 }));
  const now = Math.floor(Date.now() / 1000);
  assert.equal(c.isStale(undefined), true);
  assert.equal(c.isStale({ expiresOn: now + 100 }), true); // inside skew
  assert.equal(c.isStale({ expiresOn: now + 1000 }), false);
});

test('second get within TTL is served from cache (az called once)', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const c = new TokenCache(testConfig({ azPath: stub.path, refreshSkewSeconds: 300 }));
  await c.get({ resource: 'aks', tenant: '', subscription: '' });
  await c.get({ resource: 'aks', tenant: '', subscription: '' });
  assert.equal(stub.count(), 1);
});

test('concurrent gets collapse into a single az invocation (single-flight)', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const c = new TokenCache(testConfig({ azPath: stub.path }));
  const [a, b] = await Promise.all([
    c.get({ resource: 'aks', tenant: '', subscription: '' }),
    c.get({ resource: 'aks', tenant: '', subscription: '' }),
  ]);
  assert.equal(a.token, b.token);
  assert.equal(stub.count(), 1);
});

test('a stale token triggers a refresh', async () => {
  const dir = tmpDir();
  // Tokens "expire" immediately, so every get is stale and re-mints.
  const stub = writeAzStub(dir, { expiresInSec: 0 });
  const c = new TokenCache(testConfig({ azPath: stub.path, refreshSkewSeconds: 300 }));
  await c.get({ resource: 'aks', tenant: '', subscription: '' });
  await c.get({ resource: 'aks', tenant: '', subscription: '' });
  assert.equal(stub.count(), 2);
});

test('cache evicts the least-recently-used entry past the cap', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const c = new TokenCache(testConfig({ azPath: stub.path, cacheMaxEntries: 2 }));
  await c.get({ resource: 'r1', tenant: '', subscription: '' });
  await c.get({ resource: 'r2', tenant: '', subscription: '' });
  await c.get({ resource: 'r1', tenant: '', subscription: '' }); // touch r1 -> r2 is now LRU
  await c.get({ resource: 'r3', tenant: '', subscription: '' }); // pushes out r2
  assert.deepEqual(
    c.snapshot().map((e) => e.resource).sort(),
    ['r1', 'r3']
  );
});

test('snapshot omits token values but reports expiry', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 3600 });
  const c = new TokenCache(testConfig({ azPath: stub.path }));
  await c.get({ resource: 'aks', tenant: '', subscription: 'Sub A' });
  const snap = c.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].resource, 'aks');
  assert.equal(snap[0].subscription, 'Sub A');
  assert.ok(snap[0].expiresOn > 0);
  assert.ok(!('token' in snap[0]));
});
