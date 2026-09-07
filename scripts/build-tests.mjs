#!/usr/bin/env node
/**
 * Bundle the TypeScript test suite so node:test can run it.
 *
 * Each test file is bundled separately with its imports resolved, so a test
 * exercises the SAME module graph the application uses rather than a
 * hand-maintained parallel copy. Node builtins and node:test stay external.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TEST_SRC = path.join(ROOT, 'test');
const TEST_OUT = path.join(ROOT, '.tmp', 'test');

function collect(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const entryPoints = collect(TEST_SRC);
if (entryPoints.length === 0) {
  process.stdout.write('[build-tests] no test files found\n');
  process.exit(0);
}

fs.rmSync(TEST_OUT, { recursive: true, force: true });

await build({
  entryPoints,
  outdir: TEST_OUT,
  outbase: TEST_SRC,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
  // electron is never imported by a test; if one ever does, this makes the
  // failure loud rather than bundling a stub that quietly answers differently.
  external: ['electron'],
  outExtension: { '.js': '.mjs' },
});

process.stdout.write('[build-tests] bundled ' + entryPoints.length + ' test files\n');
