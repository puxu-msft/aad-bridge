'use strict';

/**
 * Minimal zero-dependency loader for an `aad-bridge.env` file (systemd EnvironmentFile / dotenv style: `KEY=value`, `#` comments, optional quotes).
 *
 * It only fills in variables that are NOT already set, so the precedence stays:
 *   CLI flags  >  real environment  >  aad-bridge.env file
 *
 * This keeps the single-file bundle self-contained: drop an aad-bridge.env next to it and run, no `set -a` / `source` dance required.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * Only a leading tilde is treated specially (shell convention); `~` elsewhere is literal.
 */
function expandTilde(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Expand `$VAR` and `${VAR}` references against `env`, like a shell would.
 * Unset variables expand to an empty string. There is no escaping — a literal `$` is not supported (fine for paths).
 */
function expandVars(value, env) {
  if (!value || value.indexOf('$') === -1) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const name = braced || bare;
    return env[name] !== undefined ? env[name] : '';
  });
}

/**
 * Expand a value the way a shell would for the env file: leading `~`/`~/` to home, then `$VAR` / `${VAR}` from the environment.
 * The shell already does this for CLI flags and real env vars, but the daemon reads aad-bridge.env itself, so its values arrive literal.
 */
function expandValue(value, env = process.env) {
  return expandVars(expandTilde(value), env);
}

/**
 * Resolve the value portion of a `KEY=value` line.
 *
 * - Surrounding single/double quotes are stripped; anything after the closing quote (e.g. a trailing comment) is ignored.
 * - For unquoted values, an inline comment introduced by whitespace + `#` (or a leading `#`) is stripped — so `AUDIT_LOG=C:\logs\a.log  # note` yields `C:\logs\a.log`, not the comment text.
 * - Backslashes are preserved literally (no escape processing), so native Windows paths like `C:\path\to\file` survive intact.
 */
function parseValue(raw) {
  const s = raw.trim();
  if (!s) return '';
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end !== -1) return s.slice(1, end);
  }
  const m = s.match(/(^|\s)#/);
  return (m ? s.slice(0, m.index) : s).trim();
}

/** Parse EnvironmentFile-style text into a plain {KEY: value} object. */
function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue; // full-line comment
    if (line.startsWith('export ')) line = line.slice(7).trim(); // tolerate `export KEY=...`
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out[key] = parseValue(line.slice(eq + 1));
  }
  return out;
}

/**
 * Load `filePath` into `env`, setting only keys that are currently unset.
 * @returns {{path: string|null, loaded: string[], found: boolean}}
 */
function loadEnvFile(filePath, env = process.env) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { path: abs, loaded: [], found: false };
  const parsed = parseEnvFile(fs.readFileSync(abs, 'utf8'));
  const loaded = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      // Expand ~ and $VAR/${VAR} against the live env (process.env plus keys set earlier in this load).
      env[k] = expandValue(v, env);
      loaded.push(k);
    }
  }
  return { path: abs, loaded, found: true };
}

module.exports = { loadEnvFile, parseEnvFile, parseValue, expandValue, expandTilde, expandVars };
