'use strict';

/**
 * Structured audit logging.
 * With a single shared Azure identity, Azure-side logs cannot tell developers apart — this local log is the only per-caller record of who obtained which token, so treat it as a security log (retain & protect).
 */

const fs = require('fs');

function createAudit(config) {
  let stream = null;
  if (config.auditLogPath) {
    // A bad path (missing parent dir, bad drive, permissions) must not crash the daemon: warn and fall back to stdout so token issuance keeps working.
    const fallback = (err) => {
      console.error(`[audit] cannot write audit log ${config.auditLogPath}: ${err.message}; falling back to stdout`);
      stream = null;
    };
    try {
      stream = fs.createWriteStream(config.auditLogPath, { flags: 'a' });
      stream.on('error', fallback); // open/write errors surface asynchronously
    } catch (err) {
      fallback(err);
    }
  }

  function emit(record) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    if (stream) stream.write(line + '\n');
    else console.log(line);
  }

  return {
    /** A token was issued (or denied) to a caller. */
    token({ ip, cn, resource, tenant, result, detail }) {
      emit({ event: 'token', ip, cn: cn || undefined, resource, tenant: tenant || undefined, result, detail });
    },
    /** Background keepalive / lifecycle event. */
    lifecycle({ event, detail }) {
      emit({ event, detail });
    },
    /** Flush and close the log stream (called on graceful shutdown). Resolves once the file write is durable. */
    close() {
      return new Promise((resolve) => {
        if (!stream) return resolve();
        stream.end(resolve); // resolves on the stream's 'finish' event
      });
    },
  };
}

module.exports = { createAudit };
