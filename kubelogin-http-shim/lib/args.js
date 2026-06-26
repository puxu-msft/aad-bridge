'use strict';

/**
 * Zero-dependency CLI parser for kubelogin-http-shim.
 *
 * Drop-in compatible with the subset of `kubelogin get-token` flags used by the azurecli + --token-endpoint path, so an existing kubeconfig works unchanged after swapping `command: kubelogin` for this shim.
 * Flags the shim does not understand (other kubelogin login knobs) are tolerated with a warning instead of being a hard error, keeping the swap painless.
 */

const env = require('./env');

const SUPPORTED_METHODS = new Set(['GET', 'POST']);
const DEFAULT_METHOD = 'POST';

// Flags we consume that take a following value.
const VALUE_FLAGS = new Map([
  ['--login', 'login'],
  ['-l', 'login'],
  ['--server-id', 'serverID'],
  ['--tenant-id', 'tenantID'],
  ['-t', 'tenantID'],
  ['--token-endpoint', 'tokenEndpoint'],
  ['--token-endpoint-method', 'method'],
  ['--token-endpoint-ca-file', 'caFile'],
  ['--token-endpoint-cert', 'certFile'],
  ['--token-endpoint-key', 'keyFile'],
]);

// Repeatable value flags (accumulate into an array).
const ARRAY_FLAGS = new Map([
  ['--token-endpoint-header', 'headers'],
  ['--token-endpoint-header-file', 'headerFiles'],
]);

// Boolean flags we consume (no following value).
const BOOL_FLAGS = new Map([
  ['--token-endpoint-insecure-skip-tls-verify', 'insecureSkipTLSVerify'],
]);

// Known upstream kubelogin boolean flags we ignore but must NOT treat as value-taking when tolerating unknown flags (so we don't swallow the next arg).
const KNOWN_BOOL_IGNORED = new Set([
  '--pop-enabled',
  '--legacy',
  '--disable-instance-discovery',
  '--disable-environment-override',
  '--use-azurerm-env-vars',
]);

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {(msg: string) => void} [warn] sink for tolerated-unknown warnings
 * @returns {object} parsed config
 */
function parseArgs(argv, warn = (msg) => process.stderr.write(`${msg}\n`)) {
  const cfg = {
    command: null,
    login: null,
    serverID: '',
    tenantID: '',
    tokenEndpoint: env.get(env.TOKEN_ENDPOINT) || '',
    method: '',
    headers: [],
    headerFiles: [],
    caFile: '',
    certFile: '',
    keyFile: '',
    insecureSkipTLSVerify: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      cfg.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      cfg.version = true;
      continue;
    }

    // Positional subcommand (e.g. `get-token`).
    if (!arg.startsWith('-')) {
      if (cfg.command === null) {
        cfg.command = arg;
      } else {
        warn(`[shim] ignoring unexpected positional argument: ${arg}`);
      }
      continue;
    }

    // Split --flag=value form.
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ShimArgError(`flag ${name} requires a value`);
      }
      i += 1;
      return next;
    };

    if (BOOL_FLAGS.has(name)) {
      cfg[BOOL_FLAGS.get(name)] = inlineValue === null ? true : parseBool(inlineValue);
      continue;
    }
    if (ARRAY_FLAGS.has(name)) {
      cfg[ARRAY_FLAGS.get(name)].push(takeValue());
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      cfg[VALUE_FLAGS.get(name)] = takeValue();
      continue;
    }

    // Unknown flag handling.
    //
    // A mistyped flag in the --token-endpoint-* namespace is dangerous: silently dropping e.g. a misspelled --token-endpoint-ca-file would downgrade TLS to the system trust pool. Fail loudly for that namespace.
    if (name.startsWith('--token-endpoint')) {
      throw new ShimArgError(`unknown flag ${name} (mistyped a --token-endpoint-* flag?)`);
    }

    // Other unknown flags are tolerated for drop-in compatibility. Consume a following bare token as the flag's value (most kubelogin flags take one), but never when we still owe a positional subcommand — so an unknown flag can't swallow `get-token`.
    warn(`[shim] ignoring unsupported flag: ${name}`);
    if (inlineValue === null && !KNOWN_BOOL_IGNORED.has(name) && cfg.command !== null) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
    }
  }

  cfg.method = cfg.method ? cfg.method.toUpperCase() : DEFAULT_METHOD;
  return cfg;
}

/**
 * Validate a parsed config, throwing ShimArgError on the first problem.
 * @param {object} cfg
 * @returns {object} cfg (for chaining)
 */
function validateArgs(cfg) {
  if (cfg.command && cfg.command !== 'get-token') {
    throw new ShimArgError(`unsupported subcommand ${cfg.command}; only "get-token" is supported`);
  }
  if (!cfg.serverID) {
    throw new ShimArgError('--server-id is required');
  }
  if (!cfg.tokenEndpoint) {
    throw new ShimArgError(`--token-endpoint is required (or set ${env.TOKEN_ENDPOINT})`);
  }
  let url;
  try {
    url = new URL(cfg.tokenEndpoint);
  } catch {
    throw new ShimArgError(`token endpoint ${cfg.tokenEndpoint} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ShimArgError(`token endpoint ${cfg.tokenEndpoint} must use http or https scheme`);
  }
  if (!SUPPORTED_METHODS.has(cfg.method)) {
    throw new ShimArgError(`token endpoint method ${cfg.method} is not supported, use GET or POST`);
  }
  if (Boolean(cfg.certFile) !== Boolean(cfg.keyFile)) {
    throw new ShimArgError('--token-endpoint-cert and --token-endpoint-key must be used together');
  }
  for (const h of cfg.headers) {
    const idx = h.indexOf('=');
    if (idx <= 0) {
      throw new ShimArgError(`token endpoint header ${JSON.stringify(h)} is not in key=value format`);
    }
  }
  return cfg;
}

function parseBool(v) {
  return v === '' || /^(1|true|yes|on)$/i.test(v);
}

class ShimArgError extends Error {}

module.exports = { parseArgs, validateArgs, ShimArgError, DEFAULT_METHOD, SUPPORTED_METHODS };
