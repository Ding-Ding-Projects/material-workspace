#!/usr/bin/env node
/**
 * Build the TypeScript suite and run it, refusing to report success on a run
 * that executed nothing.
 *
 * WHY THIS EXISTS, in full, because the failure it guards is invisible:
 *
 *   `npm test` was `node --test test/**''/*.test.mjs`. The tests are TypeScript
 *   and are bundled into `.tmp/test`, so that pattern matched NOTHING. Node
 *   reported `tests 0 / fail 0` and exited 0 — a clean green run of an empty
 *   set. Every `npm test` in this repository up to that point proved exactly
 *   nothing, and read as proof.
 *
 *   A zero-test run is a FAILURE. So is a run whose count collapses because a
 *   whole file stopped loading — an unterminated literal or a bad import makes
 *   a file fail to parse, and node:test reports the surviving files' totals
 *   without the missing one. That reads as a smaller green run.
 *
 * So this runner asserts three things the bare command cannot:
 *   1. at least one test executed;
 *   2. every bundled file actually contributed tests;
 *   3. the total did not fall below the recorded floor.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '.tmp', 'test');

// The floor is deliberately a real number rather than 1. A single surviving
// test file would satisfy "more than zero" while the rest of the suite had
// silently stopped loading.
const FLOOR = Number(process.env.MATERIAL_WORKSPACE_TEST_FLOOR ?? '655');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    // Deliberately no shell. process.execPath is 'C:\Program Files\nodejs\node.exe'
    // on a default Windows install, and a shell splits it at the space:
    // 'C:\Program' is not recognized as an internal or external command.
    // Spawning the executable directly needs no shell and no quoting.
  });
  return result;
}

const built = run(process.execPath, ['scripts/build-tests.mjs']);
process.stdout.write(built.stdout ?? '');
process.stderr.write(built.stderr ?? '');
if (built.status !== 0) {
  process.stderr.write('[test] the suite failed to BUILD; nothing was run\n');
  process.exit(1);
}

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
    else if (entry.name.endsWith('.test.mjs')) found.push(full);
  }
  return found;
}

const files = collect(OUT);
if (files.length === 0) {
  process.stderr.write('[test] no bundled test files under ' + OUT + '\n');
  process.exit(1);
}

// Run each file separately. One file that fails to load then reports its own
// non-zero exit instead of quietly dropping out of a combined total.
let total = 0;
let failed = 0;
const empty = [];

for (const file of files) {
  const relative = path.relative(ROOT, file);
  const result = run(process.execPath, ['--test', file]);
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const match = /^\u2139 tests (\d+)$/m.exec(output);
  const count = match ? Number(match[1]) : 0;
  total += count;
  if (count === 0) empty.push(relative);
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(output);
    process.stderr.write('[test] FAILED ' + relative + '\n');
  } else {
    process.stdout.write('[test] ' + String(count).padStart(3) + '  ' + relative + '\n');
  }
}

process.stdout.write('[test] ' + total + ' tests across ' + files.length + ' files\n');

if (empty.length > 0) {
  process.stderr.write(
    '[test] these files ran NO tests, which means they did not load:\n  ' +
      empty.join('\n  ') +
      '\n',
  );
  process.exit(1);
}
if (total < FLOOR) {
  process.stderr.write(
    '[test] only ' +
      total +
      ' tests ran, below the recorded floor of ' +
      FLOOR +
      '. Either a file stopped loading, or the floor needs raising in the same\n' +
      '       commit that legitimately removes tests.\n',
  );
  process.exit(1);
}
if (failed > 0) {
  process.stderr.write('[test] ' + failed + ' file(s) failed\n');
  process.exit(1);
}
