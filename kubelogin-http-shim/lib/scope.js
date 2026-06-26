'use strict';

/**
 * Scope derivation, mirroring kubelogin's token.GetScope.
 *
 * kubelogin turns the AAD server application ID (--server-id) into an OAuth2 scope by appending "/.default".
 * Trailing slashes are trimmed first, and an already-suffixed value is left alone.
 * See the upstream Go implementation at pkg/internal/token/execCredentialPlugin.go:GetScope.
 */

const DEFAULT_SCOPE_SUFFIX = '/.default';

/**
 * @param {string} serverID AAD server application ID (or a full scope).
 * @returns {string} The OAuth2 scope, e.g. "<app-id>/.default".
 */
function getScope(serverID) {
  const trimmed = String(serverID).replace(/\/+$/, '');
  if (trimmed.endsWith(DEFAULT_SCOPE_SUFFIX)) return trimmed;
  return trimmed + DEFAULT_SCOPE_SUFFIX;
}

/**
 * Recover the bare serverId from a scope by stripping the "/.default" suffix, matching the request the Go HTTPTokenCredential sends to the endpoint.
 *
 * @param {string} scope
 * @returns {string}
 */
function serverIDFromScope(scope) {
  const s = String(scope);
  const bare = s.endsWith(DEFAULT_SCOPE_SUFFIX) ? s.slice(0, -DEFAULT_SCOPE_SUFFIX.length) : s;
  return bare.replace(/\/+$/, '');
}

module.exports = { getScope, serverIDFromScope, DEFAULT_SCOPE_SUFFIX };
