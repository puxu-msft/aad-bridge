'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, AKS_AAD_SERVER_APP_ID } = require('../lib/config');
const { tmpDir } = require('./helpers');

const CONFIG_PATH = path.join(__dirname, '..', 'lib', 'config.js');

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

test('defaults: AKS resource allowlist, port and keepalive', () => {
  withCwd(tmpDir(), () => {
    const cfg = loadConfig(['--secret', 'x'], {});
    assert.equal(cfg.port, 8765);
    assert.equal(cfg.keepaliveMinutes, 360);
    assert.ok(cfg.allowedResources.has(AKS_AAD_SERVER_APP_ID));
    assert.equal(cfg.allowAnyResource, false);
    assert.equal(cfg.accessLog, true);
    assert.equal(cfg.cacheMaxEntries, 256);
    assert.ok(cfg.version);
  });
});

test('--no-access-log and ACCESS_LOG=0 disable the access log', () => {
  withCwd(tmpDir(), () => {
    assert.equal(loadConfig(['--secret', 'x', '--no-access-log'], {}).accessLog, false);
    assert.equal(loadConfig(['--secret', 'x'], { ACCESS_LOG: '0' }).accessLog, false);
  });
});

test('precedence: CLI > env > aad-bridge.env file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'aad-bridge.env'), 'SECRET=fromfile\nSUBSCRIPTION=subfile\n');
  withCwd(dir, () => {
    assert.equal(loadConfig([], {}).secret, 'fromfile');
    assert.equal(loadConfig([], { SECRET: 'fromenv' }).secret, 'fromenv');
    assert.equal(loadConfig(['--secret', 'fromcli'], { SECRET: 'fromenv' }).secret, 'fromcli');
    // file-sourced value still applies when not overridden
    assert.equal(loadConfig([], {}).subscription, 'subfile');
  });
});

test('--no-env-file ignores a co-located aad-bridge.env', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'aad-bridge.env'), 'SUBSCRIPTION=subfile\n');
  withCwd(dir, () => {
    const cfg = loadConfig(['--secret', 'x', '--no-env-file'], {});
    assert.equal(cfg.subscription, '');
    assert.equal(cfg.envFile, null);
  });
});

test('resource and subscription allowlists parse from flags', () => {
  withCwd(tmpDir(), () => {
    const cfg = loadConfig(
      ['--secret', 'x', '--allowed-resources', 'a, b', '--allowed-subscriptions', 'S1,S2', '--allow-any-resource'],
      {}
    );
    assert.deepEqual([...cfg.allowedResources].sort(), ['a', 'b']);
    assert.deepEqual([...cfg.allowedSubscriptions].sort(), ['S1', 'S2']);
    assert.equal(cfg.allowAnyResource, true);
  });
});

test('path fields expand ~ and $VAR (from env file and from real env)', () => {
  const os = require('os');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'aad-bridge.env'), 'SECRET=x\nAZURE_CONFIG_DIR=~/.azure\nAUDIT_LOG=${MYBASE}/a.log\n');
  withCwd(dir, () => {
    const cfg = loadConfig([], { MYBASE: '/var/log' });
    assert.equal(cfg.azureConfigDir, path.join(os.homedir(), '.azure'));
    assert.equal(cfg.auditLogPath, '/var/log/a.log');
  });
  // From real env (e.g. a shell-quoted literal that reached the daemon unexpanded).
  withCwd(tmpDir(), () => {
    const cfg = loadConfig([], { SECRET: 'x', AZURE_CONFIG_DIR: '$HOME/.azure', HOME: '/home/test' });
    assert.equal(cfg.azureConfigDir, '/home/test/.azure');
  });
});

test('no auth configured is fatal (exit 1)', () => {
  const dir = tmpDir(); // empty: no aad-bridge.env to satisfy auth
  const res = spawnSync(
    process.execPath,
    ['-e', `process.chdir(${JSON.stringify(dir)});require(${JSON.stringify(CONFIG_PATH)}).loadConfig([], {})`],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No caller auth configured/);
});
