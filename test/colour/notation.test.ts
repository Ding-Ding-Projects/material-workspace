/**
 * Notation: reading and writing colours.
 *
 * The translator's whole value is that a colour written one way and read back
 * another is the SAME colour, so that property is tested across every notation
 * rather than on a favourite one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Rgb, toHex } from '../../app/renderer/colour/convert';
import {
  NAMED,
  NON_CSS,
  NOTATIONS,
  format,
  nameFor,
  parseAny,
  translate,
} from '../../app/renderer/colour/notation';

const rgb = (r: number, g: number, b: number, alpha = 1): Rgb => ({ r, g, b, alpha });

// ------------------------------------------------------------ round trip --

test('every notation that can be parsed round-trips the colour', () => {
  const samples = [rgb(255, 0, 0), rgb(18, 52, 86), rgb(0, 128, 64), rgb(240, 230, 210)];

  for (const sample of samples) {
    for (const notation of NOTATIONS) {
      // `named` has no general inverse: most colours have no name, and the
      // formatter says so rather than snapping to the nearest one.
      if (notation === 'named') continue;

      const written = format(sample, notation);
      const read = parseAny(written);
      assert.ok(read !== null, notation + ' produced unparseable text: ' + written);

      // A degree of tolerance per channel: several of these spaces round-trip
      // through 8-bit RGB, which is lossy by definition.
      for (const channel of ['r', 'g', 'b'] as const) {
        assert.ok(
          Math.abs((read as Rgb)[channel] - sample[channel]) <= 1,
          notation + ' moved ' + channel + ': ' + written + ' -> ' + JSON.stringify(read),
        );
      }
    }
  }
});

test('alpha survives every notation that carries it', () => {
  // A picker that loses transparency when somebody switches notation has
  // destroyed information they cannot get back by switching back.
  //
  // The excluded ones do not carry alpha BY DESIGN, which is why the exclusion
  // is a named list rather than a filter: `rgb` has no alpha because `rgba`
  // is the form that does, `hex` has none because `hex8` does, and `named` and
  // `cmyk` have no alpha form at all. Listing them means adding a notation
  // that silently loses alpha cannot pass by being quietly filtered out.
  const OPAQUE_BY_DESIGN = new Set(['named', 'hex', 'rgb', 'hsl', 'cmyk']);
  const translucent = rgb(120, 60, 200, 0.4);

  for (const notation of NOTATIONS) {
    if (OPAQUE_BY_DESIGN.has(notation)) continue;
    const written = format(translucent, notation);
    const read = parseAny(written);
    assert.ok(read !== null, notation + ' did not parse: ' + written);
    assert.ok(
      Math.abs((read as Rgb).alpha - 0.4) < 0.01,
      notation + ' lost alpha: ' + written,
    );
  }

  // And the opaque-by-design ones really are: each drops it rather than
  // writing something that looks like alpha and is not.
  for (const notation of OPAQUE_BY_DESIGN) {
    const written = format(translucent, notation as (typeof NOTATIONS)[number]);
    assert.ok(!written.includes('/'), notation + ' wrote an alpha it cannot carry');
  }
});

// ----------------------------------------------------------------- names --

test('a named colour is reported only on an exact match', () => {
  // Snapping to the nearest name would report a name for a colour that is not
  // that colour.
  assert.equal(nameFor(rgb(255, 0, 0)), 'red');
  assert.equal(nameFor(rgb(102, 51, 153)), 'rebeccapurple');
  assert.equal(nameFor(rgb(255, 0, 1)), null);
  assert.equal(format(rgb(255, 0, 1), 'named'), 'no exact name');
});

test('a translucent colour has no name', () => {
  // `red` at 50% is not `red`, and reporting it as such loses the alpha the
  // moment somebody copies it.
  assert.equal(nameFor(rgb(255, 0, 0, 0.5)), null);
});

test('the name reported for a shared hex is deterministic', () => {
  // aqua and cyan are the same colour. Which one is reported does not matter;
  // that it is the SAME one every run does, or the reported name changes
  // between runs for no reason a reader can see.
  assert.equal(nameFor(rgb(0, 255, 255)), nameFor(rgb(0, 255, 255)));
  assert.equal(nameFor(rgb(0, 255, 255)), 'aqua');
});

test('every named colour parses back to itself', () => {
  for (const [name, hex] of Object.entries(NAMED)) {
    const parsed = parseAny(name);
    assert.ok(parsed !== null, name + ' did not parse');
    assert.equal(toHex(parsed as Rgb), hex, name + ' resolved to the wrong hex');
  }
});

test('the list is the complete CSS set rather than a curated subset', () => {
  // A translator that shows "no exact name" for rebeccapurple is one somebody
  // stops trusting.
  assert.ok(Object.keys(NAMED).length >= 145, 'only ' + Object.keys(NAMED).length + ' names');
  for (const required of ['rebeccapurple', 'darkslategrey', 'lightgoldenrodyellow', 'chartreuse']) {
    assert.ok(required in NAMED, required + ' is missing');
  }
});

// ---------------------------------------------------------------- parse --

test('the forms people actually paste are accepted', () => {
  assert.deepEqual(parseAny('#ff0000'), rgb(255, 0, 0));
  assert.deepEqual(parseAny('FF0000'), rgb(255, 0, 0), 'a bare hex was refused');
  assert.deepEqual(parseAny('  #F00  '), rgb(255, 0, 0));
  assert.deepEqual(parseAny('RED'), rgb(255, 0, 0));
  assert.deepEqual(parseAny('rgb(255, 0, 0)'), rgb(255, 0, 0), 'the comma form was refused');
  assert.deepEqual(parseAny('rgb(255 0 0)'), rgb(255, 0, 0));
});

test('legacy rgba with alpha in the fourth slot is understood', () => {
  const parsed = parseAny('rgba(255, 0, 0, 0.5)');
  assert.equal(parsed?.r, 255);
  assert.equal(parsed?.alpha, 0.5);
});

test('a percentage alpha is understood as a percentage', () => {
  assert.equal(parseAny('rgb(255 0 0 / 50%)')?.alpha, 0.5);
  assert.equal(parseAny('rgb(255 0 0 / 0.5)')?.alpha, 0.5);
});

test('transparent is a colour, and it keeps its zero alpha', () => {
  assert.deepEqual(parseAny('transparent'), rgb(0, 0, 0, 0));
});

test('unparseable input is refused rather than guessed at', () => {
  // A picker that silently interprets nonsense as black has replaced
  // somebody's colour with a different one and told them it worked.
  for (const bad of ['', '   ', 'not a colour', 'rgb(', 'rgb()', 'rgb(a b c)', 'xyz(1 2 3)', '#12345']) {
    assert.equal(parseAny(bad), null, 'accepted ' + JSON.stringify(bad));
  }
});

test('an out-of-range channel is clamped rather than wrapping', () => {
  // Wrapping would turn 300 into 44, which is a completely different colour
  // presented without comment.
  assert.equal(parseAny('rgb(300 -20 0)')?.r, 255);
  assert.equal(parseAny('rgb(300 -20 0)')?.g, 0);
  assert.equal(parseAny('rgb(255 0 0 / 4)')?.alpha, 1);
});

// ----------------------------------------------------------- translator --

test('the translator offers every notation and marks the non-CSS ones', () => {
  const rows = translate(rgb(18, 52, 86));
  assert.equal(rows.length, NOTATIONS.length);

  const nonCss = rows.filter((row) => !row.css).map((row) => row.notation);
  assert.deepEqual(nonCss.sort(), [...NON_CSS].sort());
  // Both of those genuinely have no CSS form, so the marking is a fact rather
  // than a preference.
  assert.ok(NON_CSS.has('hsv'));
  assert.ok(NON_CSS.has('cmyk'));
});

test('formatting drops false precision rather than printing 50.00', () => {
  assert.equal(format(rgb(255, 0, 0), 'hsl'), 'hsl(0 100% 50%)');
  assert.equal(format(rgb(255, 0, 0), 'rgb'), 'rgb(255 0 0)');
});

test('an opaque colour is not written with a redundant alpha', () => {
  assert.ok(!format(rgb(255, 0, 0), 'hsl').includes('/'));
  assert.ok(format(rgb(255, 0, 0, 0.5), 'hsla').includes('/'));
  // hex8 is the exception: it is asked for explicitly, so it always writes it.
  assert.equal(format(rgb(255, 0, 0), 'hex8'), '#ff0000ff');
});
