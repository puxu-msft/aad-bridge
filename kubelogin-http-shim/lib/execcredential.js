'use strict';

/**
 * Renders the kubectl ExecCredential response, mirroring the Go fork's execCredentialWriter (pkg/internal/token/execCredentialWriter.go).
 *
 * kubectl passes the requested apiVersion via the KUBERNETES_EXEC_INFO env var; the plugin must echo back a matching ExecCredential.
 * We support both client.authentication.k8s.io/v1 and .../v1beta1, defaulting to v1beta1 when the env var is absent (matching upstream behavior).
 */

const API_V1 = 'client.authentication.k8s.io/v1';
const API_V1BETA1 = 'client.authentication.k8s.io/v1beta1';
const EXEC_INFO_ENV = 'KUBERNETES_EXEC_INFO';

/**
 * Resolve the ExecCredential apiVersion from KUBERNETES_EXEC_INFO.
 * @param {string|undefined} rawEnv value of KUBERNETES_EXEC_INFO
 * @returns {string}
 */
function apiVersionFromExecInfo(rawEnv) {
  if (!rawEnv) return API_V1BETA1;
  let parsed;
  try {
    parsed = JSON.parse(rawEnv);
  } catch (err) {
    throw new Error(`cannot unmarshal ${EXEC_INFO_ENV} to ExecCredential: ${err.message}`);
  }
  const v = parsed && parsed.apiVersion;
  switch (v) {
    case undefined:
    case '':
      return API_V1BETA1;
    case API_V1:
    case API_V1BETA1:
      return v;
    default:
      throw new Error(`api version: ${v} is not supported`);
  }
}

/**
 * Build the ExecCredential object kubectl expects on stdout.
 * @param {{ token: string, expiresOn: Date }} accessToken
 * @param {string} apiVersion
 * @returns {object}
 */
function buildExecCredential(accessToken, apiVersion) {
  const status = { token: accessToken.token };
  // A zero/epoch expiry means "unknown"; omit it so kubectl does not treat the token as already expired.
  if (accessToken.expiresOn && accessToken.expiresOn.getTime() > 0) {
    status.expirationTimestamp = accessToken.expiresOn.toISOString();
  }
  return {
    kind: 'ExecCredential',
    apiVersion,
    spec: {},
    status,
  };
}

/**
 * Write the ExecCredential JSON to a stream.
 * @param {{ token: string, expiresOn: Date }} accessToken
 * @param {NodeJS.WritableStream} writer
 * @param {string|undefined} rawExecInfo value of KUBERNETES_EXEC_INFO
 */
function writeExecCredential(accessToken, writer, rawExecInfo) {
  const apiVersion = apiVersionFromExecInfo(rawExecInfo);
  const ec = buildExecCredential(accessToken, apiVersion);
  writer.write(`${JSON.stringify(ec)}\n`);
}

module.exports = {
  writeExecCredential,
  buildExecCredential,
  apiVersionFromExecInfo,
  API_V1,
  API_V1BETA1,
  EXEC_INFO_ENV,
};
