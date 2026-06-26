'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { authorize, safeEqual } = require('../lib/auth');
const { fakeReq, testConfig } = require('./helpers');

test('safeEqual is correct for equal/unequal/length-mismatch', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('authorize accepts a matching bearer secret', () => {
  const cfg = testConfig({ secret: 's3cr3t' });
  const req = fakeReq({ headers: { authorization: 'Bearer s3cr3t' } });
  assert.equal(authorize(req, cfg).ok, true);
});

test('authorize rejects a wrong/missing secret', () => {
  const cfg = testConfig({ secret: 's3cr3t' });
  assert.equal(authorize(fakeReq({ headers: { authorization: 'Bearer nope' } }), cfg).ok, false);
  assert.equal(authorize(fakeReq({}), cfg).ok, false);
});

test('authorize honors X-Auth-Token header', () => {
  const cfg = testConfig({ secret: 's3cr3t' });
  const req = fakeReq({ headers: { 'x-auth-token': 's3cr3t' } });
  assert.equal(authorize(req, cfg).ok, true);
});

test('authorize allows anonymous when allowNoAuth', () => {
  const cfg = testConfig({ allowNoAuth: true });
  assert.equal(authorize(fakeReq({}), cfg).ok, true);
});

test('authorize trusts a verified mTLS client and surfaces its CN', () => {
  const cfg = testConfig({ tls: { clientCA: 'ca.pem' } });
  const req = fakeReq({
    socket: { authorized: true, getPeerCertificate: () => ({ subject: { CN: 'dev-laptop-01' } }) },
  });
  const res = authorize(req, cfg);
  assert.equal(res.ok, true);
  assert.equal(res.cn, 'dev-laptop-01');
});

test('authorize rejects an unauthorized mTLS socket without a secret', () => {
  const cfg = testConfig({ tls: { clientCA: 'ca.pem' } });
  const req = fakeReq({ socket: { authorized: false, getPeerCertificate: () => ({}) } });
  assert.equal(authorize(req, cfg).ok, false);
});
