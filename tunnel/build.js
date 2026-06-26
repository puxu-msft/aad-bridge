#!/usr/bin/env node
'use strict';

/**
 * build — produce self-contained, per-side artifacts in dist/.
 *
 * `listen.js` and `connect.js` both require the shared ./framing module.
 * esbuild inlines that single source of truth into each output, so the wire protocol is guaranteed identical on both ends and each artifact is a drop-in single file:
 *
 *   dist/listen.js   -> copy into container A, `node listen.js`
 *   dist/connect.js  -> copy into container B, `node connect.js`
 *
 * No node_modules, no shared file to ship alongside.
 */

const esbuild = require('esbuild');
const path = require('path');

const outdir = path.join(__dirname, 'dist');

esbuild
  .build({
    // The entries already start with `#!/usr/bin/env node`; esbuild preserves that hashbang on line 1 of each output, so no banner is needed.
    entryPoints: [path.join(__dirname, 'listen.js'), path.join(__dirname, 'connect.js')],
    outdir,
    bundle: true, // inline ./framing into each entry
    platform: 'node',
    target: 'node16',
    format: 'cjs',
    minify: false, // keep readable; it's an ops artifact, not a web bundle
    logLevel: 'info',
  })
  .then(() => console.log('built dist/listen.js and dist/connect.js'))
  .catch((err) => {
    console.error('build failed:', err.message);
    process.exit(1);
  });
