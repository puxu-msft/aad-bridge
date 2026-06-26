'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createAudit } = require('../lib/audit');
const { tmpDir } = require('./helpers');

test('audit writes JSON to stdout when no path is configured', () => {
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    createAudit({ auditLogPath: '' }).token({ ip: '1.2.3.4', resource: 'aks', result: 'ok' });
  } finally {
    console.log = orig;
  }
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.event, 'token');
  assert.equal(rec.resource, 'aks');
  assert.ok(rec.ts);
});

test('audit close() flushes buffered lines to the log file', async () => {
  const fs = require('fs');
  const file = path.join(tmpDir(), 'audit.log');
  const audit = createAudit({ auditLogPath: file });
  audit.token({ ip: '1.2.3.4', resource: 'aks', result: 'ok' });
  await audit.close();
  assert.match(fs.readFileSync(file, 'utf8'), /"resource":"aks"/);
});

test('audit degrades to stdout when the log path is unwritable (no crash)', async () => {
  const badPath = path.join(tmpDir(), 'no', 'such', 'dir', 'audit.log');
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m) => logs.push(['log', String(m)]);
  console.error = (m) => logs.push(['err', String(m)]);
  try {
    const audit = createAudit({ auditLogPath: badPath });
    await new Promise((r) => setTimeout(r, 60)); // let the async ENOENT fire
    audit.token({ ip: '1.2.3.4', resource: 'aks', result: 'ok' });
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.ok(logs.some(([k, m]) => k === 'err' && m.includes('falling back to stdout')));
  assert.ok(logs.some(([k, m]) => k === 'log' && m.includes('aks')));
});
