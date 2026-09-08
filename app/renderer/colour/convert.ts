/**
 * Colour space conversion, for the picker's translator.
 *
 * Written here rather than taken from a package for the same reason as the
 * WebSocket codec: this project installs nothing alongside itself. Conversion
 * is arithmetic with published constants, and every step is checkable against
 * a value somebody else derived, which is what the tests do.
 *
 * TERMINOLOGY, because the same word means different things in different
 * spaces and mixing them up is the commonest defect here:
 *
 *   - `Rgb` components are 0-255. Byte values, what a hex string holds.
 *   - `Linear` components are 0-1 with the sRGB transfer function REMOVED.
 *     Every perceptual space goes through these. Interpolating in the byte
 *     values instead is the reason so many gradients pass through grey.
 *   - `alpha` is always 0-1, everywhere, and is never dropped by a conversion.
 *     A picker that silently loses transparency when a user switches notation
 *     has destroyed information they cannot get back by switching back.
 */

export interface Rgb {
  /** 0-255. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0-1. */
  readonly alpha: number;
}

export interface Hsl {
  /** Degrees, 0-360. */
  readonly h: number;
  /** Per cent, 0-100. */
  readonly s: number;
  readonly l: number;
  readonly alpha: number;
}

export interface Hsv {
  readonly h: number;
  readonly s: number;
  /** Per cent, 0-100. Called Brightness in HSB; the same number. */
  readonly v: number;
  readonly alpha: number;
}

export interface Hwb {
  readonly h: number;
  /** Per cent, 0-100. */
  readonly w: number;
  readonly b: number;
  readonly alpha: number;
}

export interface Lab {
  /** 0-100. */
  readonly l: number;
  /** Unbounded in practice; roughly -128..127. */
  readonly a: number;
  readonly b: number;
  readonly alpha: number;
}

export interface Lch {
  readonly l: number;
  readonly c: number;
  /** Degrees, 0-360. */
  readonly h: number;
  readonly alpha: number;
}

export interface OkLab {
  /** 0-1. */
  readonly l: number;
  readonly a: number;
  readonly b: number;
  readonly alpha: number;
}

export interface OkLch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha: number;
}

export interface Cmyk {
  /** Per cent, 0-100. */
  readonly c: number;
  readonly m: number;
  readonly y: number;
  readonly k: number;
  readonly alpha: number;
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function round(value: number, places = 0): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Wrap a hue into 0-360 so -30 and 330 are the same angle. */
export function normaliseHue(hue: number): number {
  const wrapped = hue % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

// ------------------------------------------------------------------- hex --

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
 *
 * The short forms DOUBLE each digit rather than shifting: `#abc` is `#aabbcc`,
 * not `#a0b0c0`. Shifting is the tempting implementation and makes every short
 * hex slightly too dark, uniformly, which reads as "the theme looks a bit off"
 * rather than as a bug.
 */
export function parseHex(input: string): Rgb | null {
  const text = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(text)) return null;

  const expand = (part: string): number => parseInt(part.repeat(2), 16);

  if (text.length === 3 || text.length === 4) {
    return {
      r: expand(text[0] as string),
      g: expand(text[1] as string),
      b: expand(text[2] as string),
      alpha: text.length === 4 ? expand(text[3] as string) / 255 : 1,
    };
  }
  if (text.length === 6 || text.length === 8) {
    return {
      r: parseInt(text.slice(0, 2), 16),
      g: parseInt(text.slice(2, 4), 16),
      b: parseInt(text.slice(4, 6), 16),
      alpha: text.length === 8 ? parseInt(text.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

export function toHex(rgb: Rgb, withAlpha = false): string {
  const byte = (value: number): string =>
    clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  const base = '#' + byte(rgb.r) + byte(rgb.g) + byte(rgb.b);
  // Alpha is appended only when asked for, or every opaque colour would read
  // as `#112233ff` and nobody writes that.
  return withAlpha ? base + byte(rgb.alpha * 255) : base;
}

// ------------------------------------------------------------- hsl / hsv --

export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (chroma !== 0) {
    if (max === r) h = ((g - b) / chroma) % 6;
    else if (max === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    h *= 60;
  }

  // Zero for both black and white: with no chroma there is no saturation to
  // report, and the division below would be by zero at either end.
  const s = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * l - 1));

  return { h: normaliseHue(h), s: round(s * 100, 2), l: round(l * 100, 2), alpha: rgb.alpha };
}

export function hslToRgb(hsl: Hsl): Rgb {
  const h = normaliseHue(hsl.h);
  const s = clamp(hsl.s, 0, 100) / 100;
  const l = clamp(hsl.l, 0, 100) / 100;

  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;

  const [r, g, b] = sector(h, chroma, x);
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    alpha: hsl.alpha,
  };
}

function sector(h: number, chroma: number, x: number): [number, number, number] {
  if (h < 60) return [chroma, x, 0];
  if (h < 120) return [x, chroma, 0];
  if (h < 180) return [0, chroma, x];
  if (h < 240) return [0, x, chroma];
  if (h < 300) return [x, 0, chroma];
  return [chroma, 0, x];
}

export function rgbToHsv(rgb: Rgb): Hsv {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;

  let h = 0;
  if (chroma !== 0) {
    if (max === r) h = ((g - b) / chroma) % 6;
    else if (max === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    h *= 60;
  }

  return {
    h: normaliseHue(h),
    s: round((max === 0 ? 0 : chroma / max) * 100, 2),
    v: round(max * 100, 2),
    alpha: rgb.alpha,
  };
}

export function hsvToRgb(hsv: Hsv): Rgb {
  const h = normaliseHue(hsv.h);
  const s = clamp(hsv.s, 0, 100) / 100;
  const v = clamp(hsv.v, 0, 100) / 100;

  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;

  const [r, g, b] = sector(h, chroma, x);
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    alpha: hsv.alpha,
  };
}

// -------------------------------------------------------------------- hwb --

export function rgbToHwb(rgb: Rgb): Hwb {
  const hsv = rgbToHsv(rgb);
  const white = Math.min(rgb.r, rgb.g, rgb.b) / 255;
  const black = 1 - Math.max(rgb.r, rgb.g, rgb.b) / 255;
  return { h: hsv.h, w: round(white * 100, 2), b: round(black * 100, 2), alpha: rgb.alpha };
}

export function hwbToRgb(hwb: Hwb): Rgb {
  let w = clamp(hwb.w, 0, 100) / 100;
  let b = clamp(hwb.b, 0, 100) / 100;

  // When whiteness and blackness together exceed one there is no hue left.
  // Scaling them back to sum to one gives the grey the numbers describe; not
  // handling it produces a negative range and a colour outside 0-255.
  if (w + b >= 1) {
    const grey = w / (w + b);
    w = grey;
    b = 1 - grey;
    const value = Math.round(grey * 255);
    return { r: value, g: value, b: value, alpha: hwb.alpha };
  }

  const base = hsvToRgb({ h: hwb.h, s: 100, v: 100, alpha: 1 });
  const apply = (channel: number): number => Math.round((channel / 255) * (1 - w - b) * 255 + w * 255);
  return { r: apply(base.r), g: apply(base.g), b: apply(base.b), alpha: hwb.alpha };
}

// ----------------------------------------------------------- linear sRGB --

/**
 * Remove the sRGB transfer function.
 *
 * The threshold and constants are from the sRGB specification. The piecewise
 * linear segment near black matters more than it looks: approximating the
 * whole curve as a plain 2.2 power law puts dark colours visibly wrong, and
 * dark colours are exactly where a theme's contrast is decided.
 */
export function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function fromLinear(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp(Math.round(c * 255), 0, 255);
}

/**
 * Two white points, and the adaptation between them.
 *
 * THIS IS THE TRAP, and it cost two wrong answers before it was written down.
 * sRGB is defined against D65, so the matrix above produces D65 XYZ. But CSS
 * Color 4 defines `lab()` and `lch()` against **D50**. Emitting a number
 * computed one way and labelling it the other produces a `lab()` string that
 * renders as a different colour from the one the user picked - which is the
 * one thing a colour translator must never do.
 *
 * The first version used a D50 white point with unadapted D65 XYZ, mixing the
 * two. Every round trip still passed, because the forward and inverse
 * conversions shared the mistake and agreed with each other exactly. What
 * caught it was asserting that white lands at a=0, b=0, a value the
 * specification defines rather than one computed here. It was out by 2.4:
 * a visible tint on every perceptual conversion in the application.
 *
 * So the XYZ is adapted D65 -> D50 with the Bradford matrix before CIELAB,
 * and back afterwards. OKLab is left at D65, because that is how OKLab is
 * defined; the two spaces genuinely use different white points and forcing
 * them to agree would break one of them.
 */
const D50_WHITE = { x: 0.3457 / 0.3585, y: 1, z: (1 - 0.3457 - 0.3585) / 0.3585 };

/** sRGB primaries to XYZ, D65 relative. The matrix sRGB is defined by. */
function rgbToXyz(rgb: Rgb): { x: number; y: number; z: number } {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  return {
    x: 0.4123907993 * r + 0.3575843394 * g + 0.1804807884 * b,
    y: 0.2126390059 * r + 0.7151686788 * g + 0.0721923154 * b,
    z: 0.0193308187 * r + 0.1191947798 * g + 0.9505321522 * b,
  };
}

function xyzToRgb(xyz: { x: number; y: number; z: number }, alpha: number): Rgb {
  const r = 3.2409699419 * xyz.x - 1.5373831776 * xyz.y - 0.4986107603 * xyz.z;
  const g = -0.9692436363 * xyz.x + 1.8759675015 * xyz.y + 0.0415550574 * xyz.z;
  const b = 0.0556300797 * xyz.x - 0.203976959 * xyz.y + 1.0569715142 * xyz.z;
  return { r: fromLinear(r), g: fromLinear(g), b: fromLinear(b), alpha };
}

/** Bradford chromatic adaptation, D65 to D50. Constants from CSS Color 4. */
function adaptToD50(xyz: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: 1.0479298208405488 * xyz.x + 0.022946793341019088 * xyz.y - 0.05019222954313557 * xyz.z,
    y: 0.029627815688159344 * xyz.x + 0.990434484573249 * xyz.y - 0.01707382502938514 * xyz.z,
    z: -0.009243058152591178 * xyz.x + 0.015055144896577895 * xyz.y + 0.7518742899580008 * xyz.z,
  };
}

/** Bradford chromatic adaptation, D50 back to D65. */
function adaptToD65(xyz: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: 0.9554734527042182 * xyz.x - 0.023098536874261423 * xyz.y + 0.0632593086610217 * xyz.z,
    y: -0.028369706963208136 * xyz.x + 1.0099954580058226 * xyz.y + 0.021041398966943008 * xyz.z,
    z: 0.012314001688319899 * xyz.x - 0.020507696433477912 * xyz.y + 1.3303659366080753 * xyz.z,
  };
}

// ------------------------------------------------------------ CIELAB/LCH --

const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

export function rgbToLab(rgb: Rgb): Lab {
  const xyz = adaptToD50(rgbToXyz(rgb));
  const f = (t: number): number => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  const fx = f(xyz.x / D50_WHITE.x);
  const fy = f(xyz.y / D50_WHITE.y);
  const fz = f(xyz.z / D50_WHITE.z);
  return {
    l: round(116 * fy - 16, 2),
    a: round(500 * (fx - fy), 2),
    b: round(200 * (fy - fz), 2),
    alpha: rgb.alpha,
  };
}

export function labToRgb(lab: Lab): Rgb {
  const fy = (lab.l + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const inv = (t: number): number => (t ** 3 > EPSILON ? t ** 3 : (116 * t - 16) / KAPPA);
  const d50 = {
    x: inv(fx) * D50_WHITE.x,
    y: (lab.l > KAPPA * EPSILON ? ((lab.l + 16) / 116) ** 3 : lab.l / KAPPA) * D50_WHITE.y,
    z: inv(fz) * D50_WHITE.z,
  };
  return xyzToRgb(adaptToD65(d50), lab.alpha);
}

export function labToLch(lab: Lab): Lch {
  const c = Math.sqrt(lab.a ** 2 + lab.b ** 2);
  // Below this there is no meaningful hue, and reporting the angle of rounding
  // noise makes a grey appear to have a colour that jumps about as it is
  // nudged.
  const h = c < 0.0001 ? 0 : normaliseHue((Math.atan2(lab.b, lab.a) * 180) / Math.PI);
  return { l: lab.l, c: round(c, 2), h: round(h, 2), alpha: lab.alpha };
}

export function lchToLab(lch: Lch): Lab {
  const radians = (normaliseHue(lch.h) * Math.PI) / 180;
  return {
    l: lch.l,
    a: round(lch.c * Math.cos(radians), 4),
    b: round(lch.c * Math.sin(radians), 4),
    alpha: lch.alpha,
  };
}

// ---------------------------------------------------------- OKLab/OKLCH --

export function rgbToOkLab(rgb: Rgb): OkLab {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    l: round(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 5),
    a: round(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 5),
    b: round(0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, 5),
    alpha: rgb.alpha,
  };
}

export function okLabToRgb(oklab: OkLab): Rgb {
  const l = (oklab.l + 0.3963377774 * oklab.a + 0.2158037573 * oklab.b) ** 3;
  const m = (oklab.l - 0.1055613458 * oklab.a - 0.0638541728 * oklab.b) ** 3;
  const s = (oklab.l - 0.0894841775 * oklab.a - 1.291485548 * oklab.b) ** 3;

  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha: oklab.alpha,
  };
}

export function okLabToOkLch(oklab: OkLab): OkLch {
  const c = Math.sqrt(oklab.a ** 2 + oklab.b ** 2);
  const h = c < 0.00001 ? 0 : normaliseHue((Math.atan2(oklab.b, oklab.a) * 180) / Math.PI);
  return { l: oklab.l, c: round(c, 5), h: round(h, 2), alpha: oklab.alpha };
}

export function okLchToOkLab(oklch: OkLch): OkLab {
  const radians = (normaliseHue(oklch.h) * Math.PI) / 180;
  return {
    l: oklch.l,
    a: oklch.c * Math.cos(radians),
    b: oklch.c * Math.sin(radians),
    alpha: oklch.alpha,
  };
}

// ------------------------------------------------------------------ CMYK --

/**
 * CMYK, by the naive conversion, and the picker says so.
 *
 * A real conversion needs an ICC profile for the specific press, ink and
 * paper, so this cannot predict what anything will print like. It is offered
 * because people ask for the numbers and because the round trip back to RGB is
 * exact; presenting it as print-accurate would be the dishonest part, not
 * offering it.
 */
export function rgbToCmyk(rgb: Rgb): Cmyk {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const k = 1 - Math.max(r, g, b);

  if (k === 1) return { c: 0, m: 0, y: 0, k: 100, alpha: rgb.alpha };

  return {
    c: round(((1 - r - k) / (1 - k)) * 100, 2),
    m: round(((1 - g - k) / (1 - k)) * 100, 2),
    y: round(((1 - b - k) / (1 - k)) * 100, 2),
    k: round(k * 100, 2),
    alpha: rgb.alpha,
  };
}

export function cmykToRgb(cmyk: Cmyk): Rgb {
  const c = clamp(cmyk.c, 0, 100) / 100;
  const m = clamp(cmyk.m, 0, 100) / 100;
  const y = clamp(cmyk.y, 0, 100) / 100;
  const k = clamp(cmyk.k, 0, 100) / 100;
  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k)),
    alpha: cmyk.alpha,
  };
}

// -------------------------------------------------------------- contrast --

/** Relative luminance, WCAG 2.x definition. */
export function luminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/**
 * WCAG contrast ratio, 1 to 21.
 *
 * Computed on the OPAQUE colours. A ratio against a translucent colour is
 * meaningless without knowing what is behind it, and quietly compositing over
 * an assumed white would report a number that is wrong on a dark theme —
 * which is exactly where contrast problems live.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const one = luminance(a);
  const two = luminance(b);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return round((lighter + 0.05) / (darker + 0.05), 2);
}

export type ContrastVerdict = 'fails' | 'AA large' | 'AA' | 'AAA';

export function contrastVerdict(ratio: number): ContrastVerdict {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large';
  return 'fails';
}

/**
 * Whether a colour survives the trip into sRGB unchanged.
 *
 * A wide-gamut space can name colours sRGB cannot show. Converting one clips
 * it silently, so the picker warns rather than pretending the number it echoes
 * back is what the user asked for.
 */
export function isInSrgbGamut(rgb: Rgb): boolean {
  return (
    rgb.r >= 0 && rgb.r <= 255 && rgb.g >= 0 && rgb.g <= 255 && rgb.b >= 0 && rgb.b <= 255
  );
}
