/**
 * Reading and writing colours in every notation the picker offers.
 *
 * The translator's whole value is that a colour written one way and read back
 * another is the SAME colour. So parsing and formatting live together, every
 * notation round-trips, and the one place where that is impossible - CMYK,
 * which has no CSS form - is stated rather than quietly omitted.
 *
 * Alpha is never dropped. A picker that loses transparency when somebody
 * switches notation has destroyed information they cannot get back by
 * switching back, and it does it silently.
 */

import {
  type Rgb,
  clamp,
  cmykToRgb,
  hslToRgb,
  hsvToRgb,
  hwbToRgb,
  labToLch,
  labToRgb,
  lchToLab,
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
} from './convert';

export type Notation =
  | 'named'
  | 'hex'
  | 'hex8'
  | 'rgb'
  | 'rgba'
  | 'hsl'
  | 'hsla'
  | 'hsv'
  | 'hwb'
  | 'lab'
  | 'lch'
  | 'oklab'
  | 'oklch'
  | 'cmyk';

export const NOTATIONS: readonly Notation[] = [
  'named',
  'hex',
  'hex8',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hsv',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'cmyk',
];

/** Notations that are not valid CSS, so the surface can say so. */
export const NON_CSS: ReadonlySet<Notation> = new Set<Notation>(['hsv', 'cmyk']);

/**
 * The CSS named colours.
 *
 * The complete list, not a curated subset. A translator that shows "named:
 * none" for `rebeccapurple` is a translator somebody stops trusting, and the
 * cost of completeness here is a few hundred bytes of table.
 */
export const NAMED: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
  azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
  blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
  coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00',
  darkorchid: '#9932cc', darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1', darkviolet: '#9400d3', deeppink: '#ff1493',
  deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1e90ff',
  firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22', fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520',
  gray: '#808080', green: '#008000', greenyellow: '#adff2f', grey: '#808080',
  honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c', indigo: '#4b0082',
  ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080',
  lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
  lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899',
  lightslategrey: '#778899', lightsteelblue: '#b0c4de', lightyellow: '#ffffe0',
  lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6', magenta: '#ff00ff',
  maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd',
  mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa',
  mistyrose: '#ffe4e1', moccasin: '#ffe4b5', navajowhite: '#ffdead', navy: '#000080',
  oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23', orange: '#ffa500',
  orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
  paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5',
  peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb', plum: '#dda0dd',
  powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399', red: '#ff0000',
  rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072',
  sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d',
  silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090',
  slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f', steelblue: '#4682b4',
  tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8', tomato: '#ff6347',
  turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff',
  whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
};

/** Reverse lookup, built once. */
const BY_HEX: Readonly<Record<string, string>> = (() => {
  const table: Record<string, string> = {};
  for (const [name, hex] of Object.entries(NAMED)) {
    // First name wins, so `aqua` is reported rather than `cyan` for #00ffff.
    // Both are correct; picking deterministically is what matters, or the
    // reported name changes between runs for no reason a reader can see.
    if (table[hex] === undefined) table[hex] = name;
  }
  return table;
})();

/** The name for a colour, or null. Only exact, opaque matches get a name. */
export function nameFor(rgb: Rgb): string | null {
  // A translucent colour has no named form: `red` at 50% is not `red`, and
  // reporting it as such loses the alpha the moment somebody copies it.
  if (rgb.alpha !== 1) return null;
  return BY_HEX[toHex(rgb).toLowerCase()] ?? null;
}

function trim(value: number, places = 2): string {
  // Trailing zeros removed, so 50.00 reads as 50 rather than as false
  // precision somebody might try to reproduce.
  return String(Number(value.toFixed(places)));
}

function alphaSuffix(alpha: number): string {
  return alpha === 1 ? '' : ' / ' + trim(alpha, 3);
}

/** Write a colour in a notation. */
export function format(rgb: Rgb, notation: Notation): string {
  switch (notation) {
    case 'named': {
      const name = nameFor(rgb);
      // Honest rather than approximate. Snapping to the nearest named colour
      // would report a name for a colour that is not that colour.
      return name ?? 'no exact name';
    }
    case 'hex':
      return toHex(rgb);
    case 'hex8':
      return toHex(rgb, true);
    case 'rgb':
      return 'rgb(' + Math.round(rgb.r) + ' ' + Math.round(rgb.g) + ' ' + Math.round(rgb.b) + ')';
    case 'rgba':
      return (
        'rgb(' +
        Math.round(rgb.r) + ' ' + Math.round(rgb.g) + ' ' + Math.round(rgb.b) +
        ' / ' + trim(rgb.alpha, 3) + ')'
      );
    case 'hsl': {
      const hsl = rgbToHsl(rgb);
      return 'hsl(' + trim(hsl.h) + ' ' + trim(hsl.s) + '% ' + trim(hsl.l) + '%)';
    }
    case 'hsla': {
      const hsl = rgbToHsl(rgb);
      return (
        'hsl(' + trim(hsl.h) + ' ' + trim(hsl.s) + '% ' + trim(hsl.l) + '% / ' +
        trim(hsl.alpha, 3) + ')'
      );
    }
    case 'hsv': {
      const hsv = rgbToHsv(rgb);
      // Not CSS, and the surface says so. Written in a shape a person can read
      // rather than one a browser would accept, so it cannot be pasted by
      // mistake and silently ignored.
      return (
        'hsv(' + trim(hsv.h) + ' ' + trim(hsv.s) + '% ' + trim(hsv.v) + '%' +
        alphaSuffix(hsv.alpha) + ')'
      );
    }
    case 'hwb': {
      const hwb = rgbToHwb(rgb);
      return (
        'hwb(' + trim(hwb.h) + ' ' + trim(hwb.w) + '% ' + trim(hwb.b) + '%' +
        alphaSuffix(hwb.alpha) + ')'
      );
    }
    case 'lab': {
      const lab = rgbToLab(rgb);
      return 'lab(' + trim(lab.l) + '% ' + trim(lab.a) + ' ' + trim(lab.b) + alphaSuffix(lab.alpha) + ')';
    }
    case 'lch': {
      const lch = labToLch(rgbToLab(rgb));
      return 'lch(' + trim(lch.l) + '% ' + trim(lch.c) + ' ' + trim(lch.h) + alphaSuffix(lch.alpha) + ')';
    }
    case 'oklab': {
      const oklab = rgbToOkLab(rgb);
      return (
        'oklab(' + trim(oklab.l, 4) + ' ' + trim(oklab.a, 4) + ' ' + trim(oklab.b, 4) +
        alphaSuffix(oklab.alpha) + ')'
      );
    }
    case 'oklch': {
      const oklch = okLabToOkLch(rgbToOkLab(rgb));
      return (
        'oklch(' + trim(oklch.l, 4) + ' ' + trim(oklch.c, 4) + ' ' + trim(oklch.h) +
        alphaSuffix(oklch.alpha) + ')'
      );
    }
    case 'cmyk': {
      const cmyk = rgbToCmyk(rgb);
      return (
        'cmyk(' + trim(cmyk.c) + '% ' + trim(cmyk.m) + '% ' + trim(cmyk.y) + '% ' +
        trim(cmyk.k) + '%)'
      );
    }
  }
}

/**
 * Pull the numbers out of `name(a b c / d)` or the legacy comma form.
 *
 * Deliberately does NOT decide what a fourth number means. The legacy
 * `rgba(r, g, b, a)` form puts alpha there, and `cmyk()` puts the black
 * channel there - so a tokeniser that claims the fourth slot for alpha eats
 * CMYK's K and silently reports every colour as having no black in it. The
 * caller knows which function it is reading; this does not.
 */
function components(body: string): { values: number[]; alpha: number | null } | null {
  const [main, alphaPart] = body.split('/');
  const values = (main ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map((part) => Number(part.replace('%', '')));

  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;

  if (alphaPart === undefined) return { values, alpha: null };

  const text = alphaPart.trim();
  const value = Number(text.replace('%', ''));
  if (!Number.isFinite(value)) return null;
  return { values, alpha: clamp(text.endsWith('%') ? value / 100 : value, 0, 1) };
}

/**
 * Parse any notation this picker can write, plus the CSS forms people paste.
 *
 * Returns null rather than guessing. A picker that silently interprets an
 * unparseable string as black has replaced somebody's colour with a different
 * one and told them it worked.
 */
export function parseAny(input: string): Rgb | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;

  if (text === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };

  const named = NAMED[text];
  if (named !== undefined) return parseHex(named);

  if (text.startsWith('#')) return parseHex(text);

  const match = /^([a-z]+)\(([^)]*)\)$/.exec(text);
  if (match === null) {
    // A bare hex without the hash, which is what people paste from design
    // tools. Accepted because refusing it helps nobody.
    return /^[0-9a-f]{3,8}$/.test(text) ? parseHex(text) : null;
  }

  const fn = match[1] as string;
  const parsed = components(match[2] as string);
  if (parsed === null) return null;
  const [a, b, c, d] = parsed.values;
  if (a === undefined || b === undefined || c === undefined) return null;

  // CMYK's fourth number is its black channel, and it has no alpha form at
  // all. Every other function here takes three components, so a fourth is the
  // legacy alpha slot.
  if (fn === 'cmyk') {
    if (d === undefined) return null;
    return cmykToRgb({ c: a, m: b, y: c, k: d, alpha: parsed.alpha ?? 1 });
  }

  const alpha = parsed.alpha ?? (d !== undefined ? clamp(d, 0, 1) : 1);

  switch (fn) {
    case 'rgb':
    case 'rgba':
      return { r: clamp(a, 0, 255), g: clamp(b, 0, 255), b: clamp(c, 0, 255), alpha };
    case 'hsl':
    case 'hsla':
      return hslToRgb({ h: a, s: b, l: c, alpha });
    case 'hsv':
    case 'hsb':
      return hsvToRgb({ h: a, s: b, v: c, alpha });
    case 'hwb':
      return hwbToRgb({ h: a, w: b, b: c, alpha });
    case 'lab':
      return labToRgb({ l: a, a: b, b: c, alpha });
    case 'lch':
      return labToRgb(lchToLab({ l: a, c: b, h: c, alpha }));
    case 'oklab':
      return okLabToRgb({ l: a, a: b, b: c, alpha });
    case 'oklch':
      return okLabToRgb(okLchToOkLab({ l: a, c: b, h: c, alpha }));
    default:
      return null;
  }
}

/** Every notation at once, for the translator panel. */
export function translate(rgb: Rgb): { notation: Notation; text: string; css: boolean }[] {
  return NOTATIONS.map((notation) => ({
    notation,
    text: format(rgb, notation),
    css: !NON_CSS.has(notation),
  }));
}
