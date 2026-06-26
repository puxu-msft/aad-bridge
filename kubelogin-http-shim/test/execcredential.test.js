'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  apiVersionFromExecInfo,
  buildExecCredential,
  writeExecCredential,
  API_V1,
  API_V1BETA1,
} = require('../lib/execcredential');

test('apiVersionFromExecInfo defaults to v1beta1 when env is absent or empty', () => {
  assert.equal(apiVersionFromExecInfo(undefined), API_V1BETA1);
  assert.equal(apiVersionFromExecInfo(''), API_V1BETA1);
  assert.equal(apiVersionFromExecInfo(JSON.stringify({})), API_V1BETA1);
  assert.equal(apiVersionFromExecInfo(JSON.stringify({ apiVersion: '' })), API_V1BETA1);
});

test('apiVersionFromExecInfo echoes a supported apiVersion', () => {
  assert.equal(apiVersionFromExecInfo(JSON.stringify({ apiVersion: API_V1 })), API_V1);
  assert.equal(apiVersionFromExecInfo(JSON.stringify({ apiVersion: API_V1BETA1 })), API_V1BETA1);
});

test('apiVersionFromExecInfo throws on unsupported version', () => {
  assert.throws(() => apiVersionFromExecInfo(JSON.stringify({ apiVersion: 'v2' })), /not supported/);
});

test('apiVersionFromExecInfo throws on malformed JSON', () => {
  assert.throws(() => apiVersionFromExecInfo('{not json'), /cannot unmarshal/);
});

test('buildExecCredential emits token and RFC3339 expiration', () => {
  const expiresOn = new Date('2026-06-26T12:00:00.000Z');
  const ec = buildExecCredential({ token: 'eyJ0', expiresOn }, API_V1);
  assert.equal(ec.kind, 'ExecCredential');
  assert.equal(ec.apiVersion, API_V1);
  assert.equal(ec.status.token, 'eyJ0');
  assert.equal(ec.status.expirationTimestamp, '2026-06-26T12:00:00.000Z');
});

test('buildExecCredential omits a zero/unknown expiry', () => {
  const ec = buildExecCredential({ token: 'eyJ0', expiresOn: new Date(0) }, API_V1BETA1);
  assert.equal(ec.status.expirationTimestamp, undefined);
  assert.equal(ec.status.token, 'eyJ0');
});

test('writeExecCredential writes a single JSON line to the stream', () => {
  const chunks = [];
  const writer = { write: (s) => chunks.push(s) };
  writeExecCredential({ token: 'tok', expiresOn: new Date('2026-06-26T12:00:00Z') }, writer, JSON.stringify({ apiVersion: API_V1 }));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].endsWith('\n'));
  const parsed = JSON.parse(chunks[0]);
  assert.equal(parsed.apiVersion, API_V1);
  assert.equal(parsed.status.token, 'tok');
});
