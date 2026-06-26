'use strict';

/**
 * Environment variable names, kept identical to the Go kubelogin fork so the shim honors the same env-based configuration.
 * See pkg/internal/env/variables.go in the kubelogin fork.
 */

const TOKEN_ENDPOINT = 'AAD_TOKEN_ENDPOINT';

/**
 * Read an env var, returning '' when unset or empty.
 * @param {string} name
 * @returns {string}
 */
function get(name) {
  const v = process.env[name];
  return v === undefined ? '' : v;
}

module.exports = { TOKEN_ENDPOINT, get };
