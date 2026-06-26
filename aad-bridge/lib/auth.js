'use strict';

/**
 * Caller authentication for the daemon.
 * Two independent factors, either of which can gate access (mTLS is layered when both are configured):
 *
 *   1. Shared bearer secret — matches kubelogin's `--token-endpoint-header Authorization=Bearer <secret>`.
 *   2. mTLS client cert — when TLS_CLIENT_CA is set, the TLS layer already rejected unauthenticated peers; we surface the client CN for audit.
 */

const crypto = require('crypto');

/** Timing-safe string equality that never throws on length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing ~constant, then fail
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Pull the presented token from Authorization: Bearer or X-Auth-Token. */
function presentedToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']).trim();
  return '';
}

/** Best-effort mTLS client common name, or '' for plain/anonymous connections. */
function clientCN(req) {
  const sock = req.socket;
  if (typeof sock.getPeerCertificate !== 'function') return '';
  const cert = sock.getPeerCertificate();
  return (cert && cert.subject && cert.subject.CN) || '';
}

/**
 * Decide whether a request may obtain a token.
 * @returns {{ok: boolean, reason?: string, cn: string}}
 */
function authorize(req, config) {
  const cn = clientCN(req);

  // mTLS-authenticated peers are trusted by the TLS layer (requestCert + rejectUnauthorized); a verified client cert is sufficient on its own.
  if (config.tls && config.tls.clientCA && req.socket.authorized) {
    return { ok: true, cn };
  }

  if (config.allowNoAuth) return { ok: true, cn };

  if (config.secret && safeEqual(presentedToken(req), config.secret)) {
    return { ok: true, cn };
  }
  return { ok: false, reason: 'missing or invalid credentials', cn };
}

module.exports = { authorize, safeEqual, clientCN };
