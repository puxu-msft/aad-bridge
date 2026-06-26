'use strict';

/**
 * Configuration for the aad-bridge daemon.
 *
 * Sources, highest precedence first:
 *   1. CLI flags   (e.g. --secret, --insecure-no-auth, --tls-cert)
 *   2. environment variables
 *   3. built-in defaults
 *
 * The daemon performs a single `az login` on a headless server and exposes short-lived AAD access tokens over HTTP(S) to internal machines.
 * The forked kubelogin's `azurecli` login method talks to it via `--token-endpoint`.
 */

const fs = require('fs');
const { parseArgs } = require('./args');
const { loadEnvFile, expandValue } = require('./envfile');

// Daemon version, surfaced on /healthz and /debug. Read from package.json when available (raw checkout); the bundle falls back to this literal.
let VERSION = '0.1.0';
try {
  VERSION = require('../package.json').version;
} catch {
  /* bundled: package.json not resolvable, keep the literal */
}

// Well-known AAD server application ID for managed-AAD AKS clusters.
// This is the audience kubelogin requests by default (`--server-id`), so it is the only resource the daemon needs to mint for a kubectl-only deployment.
const AKS_AAD_SERVER_APP_ID = '6dae42f8-4368-4678-94ff-3960e28e3630';

// Auto-loaded from the current directory when present (override with --env-file).
const DEFAULT_ENV_FILE = 'aad-bridge.env';

// Boolean CLI flags (take no value).
const BOOLEAN_FLAGS = new Set(['insecure-no-auth', 'allow-any-resource', 'pass-tenant', 'no-env-file', 'no-access-log', 'help']);

const HELP = `aad-bridged — centralized AAD token broker

Usage: node server.js [flags]   (every flag also has an env var; flags win)

  Listener
    --port <n>                 (PORT, default 8765)
    --host <addr>              (HOST, default 0.0.0.0)

  Caller auth
    --secret <token>           (SECRET) shared bearer secret
    --insecure-no-auth         (ALLOW_NO_AUTH) DEV ONLY: disable caller auth
    --tls-cert <path>          (TLS_CERT) enable HTTPS with a custom certificate
    --tls-key <path>           (TLS_KEY)
    --tls-client-ca <path>     (TLS_CLIENT_CA) enable mTLS (per-machine client certs)

  Scope protection
    --allowed-resources <csv>  (ALLOWED_RESOURCES) AAD server app IDs / resource URLs
    --allow-any-resource       (ALLOW_ANY_RESOURCE) DEV ONLY: skip the resource allowlist
    --subscription <id|name>   (SUBSCRIPTION) subscription passed to az for every mint
    --allowed-subscriptions <csv> (ALLOWED_SUBSCRIPTIONS) restrict effective subscription

  Azure CLI
    --az-path <path>           (AZ_PATH, default "az")
    --azure-config-dir <path>  (AZURE_CONFIG_DIR) where the daemon's az login lives
    --pass-tenant              (AZ_PASS_TENANT) forward request tenantId to az

  Caching / lifecycle
    --refresh-skew-seconds <n> (REFRESH_SKEW_SECONDS, default 300)
    --keepalive-minutes <n>    (KEEPALIVE_MINUTES, default 360, 0=off)
    --cache-max-entries <n>    (CACHE_MAX_ENTRIES, default 256, 0=unbounded)
    --token-timeout-ms <n>     (TOKEN_TIMEOUT_MS, default 60000)
    --audit-log <path>         (AUDIT_LOG) default: stdout
    --no-access-log            (ACCESS_LOG=0) disable per-request access logging (on by default)
    --env-file <path>          load KEY=value file (default ./aad-bridge.env if present)
    --no-env-file              do not auto-load ./aad-bridge.env
    --help
`;

function parseBool(raw, fallback) {
  if (raw === undefined) return fallback;
  if (raw === true) return true;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function parseNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a comma/whitespace separated list into a trimmed, de-duped array. */
function parseList(raw, fallback) {
  if (raw === undefined || raw === null || !String(raw).trim()) return fallback;
  return [...new Set(String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const cli = parseArgs(argv, BOOLEAN_FLAGS);

  if (cli.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Auto-load aad-bridge.env (or --env-file) into `env`, filling only unset keys so precedence stays: CLI flags > real environment > env file.
  let envFileInfo = null;
  if (!cli['no-env-file']) {
    const explicit = cli['env-file'];
    const target = explicit || DEFAULT_ENV_FILE;
    const res = loadEnvFile(expandValue(target, env), env);
    if (explicit && !res.found) {
      console.error(`FATAL: --env-file not found: ${res.path}`);
      process.exit(1);
    }
    if (res.found) envFileInfo = res;
  }

  // pick(cliKey, envKey): CLI flag wins, then env, then undefined.
  const pick = (cliKey, envKey) => {
    if (cli[cliKey] !== undefined) return cli[cliKey];
    if (envKey && env[envKey] !== undefined) return env[envKey];
    return undefined;
  };

  const tlsCert = expandValue(pick('tls-cert', 'TLS_CERT') || '', env);
  const tlsKey = expandValue(pick('tls-key', 'TLS_KEY') || '', env);
  const tlsClientCA = expandValue(pick('tls-client-ca', 'TLS_CLIENT_CA') || '', env);
  const allowNoAuth = parseBool(pick('insecure-no-auth', 'ALLOW_NO_AUTH'), false);
  const secret = pick('secret', 'SECRET') || '';

  const errors = [];
  if (!secret && !allowNoAuth && !tlsClientCA) {
    errors.push(
      'No caller auth configured. Set --secret/SECRET, or --tls-client-ca for mTLS, or --insecure-no-auth for DEV ONLY. The daemon hands out AAD tokens; it must authenticate callers.'
    );
  }
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    errors.push('TLS cert and key must be set together (--tls-cert/--tls-key).');
  }
  for (const [name, p] of [['tls-cert', tlsCert], ['tls-key', tlsKey], ['tls-client-ca', tlsClientCA]]) {
    if (p && !fs.existsSync(p)) errors.push(`--${name} file does not exist: ${p}`);
  }
  if (tlsClientCA && !tlsCert) {
    errors.push('mTLS (--tls-client-ca) requires HTTPS (--tls-cert/--tls-key).');
  }
  if (errors.length) {
    for (const e of errors) console.error(`FATAL: ${e}`);
    console.error('\nRun with --help for usage.');
    process.exit(1);
  }

  return Object.freeze({
    port: parseNumber(pick('port', 'PORT'), 8765),
    host: pick('host', 'HOST') || '0.0.0.0',
    secret,
    allowNoAuth,
    allowedResources: new Set(parseList(pick('allowed-resources', 'ALLOWED_RESOURCES'), [AKS_AAD_SERVER_APP_ID])),
    allowAnyResource: parseBool(pick('allow-any-resource', 'ALLOW_ANY_RESOURCE'), false),
    subscription: pick('subscription', 'SUBSCRIPTION') || '',
    allowedSubscriptions: new Set(parseList(pick('allowed-subscriptions', 'ALLOWED_SUBSCRIPTIONS'), [])),
    tls: tlsCert ? Object.freeze({ cert: tlsCert, key: tlsKey, clientCA: tlsClientCA || '' }) : null,
    azPath: expandValue(pick('az-path', 'AZ_PATH') || 'az', env),
    azureConfigDir: expandValue(pick('azure-config-dir', 'AZURE_CONFIG_DIR') || '', env),
    passTenant: parseBool(pick('pass-tenant', 'AZ_PASS_TENANT'), false),
    tokenTimeoutMs: parseNumber(pick('token-timeout-ms', 'TOKEN_TIMEOUT_MS'), 60_000),
    refreshSkewSeconds: parseNumber(pick('refresh-skew-seconds', 'REFRESH_SKEW_SECONDS'), 300),
    keepaliveMinutes: parseNumber(pick('keepalive-minutes', 'KEEPALIVE_MINUTES'), 360),
    cacheMaxEntries: parseNumber(pick('cache-max-entries', 'CACHE_MAX_ENTRIES'), 256),
    auditLogPath: expandValue(pick('audit-log', 'AUDIT_LOG') || '', env),
    accessLog: !cli['no-access-log'] && parseBool(pick(undefined, 'ACCESS_LOG'), true),
    version: VERSION,
    envFile: envFileInfo ? envFileInfo.path : null,
    envFileVars: envFileInfo ? envFileInfo.loaded : [],
  });
}

module.exports = { loadConfig, AKS_AAD_SERVER_APP_ID };
