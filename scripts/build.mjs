#!/usr/bin/env node
/**
 * scripts/build.mjs — the single build entry point.
 *
 * Three bundles, because Electron has three genuinely different execution
 * contexts and blurring them is how a preload script ends up with Node globals
 * it must not have:
 *
 *   main     CommonJS, Node platform, electron left external
 *   preload  CommonJS, Node platform, electron left external, no bundled deps
 *   renderer ESM, browser platform, NO Node access whatsoever
 *
 * After bundling it runs a freshness assertion. A builder that writes into an
 * existing output directory leaves the PREVIOUS output in place when it fails,
 * so every downstream check then validates an artifact that no longer
 * corresponds to the tree and reports green for a build that already died. The
 * assertion compares the newest source mtime against the emitted entry points.
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const SOURCE_ROOTS = [path.join(ROOT, 'app')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.css', '.html', '.json']);

function log(message) {
  process.stdout.write('[build] ' + message + '\n');
}

function fail(message) {
  process.stderr.write('[build] FAILED: ' + message + '\n');
  process.exit(1);
}

function walk(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function newestSourceMtime() {
  let newest = 0;
  let newestFile = null;
  for (const root of SOURCE_ROOTS) {
    walk(root, (file) => {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) return;
      // Test files are excluded so an ordinary test edit does not cry wolf.
      if (file.includes(path.sep + '__tests__' + path.sep)) return;
      if (file.endsWith('.test.ts')) return;
      const stat = fs.statSync(file);
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
        newestFile = file;
      }
    });
  }
  return { newest, newestFile };
}

const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

async function run() {
  fs.mkdirSync(DIST, { recursive: true });

  // Provenance is regenerated on every build so the artifact never carries a
  // stale timestamp from an earlier one.
  const provenance = spawnSync(process.execPath, [path.join(HERE, 'write-provenance.mjs')], {
    stdio: 'inherit',
  });
  if (provenance.status !== 0) fail('provenance generation exited ' + provenance.status);

  // The changelog is regenerated from `git log` on every build, for the same
  // reason: a hand-maintained one drifts from what shipped within a fortnight,
  // and the drift is invisible because every entry still looks plausible. The
  // generator refuses to write an entry whose commit does not exist, so a dead
  // link fails the build rather than reaching a reader.
  const changelog = spawnSync(process.execPath, [path.join(HERE, 'build-changelog.mjs')], {
    stdio: 'inherit',
  });
  if (changelog.status !== 0) fail('changelog generation exited ' + changelog.status);

  log('bundling main');
  await build({
    ...shared,
    entryPoints: [path.join(ROOT, 'app', 'main', 'main.ts')],
    outfile: path.join(DIST, 'main', 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  });

  log('bundling preload');
  await build({
    ...shared,
    entryPoints: [path.join(ROOT, 'app', 'preload', 'preload.ts')],
    outfile: path.join(DIST, 'preload', 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  });

  log('bundling renderer');
  await build({
    ...shared,
    entryPoints: [path.join(ROOT, 'app', 'renderer', 'index.ts')],
    outfile: path.join(DIST, 'renderer', 'renderer.js'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome128',
    loader: { '.css': 'css' },
  });

  // The regex evaluation worker, as its own entry.
  //
  // It has to be a separate bundle rather than part of the renderer: the
  // whole reason it exists is that it runs in a thread the host can
  // TERMINATE, and code inlined into the renderer runs in the thread that
  // would need terminating.
  log('bundling the regex worker');
  await build({
    ...shared,
    entryPoints: [path.join(ROOT, 'app', 'renderer', 'components', 'regex', 'evaluator-worker.ts')],
    outfile: path.join(DIST, 'renderer', 'regex-worker.js'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome128',
  });

  // Static renderer assets.
  //
  // The explicit utimes call is load-bearing, not tidiness. On Windows,
  // fs.copyFileSync goes through CopyFileW, which PRESERVES the source file's
  // last-write time. The copy therefore inherits a timestamp that can be older
  // than other sources, and the freshness assertion below then reports a
  // perfectly good build as stale. Stamping the emitted file with the time it
  // was actually emitted is what makes that assertion mean what it says.
  const rendererOut = path.join(DIST, 'renderer');
  fs.mkdirSync(rendererOut, { recursive: true });
  const htmlTarget = path.join(rendererOut, 'index.html');
  fs.copyFileSync(path.join(ROOT, 'app', 'renderer', 'index.html'), htmlTarget);
  const emittedAt = new Date();
  fs.utimesSync(htmlTarget, emittedAt, emittedAt);

  assertFresh();
  log('build complete');
}

/**
 * A failed build leaves the previous output in place. Without this, every check
 * downstream validates an artifact that no longer matches the tree.
 */
function assertFresh() {
  const emitted = [
    path.join(DIST, 'main', 'main.cjs'),
    path.join(DIST, 'preload', 'preload.cjs'),
    path.join(DIST, 'renderer', 'renderer.js'),
    path.join(DIST, 'renderer', 'regex-worker.js'),
    path.join(DIST, 'renderer', 'index.html'),
  ];
  for (const file of emitted) {
    if (!fs.existsSync(file)) fail('expected output missing: ' + path.relative(ROOT, file));
    if (fs.statSync(file).size === 0) fail('expected output is empty: ' + path.relative(ROOT, file));
  }
  const { newest, newestFile } = newestSourceMtime();
  if (!newestFile) return;
  const oldestEmitted = Math.min(...emitted.map((f) => fs.statSync(f).mtimeMs));
  if (oldestEmitted + 1000 < newest) {
    fail(
      'built output is older than its sources, so this build did not actually run.\n' +
        '  newest source: ' +
        path.relative(ROOT, newestFile) +
        '\n  Re-run: npm run build',
    );
  }
  log('freshness assertion passed');
}

run().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
