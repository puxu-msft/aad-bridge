#!/usr/bin/env node
'use strict';

/**
 * aad-bridged — a centralized AAD token broker.
 *
 * A headless server runs a single `az login`.
 * This daemon exposes short-lived AAD access tokens over HTTP(S) so internal machines never log in themselves.
 * The forked kubelogin's `azurecli` login method consumes it via:
 *
 *   kubelogin ... --login azurecli \
 *     --token-endpoint https://aad-bridge.internal:8765/token \
 *     --token-endpoint-header "Authorization=Bearer $SECRET" \
 *     --token-endpoint-ca-file /etc/aad-bridge/ca.pem
 *
 * The daemon holds the refresh token; only minutes-lived access tokens for allowlisted resources ever cross the wire.
 *
 * This file is the thin entry point: load config, build the app, listen, and wire signals.
 * All request handling lives in lib/app.js (importable and unit-tested in-process).
 */

const { loadConfig } = require('./lib/config');
const { createApp } = require('./lib/app');

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  printBanner();
  app.startKeepalive();
});

let shuttingDown = false;
function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — draining in-flight requests...`);
  app.shutdown().then(() => process.exit(0));
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

function authModeLabel() {
  const modes = [];
  if (config.tls && config.tls.clientCA) modes.push('mTLS');
  if (config.secret) modes.push('bearer');
  if (config.allowNoAuth) modes.push('NONE (ALLOW_NO_AUTH)');
  return modes.join('+') || 'NONE';
}

function printBanner() {
  const scheme = config.tls ? 'https' : 'http';
  console.log(`aad-bridged ${config.version} listening`);
  console.log(`  endpoint   : ${scheme}://${config.host}:${config.port}/token`);
  console.log(`  endpoints  : /token  /healthz  /debug`);
  if (config.envFile) {
    console.log(`  env file   : ${config.envFile} (${config.envFileVars.length} var${config.envFileVars.length === 1 ? '' : 's'} loaded)`);
  }
  console.log(`  resources  : ${config.allowAnyResource ? 'ANY (allowlist disabled)' : [...config.allowedResources].join(', ')}`);
  console.log(`  subscription : ${config.subscription || '(az default)'}${config.allowedSubscriptions.size ? ` (allowlist: ${[...config.allowedSubscriptions].join(', ')})` : ''}`);
  console.log(`  auth       : ${authModeLabel()}`);
  console.log(`  az config  : ${config.azureConfigDir || '(default ~/.azure)'}`);
  console.log(`  keepalive  : ${config.keepaliveMinutes ? config.keepaliveMinutes + 'm' : 'off'}`);
  console.log(`  access log : ${config.accessLog ? 'on' : 'off'}`);
  if (!config.tls) {
    console.warn('  WARNING: serving plain HTTP — tokens cross the wire unencrypted. Use TLS or a trusted reverse proxy.');
  }
  if (config.allowNoAuth) {
    console.warn('  WARNING: caller auth DISABLED (--insecure-no-auth). DEV/TEST ONLY — never on a shared network.');
  }
  if (config.allowAnyResource) {
    console.warn('  WARNING: resource allowlist DISABLED (--allow-any-resource). DEV/TEST ONLY.');
  }
}
