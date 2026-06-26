'use strict';

/**
 * Parse the token request kubelogin sends.
 * The forked kubelogin's HTTPTokenCredential encodes {scope, tenantId, serverId} as a JSON body for POST or as query parameters for GET.
 * We accept either, derive the AAD resource (server app ID), and enforce the resource allowlist.
 */

const { URL } = require('url');

const DEFAULT_SCOPE_SUFFIX = '/.default';
const MAX_BODY_BYTES = 64 * 1024;

/** serverId is the resource; fall back to deriving it from the scope. */
function resourceFromFields({ scope, serverId }) {
  if (serverId && serverId.trim()) return serverId.trim();
  if (scope && scope.trim()) {
    let s = scope.trim().split(/\s+/)[0]; // first scope if space-joined
    if (s.endsWith(DEFAULT_SCOPE_SUFFIX)) s = s.slice(0, -DEFAULT_SCOPE_SUFFIX.length);
    return s.replace(/\/$/, '');
  }
  return '';
}

/** Read a length-bounded request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Extract {scope, tenantId, serverId, resource} from a GET or POST request.
 * @returns {Promise<{scope, tenant, serverId, resource}>}
 */
async function parseTokenRequest(req) {
  let fields = {};
  if (req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    fields = {
      scope: u.searchParams.get('scope') || '',
      tenantId: u.searchParams.get('tenantId') || '',
      serverId: u.searchParams.get('serverId') || '',
      subscription: u.searchParams.get('subscription') || '',
    };
  } else {
    const raw = await readBody(req);
    if (raw.trim()) {
      try {
        fields = JSON.parse(raw);
      } catch {
        throw new Error('invalid JSON body');
      }
    }
  }
  const resource = resourceFromFields({ scope: fields.scope, serverId: fields.serverId });
  return {
    scope: fields.scope || '',
    tenant: fields.tenantId || '',
    serverId: fields.serverId || '',
    subscription: fields.subscription || '',
    resource,
  };
}

module.exports = { parseTokenRequest, resourceFromFields };
