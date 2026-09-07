/**
 * Every referenced custom property must be declared somewhere.
 *
 * WHY THIS EXISTS: the Sheets stylesheet shipped referencing SEVEN custom
 * properties that do not exist anywhere in this project — an entire invented
 * naming scheme for spacing and typography. Nothing failed. The build was
 * clean, the stylesheet was valid CSS, and eighteen checks driven against the
 * real window all passed.
 *
 * The damage was only visible in a capture: an undefined custom property makes
 * the WHOLE declaration invalid at computed-value time, so every `padding` and
 * every `font-size` in that stylesheet silently resolved to nothing. Cell A1
 * held 100 and cell B1 held 0012, and with no padding they rendered flush
 * against each other and read as one number, 1000012.
 *
 * That is the worst class of UI defect there is: no error, no warning, every
 * automated check green, and a value on screen that is simply wrong to a human
 * reading it. This catches it at the only point it is cheap — before it ships.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

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
const STYLES = path.join(ROOT, 'app', 'renderer', 'styles');

const files = fs.readdirSync(STYLES).filter((name) => name.endsWith('.css'));

const declared = new Set<string>();
const referenced = new Map<string, Set<string>>();

for (const file of files) {
  const text = fs.readFileSync(path.join(STYLES, file), 'utf8');
  for (const match of text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) {
    declared.add(match[1] as string);
  }
  // Only the first argument of var() is a name. The second is a fallback and
  // may legitimately be anything, including a literal.
  for (const match of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    const name = match[1] as string;
    if (!referenced.has(name)) referenced.set(name, new Set());
    (referenced.get(name) as Set<string>).add(file);
  }
}

test('the audit actually read the stylesheets', () => {
  // The tripwire every derived-work-list guard needs. Without it, a moved
  // directory makes both assertions below pass over nothing at all.
  assert.ok(files.length >= 4, 'expected at least four stylesheets, saw ' + files.length);
  assert.ok(declared.size > 50, 'expected more than 50 declared tokens, saw ' + declared.size);
  assert.ok(referenced.size > 20, 'expected more than 20 referenced tokens, saw ' + referenced.size);
});

test('no stylesheet references a custom property that is never declared', () => {
  const undefinedNames = [...referenced.keys()]
    .filter((name) => !declared.has(name))
    .sort()
    .map((name) => name + ' (used in ' + [...(referenced.get(name) as Set<string>)].join(', ') + ')');
  assert.deepEqual(undefinedNames, []);
});

test('a var() fallback does not count as a declaration', () => {
  // Guarding the guard. `var(--nope, 8px)` renders fine, so it is tempting to
  // treat a fallback as making the reference safe. It does not: the fallback
  // hides the missing token rather than fixing it, and the next stylesheet to
  // reference the same name without a fallback breaks silently.
  const pattern = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  const sample = 'a { padding: var(--present, 8px); margin: var(--absent); }';
  const names = [...sample.matchAll(pattern)].map((match) => match[1]);
  assert.deepEqual(names, ['--present', '--absent']);
});
