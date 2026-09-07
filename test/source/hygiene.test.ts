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

// ------------------------------------------- regex escapes in a template --

/**
 * A regex escape written with ONE backslash inside a template literal that is
 * being shipped to the page.
 *
 * JavaScript evaluates an unknown escape in a template literal by dropping the
 * backslash, so a pattern written with a single one arrives at the page with
 * the letter alone and matches nothing at all. It is not an error and nothing
 * warns: the check simply reports clean for ever. This cost a real hour here -
 * the gate said "2 items will be deleted." and the assertion insisted it did
 * not. Two backslashes are correct and are left alone.
 *
 * DELIBERATELY NARROW: only lines that hand an expression to the page. A
 * pattern in ordinary code is compiled here rather than shipped, so it is not
 * affected, and flagging it would make this cry wolf on every valid regex in
 * the tree. Positive assertions fail loudly when their needle is mangled;
 * negative ones go quiet, which is why this exists at all.
 */
export function manglesEscape(line: string): boolean {
  if (!line.includes('evaluate(') && !line.includes('waitFor(')) return false;

  const backslash = String.fromCharCode(92);
  const spans = line.split(String.fromCharCode(96));
  for (let index = 1; index < spans.length; index += 2) {
    const span = spans[index] as string;
    for (let at = 0; at < span.length - 1; at += 1) {
      if (span[at] !== backslash) continue;
      if (!'dswbDSWB'.includes(span[at + 1] as string)) continue;
      // An odd run of backslashes leaves one for the escape to eat. An even
      // run is already a literal backslash and survives intact.
      let run = 0;
      while (at - run >= 0 && span[at - run] === backslash) run += 1;
      if (run % 2 === 1) return true;
    }
  }
  return false;
}

/**
 * The same defect, spread over several lines.
 *
 * THE ONE-LINE VERSION ABOVE MISSED A REAL OCCURRENCE. A driver hands the page
 * a template literal that opens on the `evaluate(` line and closes a dozen
 * lines later, and the mangled escape sat in the middle of it - so a scan that
 * required both the call and the backslash on one line never looked. The page
 * received a character class as a bare letter, the split found nothing, and
 * three checks agreed the geometry was fine.
 */
export function manglesEscapeAcross(source: string): number[] {
  const backtick = String.fromCharCode(96);
  const backslash = String.fromCharCode(92);
  const lines = source.split(String.fromCharCode(10));
  const offenders: number[] = [];
  let open = false;

  const mangles = (line: string): boolean => {
    for (let at = 0; at < line.length - 1; at += 1) {
      if (line[at] !== backslash) continue;
      if (!'dswbDSWB'.includes(line[at + 1] as string)) continue;
      let run = 0;
      while (at - run >= 0 && line[at - run] === backslash) run += 1;
      if (run % 2 === 1) return true;
    }
    return false;
  };

  lines.forEach((line, index) => {
    const ticks = line.split(backtick).length - 1;
    const opensHere = !open && (line.includes('evaluate(') || line.includes('waitFor(')) && ticks % 2 === 1;

    if (open && mangles(line)) offenders.push(index + 1);
    if (opensHere) {
      open = true;
      return;
    }
    if (open && ticks % 2 === 1) open = false;
  });

  return offenders;
}

test('no expression sent to the page hides a mangled escape on a CONTINUATION line', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const line of manglesEscapeAcross(source)) {
      offenders.push(path.relative(ROOT, file) + ':' + line);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the multi-line escape detector was watched failing on the real occurrence', () => {
  const b = String.fromCharCode(92);
  const t = String.fromCharCode(96);
  const nl = String.fromCharCode(10);

  // Verbatim shape of the defect that got through: the call and the opening
  // backtick on one line, the mangled class four lines down.
  const bad = [
    '  await evaluate(' + t,
    '    (() => {',
    '      const raw = node.getAttribute(!points!) || !!;',
    '      return raw.trim().split(/' + b + 's+/).length;',
    '    })()',
    '  ' + t + ');',
  ].join(nl);

  const good = bad.replace('/' + b + 's+/', "' '");

  assert.deepEqual(manglesEscapeAcross(bad), [4], 'the real failure was not caught');
  assert.deepEqual(manglesEscapeAcross(good), [], 'a literal separator was flagged');
  assert.deepEqual(
    manglesEscapeAcross('const re = /' + b + 'd+ rows/;'),
    [],
    'ordinary code outside an expression was flagged',
  );
});

test('no check hides a mangled regex escape in an expression sent to the page', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
    lines.forEach((line, index) => {
      if (manglesEscape(line)) {
        offenders.push(path.relative(ROOT, file) + ':' + (index + 1) + ' ' + line.trim());
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('the escape detector was watched failing, and does not cry wolf', () => {
  const b = String.fromCharCode(92);
  const t = String.fromCharCode(96);
  const one = 'await evaluate(' + t + '/' + b + 'd+ rows/.test(x)' + t + ')';
  const two = 'await evaluate(' + t + '/' + b + b + 'd+ rows/.test(x)' + t + ')';

  assert.equal(manglesEscape(one), true, 'the real failure was not caught');
  assert.equal(manglesEscape(two), false, 'a correctly doubled escape was flagged');
  assert.equal(manglesEscape('const re = /' + b + 'd+ rows/;'), false, 'ordinary code was flagged');
  assert.equal(manglesEscape('await evaluate(' + t + 'document.title' + t + ')'), false);
});
