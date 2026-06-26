'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, validateArgs, ShimArgError } = require('../lib/args');

const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';
const EP = 'https://aad-bridge.internal:8765/token';

// Silence the tolerated-unknown warnings and capture them for assertions.
function parseQuiet(argv) {
  const warnings = [];
  const cfg = parseArgs(argv, (m) => warnings.push(m));
  return { cfg, warnings };
}

test('parses the canonical convert-kubeconfig arg vector', () => {
  const { cfg } = parseQuiet([
    'get-token',
    '--login=azurecli',
    `--server-id=${AKS}`,
    `--token-endpoint=${EP}`,
    '--token-endpoint-header=Authorization=Bearer s3cr3t',
    '--token-endpoint-ca-file=/etc/aad-bridge/ca.pem',
  ]);
  assert.equal(cfg.command, 'get-token');
  assert.equal(cfg.login, 'azurecli');
  assert.equal(cfg.serverID, AKS);
  assert.equal(cfg.tokenEndpoint, EP);
  assert.deepEqual(cfg.headers, ['Authorization=Bearer s3cr3t']);
  assert.equal(cfg.caFile, '/etc/aad-bridge/ca.pem');
  assert.equal(cfg.method, 'POST');
  assert.doesNotThrow(() => validateArgs(cfg));
});

test('supports space-separated flag values and short flags', () => {
  const { cfg } = parseQuiet([
    'get-token',
    '-l', 'azurecli',
    '--server-id', AKS,
    '-t', 'tenant-1',
    '--token-endpoint', EP,
  ]);
  assert.equal(cfg.serverID, AKS);
  assert.equal(cfg.tenantID, 'tenant-1');
  assert.equal(cfg.tokenEndpoint, EP);
});

test('accumulates repeated --token-endpoint-header flags', () => {
  const { cfg } = parseQuiet([
    'get-token', '--server-id', AKS, '--token-endpoint', EP,
    '--token-endpoint-header', 'A=1',
    '--token-endpoint-header', 'B=2',
  ]);
  assert.deepEqual(cfg.headers, ['A=1', 'B=2']);
});

test('accumulates repeated --token-endpoint-header-file flags', () => {
  const { cfg } = parseQuiet([
    'get-token', '--server-id', AKS, '--token-endpoint', EP,
    '--token-endpoint-header-file', '/etc/aad-bridge/h1',
    '--token-endpoint-header-file=/etc/aad-bridge/h2',
  ]);
  assert.deepEqual(cfg.headerFiles, ['/etc/aad-bridge/h1', '/etc/aad-bridge/h2']);
});

test('normalizes method to upper case and defaults to POST', () => {
  const { cfg: a } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP, '--token-endpoint-method', 'get']);
  assert.equal(a.method, 'GET');
  const { cfg: b } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP]);
  assert.equal(b.method, 'POST');
});

test('treats the insecure-skip flag as a boolean', () => {
  const { cfg } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP, '--token-endpoint-insecure-skip-tls-verify']);
  assert.equal(cfg.insecureSkipTLSVerify, true);
});

test('tolerates unknown flags with a warning, consuming their value', () => {
  const { cfg, warnings } = parseQuiet([
    'get-token', '--server-id', AKS, '--token-endpoint', EP,
    '--environment', 'AzurePublicCloud',   // unknown, value-taking
    '--pop-enabled',                        // known boolean, no value
    `--server-id-again=ignored`,            // unknown inline
  ]);
  assert.equal(cfg.serverID, AKS);
  assert.equal(cfg.tokenEndpoint, EP);
  assert.ok(warnings.some((w) => w.includes('--environment')));
  assert.ok(warnings.some((w) => w.includes('--pop-enabled')));
});

test('falls back to AAD_TOKEN_ENDPOINT env for the endpoint', () => {
  const prev = process.env.AAD_TOKEN_ENDPOINT;
  process.env.AAD_TOKEN_ENDPOINT = EP;
  try {
    const { cfg } = parseQuiet(['get-token', '--server-id', AKS]);
    assert.equal(cfg.tokenEndpoint, EP);
    assert.doesNotThrow(() => validateArgs(cfg));
  } finally {
    if (prev === undefined) delete process.env.AAD_TOKEN_ENDPOINT;
    else process.env.AAD_TOKEN_ENDPOINT = prev;
  }
});

test('a mistyped --token-endpoint-* flag is fatal, not silently dropped', () => {
  // Guards against silently downgrading TLS when --token-endpoint-ca-file is misspelled.
  assert.throws(
    () => parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP, '--token-endpoint-ca-fil', '/etc/ca.pem']),
    ShimArgError,
  );
});

test('an unknown flag never swallows the get-token subcommand', () => {
  const { cfg } = parseQuiet(['--unknown', 'get-token', '--server-id', AKS, '--token-endpoint', EP]);
  assert.equal(cfg.command, 'get-token');
  assert.equal(cfg.serverID, AKS);
});

test('validateArgs requires server-id', () => {
  const { cfg } = parseQuiet(['get-token', '--token-endpoint', EP]);
  assert.throws(() => validateArgs(cfg), ShimArgError);
});

test('validateArgs requires a token endpoint', () => {
  const prev = process.env.AAD_TOKEN_ENDPOINT;
  delete process.env.AAD_TOKEN_ENDPOINT;
  try {
    const { cfg } = parseQuiet(['get-token', '--server-id', AKS]);
    assert.throws(() => validateArgs(cfg), ShimArgError);
  } finally {
    if (prev !== undefined) process.env.AAD_TOKEN_ENDPOINT = prev;
  }
});

test('validateArgs rejects a non-http(s) endpoint and bad method', () => {
  const { cfg: a } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', 'ftp://x/y']);
  assert.throws(() => validateArgs(a), ShimArgError);
  const { cfg: b } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP, '--token-endpoint-method', 'PUT']);
  assert.throws(() => validateArgs(b), ShimArgError);
});

test('validateArgs rejects an unsupported subcommand', () => {
  const { cfg } = parseQuiet(['convert-kubeconfig', '--server-id', AKS, '--token-endpoint', EP]);
  assert.throws(() => validateArgs(cfg), ShimArgError);
});

test('validateArgs requires cert and key together', () => {
  const { cfg } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP, '--token-endpoint-cert', '/c.pem']);
  assert.throws(() => validateArgs(cfg), ShimArgError);
});

test('validateArgs rejects a malformed header', () => {
  const { cfg } = parseQuiet(['get-token', '--server-id', AKS, '--token-endpoint', EP, '--token-endpoint-header', 'noequals']);
  assert.throws(() => validateArgs(cfg), ShimArgError);
});
