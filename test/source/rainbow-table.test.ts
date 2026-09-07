/**
 * The rainbow speed table exists twice, so it is checked.
 *
 * `tokens.css` turns `data-rainbow-speed` into a duration for the animation;
 * `rainbow.ts` answers the same question for anything computed in TypeScript,
 * including the readout under the slider. Both are read, so they must agree.
 *
 * They did not. The TypeScript table was invented independently and disagreed
 * on EVERY level, so the readout would have said one thing while the animation
 * did another, with nothing anywhere reporting it. That is the whole reason
 * this file exists: a value declared in two places is decided by whichever one
 * a given reader happens to consult, and nothing in a normal toolchain
 * notices the two disagreeing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { SPEED_LEVELS, durationFor } from '../../app/renderer/colour/rainbow';

const ROOT = process.cwd();
const TOKENS = path.join(ROOT, 'app', 'renderer', 'styles', 'tokens.css');

/**
 * Read the stylesheet's own table.
 *
 * Line-anchored rather than a bare substring: a commented-out declaration
 * still contains the text, so a substring match would happily read a rule that
 * no longer applies to anything.
 */
function stylesheetTable(): Map<number, number> {
  const css = fs.readFileSync(TOKENS, 'utf8').replace(/\r\n/g, '\n');
  const table = new Map<number, number>();

  // Comments stripped first, so a documented example inside one cannot be
  // mistaken for a live declaration.
  const live = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const pattern =
    /:root\[data-rainbow-speed='(\d)'\]\s*\{[^{}]*?--workspace-rainbow-duration:\s*([\d.]+)s\s*;/g;
  for (const match of live.matchAll(pattern)) {
    table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

test('the stylesheet really does declare a table, so this guard has something to check', () => {
  // Without this, a renamed selector would empty the table and every
  // comparison below would pass vacuously - a guard that reports clean
  // precisely because it stopped looking.
  const table = stylesheetTable();
  assert.equal(
    table.size,
    SPEED_LEVELS.length,
    'read ' + table.size + ' durations from tokens.css, expected ' + SPEED_LEVELS.length,
  );
});

test('every speed level means the same duration in TypeScript and in CSS', () => {
  const table = stylesheetTable();
  for (const level of SPEED_LEVELS) {
    assert.equal(
      table.get(level),
      durationFor(level),
      'level ' + level + ': CSS says ' + table.get(level) + 's, TypeScript says ' + durationFor(level) + 's',
    );
  }
});

test('the stylesheet table is ordered the way Speed implies', () => {
  // Asserted against the stylesheet directly rather than only against the
  // TypeScript, so an edit to the CSS alone still has to keep the ordering.
  const table = stylesheetTable();
  for (let index = 1; index < SPEED_LEVELS.length; index += 1) {
    const slower = table.get(SPEED_LEVELS[index - 1] as number) as number;
    const faster = table.get(SPEED_LEVELS[index] as number) as number;
    assert.ok(faster < slower, 'level ' + SPEED_LEVELS[index] + ' is not faster in the stylesheet');
  }
});

test('the still colour is a real token rather than only a fallback', () => {
  // A value that exists only inside `var(--x, fallback)` calls is a value
  // nobody can change in one place, and the guard for undeclared properties
  // would report it as missing.
  const css = fs.readFileSync(TOKENS, 'utf8').replace(/\r\n/g, '\n');
  const live = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    live,
    /^\s*--workspace-rainbow-still:\s*#[0-9a-f]{3,8}\s*;/m,
    'tokens.css does not declare --workspace-rainbow-still',
  );
});
