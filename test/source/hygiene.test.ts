/**
 * Source hygiene.
 *
 * WHY THIS EXISTS: three separate files in this repository acquired an
 * invisible control byte as a string separator — a NUL in the cell-address key,
 * a NUL in the text measurement cache key, and a unit separator in the
 * tamper-evident audit hash. Each was functionally correct and each was
 * unreadable: the byte does not render in any editor, does not show in a diff,
 * and cannot be typed back by anyone maintaining the file.
 *
 * The audit-log one was the dangerous member of the set. That separator is
 * inside a hash chain, so any tool that strips control characters — a
 * formatter, a sanitiser, a copy through a surface that normalises text —
 * would silently change every hash the log has ever written, and the failure
 * would surface as "the audit log is corrupt" long after the cause.
 *
 * They are all now written as String.fromCharCode with the reason beside them.
 * This keeps them that way.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The repository root, found by walking up for package.json.
 *
 * NOT `path.resolve(import.meta.dirname, '..', '..')`. Tests are bundled into
 * `.tmp/test/<area>/`, so at run time this file's directory is inside `.tmp`
 * and that arithmetic lands on `.tmp` rather than on the repository. The first
 * version did exactly that and swept SIX bundled files instead of the whole
 * tree — reporting clean because it never looked at the source at all.
 *
 * It was caught only by the "found files to sweep" tripwire below, which is
 * the argument for having one on any guard that derives its own work list.
 */
function findRoot(from: string): string {
  let current = from;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + from);
    current = parent;
  }
}

const ROOT = findRoot(import.meta.dirname);

const SCANNED_DIRECTORIES = ['app', 'scripts', 'test', 'site'];
const SCANNED_EXTENSIONS = ['.ts', '.mjs', '.js', '.css', '.html', '.json', '.md'];

/**
 * Tab, line feed and carriage return are ordinary text. Everything else below
 * 0x20, plus DEL, is a control byte that has no business in source.
 */
function controlBytePositions(text: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const allowed = code === 9 || code === 10 || code === 13;
    if ((code < 32 && !allowed) || code === 127) found.push(index);
  }
  return found;
}

function collect(directory: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) found.push(full);
  }
  return found;
}

const files = SCANNED_DIRECTORIES.flatMap((name) => collect(path.join(ROOT, name)));

test('the sweep actually found files to sweep', () => {
  // Without this, a wrong root or a renamed directory makes every assertion
  // below pass over an empty list — a guard that reports clean because it
  // never looked. That is the exact failure this whole file exists to prevent,
  // so it would be an unusually embarrassing one to reproduce here.
  assert.ok(files.length > 40, 'expected to scan more than 40 files, saw ' + files.length);
});

test('no source file contains an invisible control byte', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const positions = controlBytePositions(text);
    if (positions.length === 0) continue;
    const first = positions[0] as number;
    const line = text.slice(0, first).split('\n').length;
    offenders.push(
      path.relative(ROOT, file) +
        ':' +
        line +
        ' contains charCode ' +
        text.charCodeAt(first) +
        ' (' +
        positions.length +
        ' in total). Write it as String.fromCharCode with the reason beside it.',
    );
  }
  assert.deepEqual(offenders, []);
});

test('the detector recognises the exact bytes that got in before', () => {
  // Watched failing rather than assumed. These are the three real cases.
  assert.deepEqual(controlBytePositions('a' + String.fromCharCode(0) + 'b'), [1]);
  assert.deepEqual(controlBytePositions('a' + String.fromCharCode(31) + 'b'), [1]);
  assert.deepEqual(controlBytePositions('a' + String.fromCharCode(127) + 'b'), [1]);
});

test('and leaves ordinary whitespace alone', () => {
  assert.deepEqual(controlBytePositions('a\tb\nc\r\nd'), []);
});
