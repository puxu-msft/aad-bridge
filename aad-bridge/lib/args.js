'use strict';

/**
 * Minimal zero-dependency CLI flag parser.
 * Supports `--key value`, `--key=value`, and boolean `--flag`.
 * Boolean flags (no value) must be declared so a following positional isn't swallowed as their value.
 *
 * CLI flags override environment variables (see config.js), so they're handy for one-off dev/test overrides without editing the env file.
 */

function parseArgs(argv, booleanFlags = new Set()) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(body)) {
      out[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[body] = true; // lone flag, treat as boolean
    } else {
      out[body] = next;
      i++;
    }
  }
  return out;
}

module.exports = { parseArgs };
