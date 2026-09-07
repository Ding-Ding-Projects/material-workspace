/**
 * Colour conversion.
 *
 * Checked against values derived elsewhere — the CSS Color 4 specification's
 * own worked examples, the sRGB primaries, and published OKLab figures —
 * rather than against this module's own inverse. A pair of functions that are
 * each other's exact inverse can both be wrong and will agree perfectly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Rgb,
  cmykToRgb,
  contrastRatio,
  contrastVerdict,
  fromLinear,
  hslToRgb,
  hsvToRgb,
  hwbToRgb,
  isInSrgbGamut,
  labToLch,
  labToRgb,
  lchToLab,
  luminance,
  normaliseHue,
  okLabToOkLch,
  okLabToRgb,
  okLchToOkLab,
  parseHex,
  rgbToCmyk,
  rgbToHsl,
  rgbToHsv,
  rgbToHwb,
  rgbToLab,
  rgbToOkLab,
  toHex,
  toLinear,
} from '../../app/renderer/colour/convert';

const rgb = (r: number, g: number, b: number, alpha = 1): Rgb => ({ r, g, b, alpha });

function near(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    what + ': expected about ' + expected + ', got ' + actual,
  );
}

// -------------------------------------------------------------------- hex --

test('a short hex doubles each digit rather than shifting it', () => {
  // Shifting is the tempting implementation and makes every short hex slightly
  // too dark, uniformly — which reads as "the theme looks a bit off" rather
  // than as a bug.
  assert.deepEqual(parseHex('#abc'), rgb(0xaa, 0xbb, 0xcc));
  assert.deepEqual(parseHex('#fff'), rgb(255, 255, 255));
  assert.deepEqual(parseHex('#000'), rgb(0, 0, 0));
});

test('hex carries alpha in both lengths, and defaults to opaque', () => {
  assert.equal(parseHex('#11223344')?.alpha, 0x44 / 255);
  assert.equal(parseHex('#1234')?.alpha, 0x44 / 255);
  assert.equal(parseHex('#112233')?.alpha, 1);
});

test('a hex that is not a hex is refused rather than half-parsed', () => {
  for (const bad of ['#12', '#12345', '#1234567', 'nonsense', '#gg0011', '']) {
    assert.equal(parseHex(bad), null, 'accepted ' + JSON.stringify(bad));
  }
});

test('alpha is written only when it is asked for', () => {
  // Otherwise every opaque colour reads as `#112233ff`, and nobody writes that.
  assert.equal(toHex(rgb(17, 34, 51)), '#112233');
  assert.equal(toHex(rgb(17, 34, 51), true), '#112233ff');
  assert.equal(toHex(rgb(17, 34, 51, 0.5), true), '#11223380');
});

// -------------------------------------------------------------------- hsl --

test('the sRGB primaries land on their published HSL angles', () => {
  assert.deepEqual(rgbToHsl(rgb(255, 0, 0)), { h: 0, s: 100, l: 50, alpha: 1 });
  assert.deepEqual(rgbToHsl(rgb(0, 255, 0)), { h: 120, s: 100, l: 50, alpha: 1 });
  assert.deepEqual(rgbToHsl(rgb(0, 0, 255)), { h: 240, s: 100, l: 50, alpha: 1 });
  assert.deepEqual(rgbToHsl(rgb(255, 255, 0)), { h: 60, s: 100, l: 50, alpha: 1 });
  assert.deepEqual(rgbToHsl(rgb(0, 255, 255)), { h: 180, s: 100, l: 50, alpha: 1 });
  assert.deepEqual(rgbToHsl(rgb(255, 0, 255)), { h: 300, s: 100, l: 50, alpha: 1 });
});

test('black and white report no saturation rather than dividing by zero', () => {
  assert.equal(rgbToHsl(rgb(0, 0, 0)).s, 0);
  assert.equal(rgbToHsl(rgb(255, 255, 255)).s, 0);
  assert.equal(rgbToHsl(rgb(128, 128, 128)).s, 0);
});

test('hsl round-trips every primary and a scatter of others', () => {
  const samples = [
    rgb(255, 0, 0),
    rgb(0, 128, 64),
    rgb(18, 52, 86),
    rgb(200, 100, 50),
    rgb(1, 2, 3),
    rgb(254, 253, 252),
  ];
  for (const sample of samples) {
    const back = hslToRgb(rgbToHsl(sample));
    near(back.r, sample.r, 1, 'r of ' + JSON.stringify(sample));
    near(back.g, sample.g, 1, 'g of ' + JSON.stringify(sample));
    near(back.b, sample.b, 1, 'b of ' + JSON.stringify(sample));
  }
});

test('a hue wraps rather than being clamped', () => {
  // 370 and 10 are the same angle. Clamping to 360 would make every rotation
  // past the top of the wheel stick at magenta.
  assert.equal(normaliseHue(370), 10);
  assert.equal(normaliseHue(-30), 330);
  assert.equal(normaliseHue(720), 0);
  assert.deepEqual(hslToRgb({ h: 380, s: 100, l: 50, alpha: 1 }), hslToRgb({ h: 20, s: 100, l: 50, alpha: 1 }));
});

// -------------------------------------------------------------- hsv / hwb --

test('hsv reports value, not lightness', () => {
  // Pure red is 100% value and 50% lightness. Reporting one where the other is
  // meant makes every saturated colour look washed out or blown out.
  assert.equal(rgbToHsv(rgb(255, 0, 0)).v, 100);
  assert.equal(rgbToHsl(rgb(255, 0, 0)).l, 50);
  assert.deepEqual(hsvToRgb({ h: 0, s: 100, v: 100, alpha: 1 }), rgb(255, 0, 0));
});

test('hwb round-trips, and a sum over one collapses to the grey it describes', () => {
  const sample = rgb(120, 60, 200);
  const back = hwbToRgb(rgbToHwb(sample));
  near(back.r, sample.r, 1, 'r');
  near(back.g, sample.g, 1, 'g');
  near(back.b, sample.b, 1, 'b');

  // Not handling this produces a negative range and a colour outside 0-255.
  const collapsed = hwbToRgb({ h: 200, w: 80, b: 80, alpha: 1 });
  assert.equal(collapsed.r, collapsed.g);
  assert.equal(collapsed.g, collapsed.b);
  assert.ok(collapsed.r >= 0 && collapsed.r <= 255);
});

// ----------------------------------------------------------- transfer fn --

test('the sRGB transfer function is piecewise, not a plain power law', () => {
  // The linear segment near black is where a 2.2 approximation goes visibly
  // wrong, and dark colours are exactly where a theme's contrast is decided.
  assert.equal(toLinear(0), 0);
  near(toLinear(255), 1, 1e-9, 'white');
  near(toLinear(10), 10 / 255 / 12.92, 1e-9, 'inside the linear segment');
  // The 2.2 approximation is measurably off at this value.
  assert.ok(Math.abs(toLinear(10) - (10 / 255) ** 2.2) > 0.001);
});

test('the transfer function inverts itself across the whole range', () => {
  for (let value = 0; value <= 255; value += 1) {
    assert.equal(fromLinear(toLinear(value)), value, 'failed at ' + value);
  }
});

// ------------------------------------------------------------ CIELAB/LCH --

test('white and black land on their defined CIELAB values', () => {
  const white = rgbToLab(rgb(255, 255, 255));
  near(white.l, 100, 0.05, 'white L');
  near(white.a, 0, 0.05, 'white a');
  near(white.b, 0, 0.05, 'white b');

  const black = rgbToLab(rgb(0, 0, 0));
  near(black.l, 0, 0.05, 'black L');
});

test('sRGB red matches its published CIELAB coordinates, in D50 like CSS', () => {
  // CSS Color 4 defines lab() against D50, and this translator emits CSS, so
  // D50 is the number that must match. Red is L 54.29, a 80.80, b 69.89 there.
  //
  // Against D65 the same colour is L 53.24 - both are correct for their own
  // white point, and quoting one while computing the other is exactly how a
  // picker ends up emitting a lab() string that renders as a different colour
  // from the one that was chosen.

  const red = rgbToLab(rgb(255, 0, 0));
  near(red.l, 54.29, 0.3, 'red L');
  near(red.a, 80.8, 0.5, 'red a');
  near(red.b, 69.89, 0.5, 'red b');
});

test('CIELAB round-trips through RGB', () => {
  for (const sample of [rgb(255, 0, 0), rgb(0, 128, 64), rgb(18, 52, 86), rgb(200, 200, 200)]) {
    const back = labToRgb(rgbToLab(sample));
    near(back.r, sample.r, 1, 'r');
    near(back.g, sample.g, 1, 'g');
    near(back.b, sample.b, 1, 'b');
  }
});

test('a grey reports no hue rather than the angle of rounding noise', () => {
  // Otherwise a grey appears to have a colour that jumps about as it is nudged.
  assert.equal(labToLch(rgbToLab(rgb(128, 128, 128))).h, 0);
  assert.ok(labToLch(rgbToLab(rgb(128, 128, 128))).c < 0.5);
});

test('LCH round-trips back to CIELAB', () => {
  const lab = rgbToLab(rgb(90, 160, 40));
  const back = lchToLab(labToLch(lab));
  near(back.a, lab.a, 0.05, 'a');
  near(back.b, lab.b, 0.05, 'b');
});

// ---------------------------------------------------------- OKLab/OKLCH --

test('OKLab puts white at lightness one and black at zero', () => {
  near(rgbToOkLab(rgb(255, 255, 255)).l, 1, 0.002, 'white');
  near(rgbToOkLab(rgb(0, 0, 0)).l, 0, 0.002, 'black');
});

test('sRGB red matches its published OKLab coordinates', () => {
  // About L 0.6280, a 0.2249, b 0.1258 — from the OKLab reference values.
  const red = rgbToOkLab(rgb(255, 0, 0));
  near(red.l, 0.628, 0.005, 'red L');
  near(red.a, 0.2249, 0.005, 'red a');
  near(red.b, 0.1258, 0.005, 'red b');
});

test('OKLab round-trips through RGB and through OKLCH', () => {
  for (const sample of [rgb(255, 0, 0), rgb(0, 128, 64), rgb(18, 52, 86)]) {
    const back = okLabToRgb(rgbToOkLab(sample));
    near(back.r, sample.r, 1, 'r');
    near(back.g, sample.g, 1, 'g');
    near(back.b, sample.b, 1, 'b');

    const oklab = rgbToOkLab(sample);
    const viaLch = okLchToOkLab(okLabToOkLch(oklab));
    near(viaLch.a, oklab.a, 0.0001, 'a via lch');
    near(viaLch.b, oklab.b, 0.0001, 'b via lch');
  }
});

// ------------------------------------------------------------------ CMYK --

test('CMYK round-trips exactly, which is the only claim made for it', () => {
  // A real conversion needs an ICC profile for the specific press, ink and
  // paper. The picker says so; what is asserted here is only the arithmetic.
  for (const sample of [rgb(255, 0, 0), rgb(0, 0, 0), rgb(255, 255, 255), rgb(18, 52, 86)]) {
    const back = cmykToRgb(rgbToCmyk(sample));
    assert.deepEqual(back, sample, JSON.stringify(sample) + ' did not round-trip');
  }
});

test('black does not divide by zero on the way to CMYK', () => {
  assert.deepEqual(rgbToCmyk(rgb(0, 0, 0)), { c: 0, m: 0, y: 0, k: 100, alpha: 1 });
});

// -------------------------------------------------------------- contrast --

test('contrast matches the WCAG extremes', () => {
  // Black on white is 21:1 exactly, and a colour against itself is 1:1. Both
  // are defined values rather than measurements, so they pin the formula.
  assert.equal(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255)), 21);
  assert.equal(contrastRatio(rgb(120, 60, 200), rgb(120, 60, 200)), 1);
});

test('contrast is symmetric, so the order of the arguments cannot matter', () => {
  const a = rgb(30, 60, 90);
  const b = rgb(240, 230, 210);
  assert.equal(contrastRatio(a, b), contrastRatio(b, a));
});

test('the verdict names the threshold rather than passing or failing vaguely', () => {
  assert.equal(contrastVerdict(21), 'AAA');
  assert.equal(contrastVerdict(7), 'AAA');
  assert.equal(contrastVerdict(4.5), 'AA');
  assert.equal(contrastVerdict(3), 'AA large');
  assert.equal(contrastVerdict(2.99), 'fails');
});

test('luminance is ordered the way brightness is', () => {
  assert.ok(luminance(rgb(255, 255, 255)) > luminance(rgb(128, 128, 128)));
  assert.ok(luminance(rgb(128, 128, 128)) > luminance(rgb(0, 0, 0)));
  // Green carries most of it, which is why a green and a blue of the same
  // nominal lightness contrast so differently against white.
  assert.ok(luminance(rgb(0, 255, 0)) > luminance(rgb(0, 0, 255)));
});

test('a colour outside sRGB is reported rather than silently clipped', () => {
  assert.equal(isInSrgbGamut(rgb(0, 0, 0)), true);
  assert.equal(isInSrgbGamut(rgb(255, 255, 255)), true);
  assert.equal(isInSrgbGamut({ r: -3, g: 10, b: 10, alpha: 1 }), false);
  assert.equal(isInSrgbGamut({ r: 260, g: 10, b: 10, alpha: 1 }), false);
});

// --------------------------------------------------------------- alpha --

test('no conversion anywhere drops alpha', () => {
  // A picker that silently loses transparency when a user switches notation
  // has destroyed information they cannot get back by switching back.
  const translucent = rgb(120, 60, 200, 0.42);
  assert.equal(rgbToHsl(translucent).alpha, 0.42);
  assert.equal(rgbToHsv(translucent).alpha, 0.42);
  assert.equal(rgbToHwb(translucent).alpha, 0.42);
  assert.equal(rgbToLab(translucent).alpha, 0.42);
  assert.equal(labToLch(rgbToLab(translucent)).alpha, 0.42);
  assert.equal(rgbToOkLab(translucent).alpha, 0.42);
  assert.equal(okLabToOkLch(rgbToOkLab(translucent)).alpha, 0.42);
  assert.equal(rgbToCmyk(translucent).alpha, 0.42);
  assert.equal(hslToRgb(rgbToHsl(translucent)).alpha, 0.42);
  assert.equal(labToRgb(rgbToLab(translucent)).alpha, 0.42);
  assert.equal(okLabToRgb(rgbToOkLab(translucent)).alpha, 0.42);
  assert.equal(cmykToRgb(rgbToCmyk(translucent)).alpha, 0.42);
});
