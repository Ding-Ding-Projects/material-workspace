/**
 * Turning a PDF page into something that can be drawn.
 *
 * A content stream is a little stack language: operands accumulate, an operator
 * consumes them. This walks it and produces a DISPLAY LIST - resolution
 * independent, in device coordinates, ready for a canvas or for the software
 * rasterizer below.
 *
 * WHY A DISPLAY LIST AND NOT PIXELS, AND WHY THAT IS THE HONEST CHOICE.
 *
 * A page is drawn at some size, and a rasterizer that bakes one in throws away
 * everything a zoom needs. More importantly, TEXT here has no glyph outlines to
 * draw: the standard fourteen fonts are not embedded, by design, so a
 * from-scratch engine has no shapes for them. It has the string, the position,
 * the size and the font name - which is exactly what a canvas needs to draw the
 * text with a real font.
 *
 * So paths are rendered faithfully, and text is placed faithfully and drawn by
 * whatever has fonts. Inventing glyph shapes would be inventing a typeface, and
 * a page rendered in a typeface nobody chose is worse than one drawn in the
 * viewer's own.
 *
 * FIVE THINGS THAT GO WRONG HERE AND LOOK FINE.
 *
 *   - PDF's Y AXIS POINTS UP. The origin is the bottom-left corner. A renderer
 *     that draws straight onto a screen coordinate system puts every page
 *     upside down, and a page of centred text looks almost right.
 *
 *   - THE CTM IS A STACK. `q` and `Q` save and restore it, and `cm`
 *     CONCATENATES rather than replaces. A renderer that assigns instead of
 *     multiplying loses every nested transform.
 *
 *   - `re` IS NOT A PATH ON ITS OWN. It appends a closed rectangle subpath.
 *     Painting happens at `f`, `S`, `B` or not at all at `n`, and a renderer
 *     that paints on `re` fills every clipping rectangle it meets.
 *
 *   - TEXT POSITION IS TWO MATRICES. Tm is set by `Tm` and moved by `Td`; the
 *     line matrix is what `Td` is relative to. Treating them as one makes the
 *     second line of every paragraph land in the wrong place.
 *
 *   - A NUMBER INSIDE `TJ` IS A KERN, IN THOUSANDTHS OF EM, AND IT IS
 *     SUBTRACTED. Adding it, or treating it as content, drifts the text along
 *     the line by a little on every adjustment.
 */

import { decodeStream } from './filters.js';
import { type PdfDocument, type PdfObject } from './reader.js';

const decoder = new TextDecoder('latin1');

/** A 2D affine transform, in PDF order: [a b c d e f]. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` applied first, then `b`. The order that makes `cm` concatenate. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function apply(matrix: Matrix, x: number, y: number): readonly [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

export interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const BLACK: Colour = { r: 0, g: 0, b: 0 };

export type PathCommand =
  | { readonly op: 'move'; readonly x: number; readonly y: number }
  | { readonly op: 'line'; readonly x: number; readonly y: number }
  | {
      readonly op: 'curve';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: 'close' };

export type DisplayItem =
  | {
      readonly kind: 'path';
      readonly commands: readonly PathCommand[];
      readonly fill: Colour | null;
      readonly stroke: Colour | null;
      readonly lineWidth: number;
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      /** Device coordinates of the text origin, Y already flipped. */
      readonly x: number;
      readonly y: number;
      /** Effective size in device units, after the text and page matrices. */
      readonly size: number;
      readonly font: string;
      readonly colour: Colour;
    };

export interface RenderedPage {
  readonly width: number;
  readonly height: number;
  readonly items: readonly DisplayItem[];
}

interface GraphicsState {
  ctm: Matrix;
  fill: Colour;
  stroke: Colour;
  lineWidth: number;
}

/* ------------------------------------------------------------ tokenizer -- */

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'operator'; readonly value: string }
  | { readonly kind: 'open' }
  | { readonly kind: 'close' };

/**
 * Split a content stream into tokens.
 *
 * Written by hand rather than with a regular expression because a PDF string
 * can contain unbalanced parentheses when they are escaped, and `\)` inside one
 * is a literal - a pattern that counts brackets ends the string early and every
 * token after it is garbage.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < source.length) {
    const character = source[at] as string;

    if (character === '%') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s/.test(character)) {
      at += 1;
      continue;
    }

    if (character === '(') {
      at += 1;
      let depth = 1;
      let value = '';
      while (at < source.length && depth > 0) {
        const next = source[at] as string;
        if (next === '\\') {
          const escaped = source[at + 1] ?? '';
          // The escapes a PDF string really uses. An unknown one is the
          // character itself, which is what the specification says.
          const map: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            f: '\f',
            '(': '(',
            ')': ')',
            '\\': '\\',
          };
          value += map[escaped] ?? escaped;
          at += 2;
          continue;
        }
        if (next === '(') depth += 1;
        if (next === ')') {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        }
        value += next;
        at += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }

    if (character === '<' && source[at + 1] !== '<') {
      // A hexadecimal string. Two digits to the byte, and an odd final digit
      // is padded with zero rather than dropped.
      at += 1;
      let hex = '';
      while (at < source.length && source[at] !== '>') {
        if (/[0-9a-fA-F]/.test(source[at] as string)) hex += source[at];
        at += 1;
      }
      at += 1;
      if (hex.length % 2 === 1) hex += '0';
      let value = '';
      for (let index = 0; index < hex.length; index += 2) {
        value += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
      }
      tokens.push({ kind: 'string', value });
      continue;
    }

    if (character === '/') {
      at += 1;
      let value = '';
      while (at < source.length && /[^\s/[\]<>(){}]/.test(source[at] as string)) {
        value += source[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }

    if (character === '[') {
      tokens.push({ kind: 'open' });
      at += 1;
      continue;
    }
    if (character === ']') {
      tokens.push({ kind: 'close' });
      at += 1;
      continue;
    }

    if (/[-+.\d]/.test(character)) {
      let raw = '';
      while (at < source.length && /[-+.\d]/.test(source[at] as string)) {
        raw += source[at];
        at += 1;
      }
      const value = Number(raw);
      tokens.push({ kind: 'number', value: Number.isFinite(value) ? value : 0 });
      continue;
    }

    let operator = '';
    while (at < source.length && /[^\s/[\]<>(){}]/.test(source[at] as string)) {
      operator += source[at];
      at += 1;
    }
    if (operator === '') {
      at += 1;
      continue;
    }
    tokens.push({ kind: 'operator', value: operator });
  }

  return tokens;
}

/* ---------------------------------------------------------- interpreter -- */

export interface RenderOptions {
  /** Page size in points. Defaults to US Letter, which is what the writer emits. */
  readonly width?: number;
  readonly height?: number;
}

/**
 * Interpret one content stream into a display list.
 *
 * Device coordinates, Y already flipped: PDF's origin is the bottom-left and a
 * screen's is the top-left, and a renderer that forgets draws every page upside
 * down - which on a page of centred text looks very nearly right.
 */
export function renderContent(source: string, options: RenderOptions = {}): RenderedPage {
  const width = options.width ?? 612;
  const height = options.height ?? 792;

  const items: DisplayItem[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = {
    ctm: IDENTITY,
    fill: BLACK,
    stroke: BLACK,
    lineWidth: 1,
  };

  let path: PathCommand[] = [];
  let start: readonly [number, number] | null = null;

  // The two text matrices. One is the current position, the other is what a
  // `Td` is relative to - collapsing them puts the second line of every
  // paragraph in the wrong place.
  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let fontSize = 0;
  let fontName = 'Helvetica';
  let leading = 0;

  const operands: (number | string)[] = [];
  const numbers = (count: number): number[] => {
    const out = operands.slice(-count).map((value) => (typeof value === 'number' ? value : 0));
    while (out.length < count) out.unshift(0);
    return out;
  };

  /** Device space: apply the CTM, then flip Y. */
  const device = (x: number, y: number): readonly [number, number] => {
    const [dx, dy] = apply(state.ctm, x, y);
    return [dx, height - dy];
  };

  const paint = (fill: boolean, stroke: boolean): void => {
    if (path.length > 0) {
      items.push({
        kind: 'path',
        commands: path,
        fill: fill ? state.fill : null,
        stroke: stroke ? state.stroke : null,
        lineWidth: state.lineWidth,
      });
    }
    path = [];
    start = null;
  };

  const tokens = tokenize(source);
  let inArray = false;
  let array: (number | string)[] = [];
  let pendingArray: (number | string)[] | null = null;

  for (const token of tokens) {
    if (token.kind === 'open') {
      inArray = true;
      array = [];
      continue;
    }
    if (token.kind === 'close') {
      inArray = false;
      // The array is carried on its own, because the operand stack holds
      // scalars. Nothing is pushed for it: a marker on the stack would be read
      // as an operand by whatever operator came next.
      pendingArray = array;
      continue;
    }
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'name') {
      if (inArray) array.push(token.value);
      else operands.push(token.value);
      continue;
    }

    switch (token.value) {
      case 'q':
        stack.push({ ...state });
        break;
      case 'Q': {
        const restored = stack.pop();
        if (restored !== undefined) state = restored;
        break;
      }
      case 'cm': {
        const [a, b, c, d, e, f] = numbers(6);
        // CONCATENATED, not assigned. Assigning loses every nested transform.
        state.ctm = multiply(
          [a as number, b as number, c as number, d as number, e as number, f as number],
          state.ctm,
        );
        break;
      }
      case 'w':
        state.lineWidth = numbers(1)[0] as number;
        break;
      case 'g': {
        const [grey] = numbers(1);
        state.fill = { r: grey as number, g: grey as number, b: grey as number };
        break;
      }
      case 'G': {
        const [grey] = numbers(1);
        state.stroke = { r: grey as number, g: grey as number, b: grey as number };
        break;
      }
      case 'rg': {
        const [r, g, b] = numbers(3);
        state.fill = { r: r as number, g: g as number, b: b as number };
        break;
      }
      case 'RG': {
        const [r, g, b] = numbers(3);
        state.stroke = { r: r as number, g: g as number, b: b as number };
        break;
      }

      case 'm': {
        const [x, y] = numbers(2);
        const point = device(x as number, y as number);
        path.push({ op: 'move', x: point[0], y: point[1] });
        start = point;
        break;
      }
      case 'l': {
        const [x, y] = numbers(2);
        const point = device(x as number, y as number);
        path.push({ op: 'line', x: point[0], y: point[1] });
        break;
      }
      case 'c': {
        const [x1, y1, x2, y2, x, y] = numbers(6);
        const one = device(x1 as number, y1 as number);
        const two = device(x2 as number, y2 as number);
        const end = device(x as number, y as number);
        path.push({
          op: 'curve',
          x1: one[0], y1: one[1],
          x2: two[0], y2: two[1],
          x: end[0], y: end[1],
        });
        break;
      }
      case 'h':
        if (start !== null) path.push({ op: 'close' });
        break;
      case 're': {
        // Appends a closed rectangle SUBPATH. It does not paint: a renderer
        // that paints here fills every clipping rectangle it meets.
        const [x, y, w, h] = numbers(4);
        const a = device(x as number, y as number);
        const b = device((x as number) + (w as number), y as number);
        const c = device((x as number) + (w as number), (y as number) + (h as number));
        const d = device(x as number, (y as number) + (h as number));
        path.push(
          { op: 'move', x: a[0], y: a[1] },
          { op: 'line', x: b[0], y: b[1] },
          { op: 'line', x: c[0], y: c[1] },
          { op: 'line', x: d[0], y: d[1] },
          { op: 'close' },
        );
        start = a;
        break;
      }

      case 'f':
      case 'F':
      case 'f*':
        paint(true, false);
        break;
      case 'S':
        paint(false, true);
        break;
      case 's':
        path.push({ op: 'close' });
        paint(false, true);
        break;
      case 'B':
      case 'B*':
        paint(true, true);
        break;
      case 'b':
      case 'b*':
        path.push({ op: 'close' });
        paint(true, true);
        break;
      case 'n':
        // A path used for clipping and never painted. Discarded, not drawn.
        paint(false, false);
        break;

      case 'BT':
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const size = operands[operands.length - 1];
        const name = operands[operands.length - 2];
        fontSize = typeof size === 'number' ? size : 0;
        fontName = typeof name === 'string' ? name : fontName;
        break;
      }
      case 'TL':
        leading = numbers(1)[0] as number;
        break;
      case 'Td': {
        const [tx, ty] = numbers(2);
        lineMatrix = multiply([1, 0, 0, 1, tx as number, ty as number], lineMatrix);
        textMatrix = lineMatrix;
        break;
      }
      case 'TD': {
        const [tx, ty] = numbers(2);
        leading = -(ty as number);
        lineMatrix = multiply([1, 0, 0, 1, tx as number, ty as number], lineMatrix);
        textMatrix = lineMatrix;
        break;
      }
      case 'Tm': {
        const [a, b, c, d, e, f] = numbers(6);
        lineMatrix = [a as number, b as number, c as number, d as number, e as number, f as number];
        textMatrix = lineMatrix;
        break;
      }
      case 'T*':
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
        textMatrix = lineMatrix;
        break;

      case 'Tj':
      case "'":
      case '"': {
        if (token.value !== 'Tj') {
          lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
          textMatrix = lineMatrix;
        }
        const value = operands[operands.length - 1];
        if (typeof value === 'string') {
          items.push(textItem(value, textMatrix, state, fontSize, fontName, height));
        }
        break;
      }
      case 'TJ': {
        // Taken and CLEARED. Leaving it would let a later TJ with no array of
        // its own consume this one, which writes the previous line's text a
        // second time in a place nobody can account for.
        const carried = pendingArray ?? [];
        pendingArray = null;
        let text = '';
        for (const piece of carried) {
          // A NUMBER here is a kern in thousandths of an em, and it is
          // SUBTRACTED from the position. It is never content: a renderer that
          // appends it writes the kerning values into the page.
          if (typeof piece === 'string') text += piece;
        }
        if (text !== '') {
          items.push(textItem(text, textMatrix, state, fontSize, fontName, height));
        }
        break;
      }

      default:
        break;
    }

    operands.length = 0;
  }

  return { width, height, items };
}

function textItem(
  text: string,
  textMatrix: Matrix,
  state: GraphicsState,
  fontSize: number,
  fontName: string,
  height: number,
): DisplayItem {
  const combined = multiply(textMatrix, state.ctm);
  const [x, y] = apply(combined, 0, 0);
  // The vertical scale of the combined matrix, so text inside a scaled
  // transform comes out at the size it will actually appear.
  const scale = Math.hypot(combined[2], combined[3]) || 1;
  return {
    kind: 'text',
    text,
    x,
    y: height - y,
    size: fontSize * scale,
    font: fontName,
    colour: state.fill,
  };
}

/* -------------------------------------------------------------- a page -- */

/**
 * Render the first content stream that looks like a page.
 *
 * Deliberately simple about which stream is which: this engine does not resolve
 * the page tree, so it takes the streams in order. Where that is wrong it is
 * wrong VISIBLY - the wrong page renders - rather than silently, which is the
 * trade a from-scratch reader makes until the page tree is built.
 */
/** What makes a stream look like a page: a rectangle, a move, or shown text. */
const DRAWS = /\b(re|Tj|TJ|m)\b/;

export function renderPage(
  document: PdfDocument,
  index = 0,
  options: RenderOptions = {},
): RenderedPage | null {
  const streams: PdfObject[] = [];
  for (const object of document.objects) {
    if (object.stream === undefined) continue;
    // A compressed stream is skipped HERE rather than misread. Interpreting
    // its compressed bytes produces a page of noise that looks like a
    // rendering. `drawPage` below decompresses first and is what the
    // application uses; this synchronous path stays for callers that
    // already hold plain content.
    const text = decoder.decode(object.stream);
    if (DRAWS.test(text)) streams.push(object);
  }

  const chosen = streams[index];
  if (chosen === undefined || chosen.stream === undefined) return null;
  return renderContent(decoder.decode(chosen.stream), options);
}

export interface DrawResult {
  readonly page: RenderedPage | null;
  /**
   * Why nothing was drawn, when nothing was.
   *
   * A blank canvas with no explanation is the same defect as an empty text
   * panel with no explanation: a file whose pages are images and a file this
   * engine cannot decode look identical, and only one of them is a limitation
   * worth reporting.
   */
  readonly reason: string;
}

/**
 * Render a page, decompressing the content first.
 *
 * Asynchronous because the platform's decompressor is. Nearly every real PDF
 * deflates its content, so the synchronous path above draws almost nothing - it
 * stayed correct and stayed useless, which is the shape of gap that reads as a
 * working feature until somebody opens a file they did not make here.
 */
export async function drawPage(
  document: PdfDocument,
  index = 0,
  options: RenderOptions = {},
): Promise<DrawResult> {
  const sources: string[] = [];
  let images = 0;
  let refused: string | null = null;

  for (const object of document.objects) {
    if (object.stream === undefined) continue;
    const decoded = await decodeStream(object.body, object.stream);
    if (!decoded.ok) {
      if (decoded.notText) images += 1;
      else refused = refused ?? decoded.reason;
      continue;
    }
    const text = decoder.decode(decoded.bytes);
    if (DRAWS.test(text)) sources.push(text);
  }

  const chosen = sources[index];
  if (chosen !== undefined) return { page: renderContent(chosen, options), reason: '' };

  if (images > 0) {
    return {
      page: null,
      reason:
        'No page could be drawn. ' +
        images +
        (images === 1 ? ' stream in this file is an image' : ' streams in this file are images') +
        ', and this engine draws vector content rather than decoding pictures.',
    };
  }
  if (refused !== null) {
    return { page: null, reason: 'No page could be drawn. ' + refused };
  }
  return {
    page: null,
    reason: 'No page could be drawn. This file holds no content stream that draws anything.',
  };
}


/* --------------------------------------------------------- rasterizing -- */

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, row major. */
  readonly pixels: Uint8ClampedArray;
}

/**
 * Fill the paths of a display list into real pixels.
 *
 * DELIBERATELY PATHS ONLY. Text has no glyph outlines here - see the note at
 * the top - so drawing it would mean inventing a typeface. A caller that wants
 * text draws the display list on a canvas, which has fonts.
 *
 * This exists so a test can assert PIXELS rather than a list of coordinates. A
 * display list that is correct and a rasterizer that is wrong produce a blank
 * page, and only looking at pixels tells the two apart.
 */
export function rasterize(page: RenderedPage, scale = 1): Raster {
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const pixels = new Uint8ClampedArray(width * height * 4);

  // White, because a PDF page is white paper. Leaving it transparent makes
  // every comparison against a rendered reference fail on the background.
  pixels.fill(255);

  for (const item of page.items) {
    if (item.kind !== 'path' || item.fill === null) continue;

    const polygon = flatten(item.commands, scale);
    if (polygon.length < 3) continue;

    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of polygon) {
      if (point[1] < minY) minY = point[1];
      if (point[1] > maxY) maxY = point[1];
    }

    const from = Math.max(0, Math.floor(minY));
    const to = Math.min(height - 1, Math.ceil(maxY));

    for (let y = from; y <= to; y += 1) {
      // Scanline crossings at the pixel CENTRE. Sampling at the top edge makes
      // a rectangle one row taller than it is, which shows up as an off-by-one
      // nobody can find by reading the geometry.
      const sample = y + 0.5;
      const crossings: number[] = [];

      for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index] as readonly [number, number];
        const b = polygon[(index + 1) % polygon.length] as readonly [number, number];
        if (a[1] === b[1]) continue;
        const low = Math.min(a[1], b[1]);
        const high = Math.max(a[1], b[1]);
        if (sample < low || sample >= high) continue;
        crossings.push(a[0] + ((sample - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }

      crossings.sort((one, two) => one - two);
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const left = Math.max(0, Math.ceil((crossings[pair] as number) - 0.5));
        const right = Math.min(width - 1, Math.floor((crossings[pair + 1] as number) - 0.5));
        for (let x = left; x <= right; x += 1) {
          const at = (y * width + x) * 4;
          pixels[at] = Math.round(item.fill.r * 255);
          pixels[at + 1] = Math.round(item.fill.g * 255);
          pixels[at + 2] = Math.round(item.fill.b * 255);
          pixels[at + 3] = 255;
        }
      }
    }
  }

  return { width, height, pixels };
}

/** Curves to line segments, because a scanline fill needs edges. */
function flatten(commands: readonly PathCommand[], scale: number): readonly (readonly [number, number])[] {
  const points: (readonly [number, number])[] = [];
  let current: readonly [number, number] = [0, 0];

  for (const command of commands) {
    if (command.op === 'move' || command.op === 'line') {
      current = [command.x * scale, command.y * scale];
      points.push(current);
    } else if (command.op === 'curve') {
      const steps = 16;
      const from = current;
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const u = 1 - t;
        const x =
          u * u * u * from[0] +
          3 * u * u * t * command.x1 * scale +
          3 * u * t * t * command.x2 * scale +
          t * t * t * command.x * scale;
        const y =
          u * u * u * from[1] +
          3 * u * u * t * command.y1 * scale +
          3 * u * t * t * command.y2 * scale +
          t * t * t * command.y * scale;
        points.push([x, y]);
      }
      current = [command.x * scale, command.y * scale];
    }
    // `close` needs nothing: the fill treats the ring as closed already.
  }

  return points;
}

/** The pixel at a point, for a test that wants to assert one. */
export function pixelAt(raster: Raster, x: number, y: number): Colour & { a: number } {
  const at = (Math.round(y) * raster.width + Math.round(x)) * 4;
  return {
    r: raster.pixels[at] ?? 0,
    g: raster.pixels[at + 1] ?? 0,
    b: raster.pixels[at + 2] ?? 0,
    a: raster.pixels[at + 3] ?? 0,
  };
}
