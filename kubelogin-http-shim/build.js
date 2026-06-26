#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency bundler for kubelogin-http-shim.
 *
 * Inlines bin/kubelogin-http-shim + lib/*.js into a single self-contained file by wrapping each module's source in a function and registering it under its path.
 * A tiny runtime `require` shim resolves relative requires against that registry and falls back to Node's built-ins.
 * Because we concatenate raw source (never stringify it), there is nothing to escape and the output stays readable.
 * Modeled on aad-bridge/build.js.
 *
 * Usage: node build.js            -> dist/kubelogin-http-shim.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'kubelogin-http-shim.js');
const ENTRY = 'bin/kubelogin-http-shim';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Collect module paths (relative to ROOT, posix-style) in deterministic order. */
function collectModules() {
  const libDir = path.join(ROOT, 'lib');
  const libFiles = fs
    .readdirSync(libDir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => `lib/${f}`);
  return [...libFiles, ENTRY];
}

/** Read a module's source, stripping any leading shebang line. */
function readModule(rel) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
  return src;
}

function build() {
  const modules = collectModules();

  const parts = [];
  parts.push('#!/usr/bin/env node');
  parts.push("'use strict';");
  parts.push(`// kubelogin-http-shim ${pkg.version} — bundled, do not edit. Source: kubelogin-http-shim/, rebuild: node build.js`);
  parts.push('');
  parts.push('const __nativeRequire = require;');
  parts.push("const __path = require('path');");
  parts.push('const __modules = {};');
  parts.push('const __cache = {};');
  parts.push('function __resolve(fromId, request) {');
  parts.push('  const dir = __path.posix.dirname(fromId);');
  parts.push('  const p = __path.posix.normalize(__path.posix.join(dir, request));');
  parts.push('  if (__modules[p]) return p;');
  parts.push("  if (__modules[p + '.js']) return p + '.js';");
  parts.push("  if (__modules[p + '/index.js']) return p + '/index.js';");
  parts.push('  return p;');
  parts.push('}');
  parts.push('function __makeRequire(fromId) {');
  parts.push('  return function (request) {');
  parts.push("    if (request.startsWith('.')) return __require(__resolve(fromId, request));");
  parts.push('    return __nativeRequire(request);');
  parts.push('  };');
  parts.push('}');
  parts.push('function __require(id) {');
  parts.push('  if (__cache[id]) return __cache[id].exports;');
  parts.push('  const def = __modules[id];');
  parts.push('  if (!def) return __nativeRequire(id);');
  parts.push('  const module = { exports: {} };');
  parts.push('  __cache[id] = module;');
  parts.push('  def(module, module.exports, __makeRequire(id));');
  parts.push('  return module.exports;');
  parts.push('}');
  parts.push('');

  // Synthetic package.json so bin/'s `require('../package.json')` resolves the version inside the single-file bundle (the real file isn't shipped).
  parts.push(`__modules['package.json'] = function (module) { module.exports = ${JSON.stringify({ version: pkg.version })}; };`);
  parts.push('');

  for (const rel of modules) {
    parts.push(`__modules[${JSON.stringify(rel)}] = function (module, exports, require) {`);
    parts.push(readModule(rel));
    parts.push('};');
    parts.push('');
  }

  parts.push(`__require(${JSON.stringify(ENTRY)});`);
  parts.push('');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, parts.join('\n'));
  fs.chmodSync(OUT_FILE, 0o755);

  const bytes = fs.statSync(OUT_FILE).size;
  console.log(`bundled ${modules.length} modules -> ${path.relative(ROOT, OUT_FILE)} (${(bytes / 1024).toFixed(1)} KiB)`);
  for (const m of modules) console.log(`  + ${m}`);
}

build();
