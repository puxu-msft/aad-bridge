'use strict';

/**
 * Thin wrapper around `az account get-access-token`.
 * The headless server holds a single interactive `az login`; this shells out to mint scoped access tokens, letting the Azure CLI own the MSAL refresh-token lifecycle.
 */

const { execFile, spawn } = require('child_process');

const isWindows = process.platform === 'win32';

/** Error subclass that signals the daemon needs a fresh interactive `az login`. */
class ReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

// Substrings in az stderr that mean the refresh token is gone and a human must re-run device-code login on the server (conditional access, 90-day idle, MFA).
const REAUTH_MARKERS = [
  'az login',
  'AADSTS700082', // refresh token expired
  'AADSTS70043', // refresh token expired/revoked
  'AADSTS50173', // fresh auth required (password change / revocation)
  'AADSTS50078',
  'no subscription found',
  'Please run',
  'interaction_required',
];

/**
 * Quote a single argument for a cmd.exe command line.
 * Values here are Azure identifiers, resource URLs, and subscription names — a subscription *display name* can contain spaces, hence real quoting is required.
 */
function quoteForCmd(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * Resolve how to spawn the Azure CLI for the current platform.
 *
 * POSIX: run the binary directly (unchanged behavior).
 * Windows: the `az` launcher is `az.cmd`, a batch script.
 * Node refuses to spawn batch files without a shell (CVE-2024-27980 hardening), so route through cmd.exe — which also resolves bare `az` to `az.cmd` via PATHEXT — passing verbatim, self-quoted arguments so Node doesn't re-split them.
 */
function resolveAzInvocation(azPath, args) {
  if (!isWindows) return { file: azPath, args, opts: {} };
  const line = [azPath, ...args].map(quoteForCmd).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', line],
    opts: { windowsVerbatimArguments: true },
  };
}

/**
 * Mint an access token for `resource` via the Azure CLI.
 * @param {object} p
 * @param {string} p.resource      AAD resource / server app ID.
 * @param {string} [p.tenant]      tenant ID (forwarded only when config.passTenant).
 * @param {string} [p.subscription] subscription ID or name (`--subscription`).
 * @returns {Promise<{token: string, expiresOn: number, tokenType: string}>}
 *          expiresOn is absolute epoch seconds.
 */
function getAccessToken({ resource, tenant, subscription, config }) {
  const args = ['account', 'get-access-token', '--resource', resource, '--output', 'json'];
  if (tenant && config.passTenant) args.push('--tenant', tenant);
  if (subscription) args.push('--subscription', subscription);

  const azEnv = { ...process.env };
  if (config.azureConfigDir) azEnv.AZURE_CONFIG_DIR = config.azureConfigDir;

  const inv = resolveAzInvocation(config.azPath, args);

  return new Promise((resolve, reject) => {
    execFile(
      inv.file,
      inv.args,
      { timeout: config.tokenTimeoutMs, env: azEnv, maxBuffer: 4 * 1024 * 1024, ...inv.opts },
      (err, stdout, stderr) => {
        const errText = (stderr || '') + (err ? ` ${err.message}` : '');
        if (err) {
          if (REAUTH_MARKERS.some((m) => errText.toLowerCase().includes(m.toLowerCase()))) {
            return reject(new ReauthRequiredError(`az login required: ${errText.trim()}`));
          }
          return reject(new Error(`az get-access-token failed: ${errText.trim()}`));
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error(`could not parse az output: ${stdout.slice(0, 200)}`));
        }
        const token = parsed.accessToken;
        if (!token) return reject(new Error('az output had no accessToken'));
        resolve({
          token,
          expiresOn: resolveExpiry(parsed),
          tokenType: parsed.tokenType || 'Bearer',
        });
      }
    );
  });
}

/**
 * Resolve absolute expiry (epoch seconds) from az output.
 * Newer az emits a numeric `expires_on`; older builds only emit the local-time `expiresOn` string, which Date.parse reads in the host's local timezone.
 */
function resolveExpiry(parsed) {
  if (Number.isFinite(parsed.expires_on)) return Math.floor(parsed.expires_on);
  if (parsed.expiresOn) {
    const ms = Date.parse(parsed.expiresOn);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

/**
 * Run an interactive `az login` to recover from an expired/invalid refresh token.
 * On a host with a desktop this opens the default browser; pass loginUseDeviceCode for a headless host.
 * A tenant must be targeted when the identity spans multiple tenants, or login lands in the home tenant and the cluster's token stays invalid.
 * Resolves when login succeeds; rejects on non-zero exit. Output (incl. any device code) is streamed to onOutput.
 */
function startInteractiveLogin(config, { tenant, onOutput } = {}) {
  const args = ['login'];
  if (config.loginUseDeviceCode) args.push('--use-device-code');
  const t = tenant || config.loginTenant;
  if (t) args.push('--tenant', t);
  if (config.loginScope) args.push('--scope', config.loginScope);

  const azEnv = { ...process.env };
  if (config.azureConfigDir) azEnv.AZURE_CONFIG_DIR = config.azureConfigDir;

  const inv = resolveAzInvocation(config.azPath, args);
  return new Promise((resolve, reject) => {
    const cp = spawn(inv.file, inv.args, { env: azEnv, ...inv.opts });
    let buf = '';
    const cap = (d) => {
      buf += d;
      if (onOutput) onOutput(String(d));
    };
    cp.stdout.on('data', cap);
    cp.stderr.on('data', cap);
    cp.on('error', reject);
    cp.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`az login exited ${code}: ${buf.slice(-400).trim()}`))));
  });
}

module.exports = { getAccessToken, ReauthRequiredError, resolveAzInvocation, quoteForCmd, startInteractiveLogin };
