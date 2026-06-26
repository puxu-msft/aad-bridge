'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseEnvFile, loadEnvFile, parseValue, expandValue } = require('../lib/envfile');
const { tmpDir } = require('./helpers');
const os = require('os');

test('expandValue expands ~ (home) and $VAR / ${VAR}', () => {
  assert.equal(expandValue('~/.azure', {}), path.join(os.homedir(), '.azure'));
  assert.equal(expandValue('~', {}), os.homedir());
  assert.equal(expandValue('$HOME/.azure', { HOME: '/h' }), '/h/.azure');
  assert.equal(expandValue('${PWD}/certs', { PWD: '/w' }), '/w/certs');
  assert.equal(expandValue('$MISSING/x', {}), '/x'); // unset -> empty
  assert.equal(expandValue('plain', {}), 'plain');
  assert.equal(expandValue('C:\\logs\\a.log', {}), 'C:\\logs\\a.log'); // no $/~ -> untouched
});

test('loadEnvFile expands ~ and $VAR in loaded values', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'aad-bridge.env'), 'A=~/.azure\nB=${MYBASE}/audit.log\n');
  const env = { MYBASE: '/var/log' };
  loadEnvFile(path.join(dir, 'aad-bridge.env'), env);
  assert.equal(env.A, path.join(os.homedir(), '.azure'));
  assert.equal(env.B, '/var/log/audit.log');
});

test('parseValue strips inline comments but keeps in-value/quoted #', () => {
  assert.equal(parseValue('/var/log/a.log   # omit to use stdout'), '/var/log/a.log');
  assert.equal(parseValue('360 # keepalive minutes'), '360');
  assert.equal(parseValue('http://x#frag'), 'http://x#frag'); // no space before # -> kept
  assert.equal(parseValue("'a#b'"), 'a#b'); // # inside quotes kept
  assert.equal(parseValue('   # only a comment'), ''); // leading-# value -> empty
});

test('parseValue preserves Windows paths (literal backslashes, quoted spaces)', () => {
  assert.equal(parseValue('C:\\logs\\audit.log'), 'C:\\logs\\audit.log');
  assert.equal(parseValue('C:\\logs\\audit.log   # note'), 'C:\\logs\\audit.log');
  assert.equal(parseValue('"C:\\Program Files\\aad\\server.crt"'), 'C:\\Program Files\\aad\\server.crt');
});

test('parseEnvFile drops inline comments on active assignments (the AUDIT_LOG bug)', () => {
  const parsed = parseEnvFile(
    ['AUDIT_LOG=C:\\path\\audit.log   # omit to log to stdout', 'KEEPALIVE_MINUTES=360 # warm'].join('\n')
  );
  assert.equal(parsed.AUDIT_LOG, 'C:\\path\\audit.log');
  assert.equal(parsed.KEEPALIVE_MINUTES, '360');
});

test('parseEnvFile ignores ; full-line comments', () => {
  const parsed = parseEnvFile('; systemd-style comment\nPORT=9000\n');
  assert.equal(parsed.PORT, '9000');
  assert.ok(!(';' in parsed));
});

test('parseEnvFile handles comments, blanks, quotes and export', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'SECRET=abc',
      'export PORT=9000',
      'QUOTED="has space"',
      "SQUOTED='single'",
      'NOEQ',
      '  SPACED  =  trimmed  ',
    ].join('\n')
  );
  assert.equal(parsed.SECRET, 'abc');
  assert.equal(parsed.PORT, '9000');
  assert.equal(parsed.QUOTED, 'has space');
  assert.equal(parsed.SQUOTED, 'single');
  assert.equal(parsed.SPACED, 'trimmed');
  assert.ok(!('NOEQ' in parsed));
});

test('loadEnvFile only fills unset keys (existing env wins)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'aad-bridge.env');
  fs.writeFileSync(file, 'SECRET=fromfile\nPORT=1\n');
  const env = { SECRET: 'preset' };
  const res = loadEnvFile(file, env);
  assert.equal(res.found, true);
  assert.equal(env.SECRET, 'preset'); // not overwritten
  assert.equal(env.PORT, '1'); // filled
  assert.deepEqual(res.loaded.sort(), ['PORT']);
});

test('loadEnvFile reports not found without throwing', () => {
  const res = loadEnvFile(path.join(tmpDir(), 'missing.env'), {});
  assert.equal(res.found, false);
  assert.deepEqual(res.loaded, []);
});
