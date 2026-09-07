/**
 * The animated rainbow.
 *
 * Every test here corresponds to a way this feature is normally got wrong, and
 * each failure mode is silent: no error, no warning, just a surface that looks
 * slightly broken or a preference that is quietly ignored.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rgbToHsl, toHex } from '../../app/renderer/colour/convert';
import {
  DEFAULT_SPEED,
  RAINBOW,
  SPEED_LEVELS,
  STILL_HUE,
  durationFor,
  globalRainbowProperties,
  hueAt,
  isRainbow,
  isSpeedLevel,
  rainbowColourAt,
  resolveForStatic,
  stillColour,
  wheelStops,
} from '../../app/renderer/colour/rainbow';

test('the sentinel is not a valid CSS colour', () => {
  // Deliberately, so a call site that passes it straight through fails
  // visibly rather than rendering something plausible and wrong.
  assert.equal(RAINBOW, 'rainbow');
  assert.ok(!RAINBOW.startsWith('#'));
  assert.ok(!/^(rgb|hsl|oklch|lab)\(/.test(RAINBOW));
});

test('the sentinel plus an alpha suffix is NOT a colour, which is the point', () => {
  // Call sites routinely build a tint by appending alpha to a stored value.
  // With the sentinel in a swatch palette that produces `rainbow33`, which is
  // not an error - merely an ignored declaration - so the surface renders with
  // no background and nothing anywhere says why. This asserts the shape of the
  // hazard so the reason the sentinel is kept out of palettes stays recorded.
  const tinted = RAINBOW + '33';
  assert.ok(!/^#[0-9a-f]{6,8}$/i.test(tinted));
  assert.equal(isRainbow(tinted), false, 'a tinted sentinel was mistaken for the sentinel');
});

test('only the exact sentinel is the sentinel', () => {
  for (const near of ['rainbows', 'Rainbow', ' rainbow', '#rainbow', '']) {
    assert.equal(isRainbow(near), false, 'accepted ' + JSON.stringify(near));
  }
  assert.equal(isRainbow(RAINBOW), true);
});

// ----------------------------------------------------------------- speed --

test('a bigger level is faster, which is the direction Speed implies', () => {
  // A slider where a bigger number means slower is a control people fight.
  for (let index = 1; index < SPEED_LEVELS.length; index += 1) {
    const slower = durationFor(SPEED_LEVELS[index - 1]);
    const faster = durationFor(SPEED_LEVELS[index]);
    assert.ok(faster < slower, 'level ' + SPEED_LEVELS[index] + ' was not faster');
  }
});

test('an unusable level falls back rather than reaching CSS as NaN', () => {
  // A hand-edited settings file holding "fast" would otherwise produce `NaNs`,
  // and an invalid duration silently DISABLES the animation rather than
  // failing - so the rainbow stops moving and nothing explains why.
  for (const bad of ['fast', null, undefined, 0, 9, -1, 2.5, {}, []]) {
    const seconds = durationFor(bad);
    assert.ok(Number.isFinite(seconds), JSON.stringify(bad) + ' produced ' + seconds);
    assert.ok(seconds > 0);
  }
  assert.equal(durationFor('fast'), durationFor(DEFAULT_SPEED));
});

test('the level guard accepts exactly the published levels', () => {
  for (const level of SPEED_LEVELS) assert.equal(isSpeedLevel(level), true);
  for (const bad of [0, 6, '3', null, 3.0001]) assert.equal(isSpeedLevel(bad), false, String(bad));
});

// ------------------------------------------------------------------ hue --

test('the hue walks the wheel rather than crossing it', () => {
  // Two stops from red to red fade through GREY, because the shortest path
  // between two identical hues is no path at all. Walking means the midpoint
  // of a cycle is the opposite hue, not a desaturated nothing.
  assert.equal(hueAt(0, 3), 0);
  assert.equal(hueAt(durationFor(3) / 2, 3), 180);
  assert.equal(hueAt(durationFor(3) / 4, 3), 90);
});

test('a full cycle returns to where it started, at every level', () => {
  for (const level of SPEED_LEVELS) {
    assert.equal(hueAt(durationFor(level), level), 0, 'level ' + level + ' did not close the loop');
    // And it keeps going rather than sticking at the top of the wheel.
    assert.equal(hueAt(durationFor(level) * 1.25, level), 90);
  }
});

test('the cycling colour stays saturated all the way round', () => {
  // The failure this catches is a gradient that passes through grey, which is
  // what interpolating between endpoints produces.
  for (let step = 0; step <= 12; step += 1) {
    const colour = rainbowColourAt((durationFor(3) * step) / 12, 3);
    const hsl = rgbToHsl(colour);
    assert.ok(hsl.s > 50, 'washed out at step ' + step + ': saturation ' + hsl.s);
  }
});

test('the wheel preview closes the loop and does not pass through grey', () => {
  const stops = wheelStops();
  assert.equal(stops[0], stops[stops.length - 1], 'the wheel did not close');
  assert.ok(stops.length >= 7, 'too few stops to walk the wheel');
  for (const stop of stops) {
    assert.ok(rgbToHsl({ ...parse(stop), alpha: 1 }).s > 50, stop + ' is desaturated');
  }
});

function parse(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// -------------------------------------------------------- reduced motion --

test('reduced motion settles on one hue rather than slowing down', () => {
  // A slow cycle is still motion, and a continuously changing background is
  // exactly what that preference exists to stop.
  const properties = globalRainbowProperties(5, true);
  assert.equal(properties['--workspace-rainbow-play'], 'paused');

  const moving = globalRainbowProperties(5, false);
  assert.equal(moving['--workspace-rainbow-play'], 'running');
  // The duration is unchanged: pausing is not the same as setting it to zero,
  // which would be an invalid animation rather than a stopped one.
  assert.equal(properties['--workspace-rainbow-duration'], moving['--workspace-rainbow-duration']);
});

test('the still colour reads as deliberate rather than as a failure to load', () => {
  const hsl = rgbToHsl(stillColour());
  // Within a degree, not exact: the hue makes a round trip through 8-bit RGB,
  // where 210 has no exact representation. Asserting equality here would be
  // asserting that a lossy step is lossless.
  assert.ok(Math.abs(hsl.h - STILL_HUE) < 1, 'the still hue drifted to ' + hsl.h);
  assert.ok(hsl.s > 50, 'the still colour is a grey, which reads as broken');
});

// -------------------------------------------------------------- resolve --

test('a static context gets a paintable colour, never the sentinel', () => {
  // A screenshot, an export or a contrast calculation has no time axis, and
  // returning the sentinel would put an invalid string into a stylesheet.
  const resolved = resolveForStatic(RAINBOW);
  assert.match(resolved, /^#[0-9a-f]{6}$/i);
  assert.equal(resolved, toHex(stillColour()));
});

test('an ordinary colour passes through resolve untouched', () => {
  assert.equal(resolveForStatic('#123456'), '#123456');
  assert.equal(resolveForStatic('oklch(0.7 0.1 200)'), 'oklch(0.7 0.1 200)');
});

// --------------------------------------------------------------- global --

test('the duration is published once for every rainbow on a surface', () => {
  // Set per element they drift apart by however long apart they were mounted,
  // and six rainbows each showing a different hue reads as a rendering fault.
  const properties = globalRainbowProperties(4, false);
  assert.deepEqual(Object.keys(properties).sort(), [
    '--workspace-rainbow-duration',
    '--workspace-rainbow-play',
    '--workspace-rainbow-still',
  ]);
  assert.equal(properties['--workspace-rainbow-duration'], durationFor(4) + 's');
  // A unit is present: a bare number is an invalid CSS duration and disables
  // the animation silently.
  assert.match(String(properties['--workspace-rainbow-duration']), /^[\d.]+s$/);
});
