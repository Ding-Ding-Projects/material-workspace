#!/usr/bin/env node
/**
 * Bundle the server to one file.
 *
 * One file with no runtime dependencies is what lets the runtime image carry a
 * Node runtime and nothing else - no node_modules to audit, nothing to
 * reinstall on a rebuild, and no chance of the image and the source disagreeing
 * about which version of something is present.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dist', 'server.mjs');

await build({
  entryPoints: [path.join(HERE, 'src', 'index.ts')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Every node: builtin stays external. Bundling one would produce a file that
  // esbuild cannot resolve and that Node would not run anyway.
  packages: 'external',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Asserted rather than assumed. A build that wrote nothing exits zero from
// esbuild's point of view when the entry point resolved to an empty module,
// and the failure then appears as a container that starts and immediately ends.
const stat = fs.statSync(OUT, { throwIfNoEntry: false });
if (stat === undefined || stat.size < 1024) {
  process.stderr.write('[server-build] the bundle is missing or implausibly small\n');
  process.exit(1);
}
process.stdout.write('[server-build] ' + OUT + ' (' + stat.size + ' bytes)\n');
