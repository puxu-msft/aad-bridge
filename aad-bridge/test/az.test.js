'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getAccessToken, ReauthRequiredError, resolveAzInvocation, quoteForCmd } = require('../lib/az');
const { tmpDir, writeAzStub, testConfig } = require('./helpers');

test('quoteForCmd quotes only when needed and doubles inner quotes', () => {
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd('My Prod Sub'), '"My Prod Sub"');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.equal(quoteForCmd('has"q'), '"has""q"');
  assert.equal(quoteForCmd(''), '""');
});

test('resolveAzInvocation passes through unchanged on POSIX', () => {
  const args = ['account', 'get-access-token', '--resource', 'x'];
  const inv = resolveAzInvocation('az', args);
  assert.equal(inv.file, 'az');
  assert.deepEqual(inv.args, args);
  assert.deepEqual(inv.opts, {});
});

test('resolveAzInvocation routes through cmd.exe on win32 with quoted verbatim args', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    delete require.cache[require.resolve('../lib/az')];
    const win = require('../lib/az');
    const inv = win.resolveAzInvocation('az', ['account', 'get-access-token', '--subscription', 'My Prod Sub']);
    assert.match(inv.file, /cmd\.exe$/i);
    assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(inv.args[3], /az account get-access-token --subscription "My Prod Sub"/);
    assert.equal(inv.opts.windowsVerbatimArguments, true);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    delete require.cache[require.resolve('../lib/az')]; // restore POSIX-loaded module for other tests
  }
});

test('getAccessToken returns token + absolute expiry from the CLI', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { expiresInSec: 1800 });
  const before = Math.floor(Date.now() / 1000);
  const out = await getAccessToken({ resource: 'aks', subscription: 'Sub A', config: testConfig({ azPath: stub.path }) });
  assert.match(out.token, /^TOK\.aks\.Sub A$/);
  assert.equal(out.tokenType, 'Bearer');
  assert.ok(out.expiresOn >= before + 1700 && out.expiresOn <= before + 1900);
});

test('getAccessToken maps az login errors to ReauthRequiredError', async () => {
  const dir = tmpDir();
  const stub = writeAzStub(dir, { marker: "Please run 'az login' to setup account." });
  await assert.rejects(
    () => getAccessToken({ resource: 'aks', config: testConfig({ azPath: stub.path }) }),
    ReauthRequiredError
  );
});
