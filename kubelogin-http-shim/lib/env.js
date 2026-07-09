'use strict';

/**
 * Environment variable names, kept identical to the Go kubelogin fork so the shim honors the same env-based configuration.
 * See pkg/internal/env/variables.go in the kubelogin fork.
 */

const TOKEN_ENDPOINT = 'AAD_TOKEN_ENDPOINT';

// Client-side token cache knobs (no upstream kubelogin equivalent — the Go binary takes these as CLI flags only).
const TOKEN_CACHE_DIR = 'AAD_TOKEN_CACHE_DIR';
const DISABLE_TOKEN_CACHE = 'AAD_DISABLE_TOKEN_CACHE';
const TOKEN_CACHE_REFRESH_SKEW = 'AAD_TOKEN_CACHE_REFRESH_SKEW';

/**
 * Read an env var, returning '' when unset or empty.
 * @param {string} name
 * @returns {string}
 */
function get(name) {
  const v = process.env[name];
  return v === undefined ? '' : v;
}

/**
 * Whether an env var is present at all — distinguishes "unset" from "set to empty",
 * which `get` collapses. Lets an explicit empty value carry meaning (e.g. disabling the cache).
 * @param {string} name
 * @returns {boolean}
 */
function has(name) {
  return process.env[name] !== undefined;
}

module.exports = { TOKEN_ENDPOINT, TOKEN_CACHE_DIR, DISABLE_TOKEN_CACHE, TOKEN_CACHE_REFRESH_SKEW, get, has };
