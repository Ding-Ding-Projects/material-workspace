/**
 * Writing PDF.
 *
 * A PDF is a set of numbered objects, a cross-reference table saying where
 * each one starts in BYTES, and a trailer pointing at the catalogue. The
 * byte offsets are what make this awkward and are where a hand-rolled writer
 * usually goes wrong:
 *
 *   - THE OFFSETS ARE COUNTED IN BYTES, NOT CHARACTERS. Any non-ASCII text
 *     anywhere in the file shifts every later offset, and a reader that
 *     follows a wrong offset reports the file as damaged. So the document is
 *     assembled as bytes throughout and measured as bytes.
 *   - THE CROSS-REFERENCE TABLE IS FIXED-WIDTH. Every entry is exactly twenty
 *     bytes including its line ending. A shorter line makes every subsequent
 *     lookup land mid-entry, and the failure is a file that opens in one
 *     reader and not another.
 *   - OBJECT ZERO IS ALWAYS THE FREE-LIST HEAD, with generation 65535. It is
 *     not a real object and omitting it makes the table one entry short.
 *
 * The fonts are the fourteen standard ones, which every reader has built in.
 * Embedding a font is a much larger piece of work, and a PDF that depends on a
 * font the reader does not have renders in something else entirely.
 */

const encoder = new TextEncoder();

export type StandardFont =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Courier'
  | 'Courier-Bold';

export interface TextRun {
  readonly text: string;
  /** Points from the LEFT edge. */
  readonly x: number;
  /** Points from the BOTTOM edge, because that is where PDF's origin is. */
  readonly y: number;
  readonly size: number;
  readonly font: StandardFont;
}

export interface Line {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width?: number;
  readonly grey?: number;
}

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Absent means an outline. */
  readonly fillGrey?: number;
  readonly strokeGrey?: number;
}

export interface Page {
  /** Points. A4 is 595.28 by 841.89. */
  readonly width: number;
  readonly height: number;
  readonly runs: readonly TextRun[];
  readonly lines?: readonly Line[];
  readonly rectangles?: readonly Rectangle[];
}

export interface DocumentInfo {
  readonly title?: string;
  readonly author?: string;
  /** Fixed rather than read from the clock, so a build is reproducible. */
  readonly createdAt?: string;
}

export const A4 = { width: 595.28, height: 841.89 };
export const LETTER = { width: 612, height: 792 };

/**
 * Escape a string for a PDF literal.
 *
 * Backslash, and both parentheses. An unescaped closing parenthesis ends the
 * string early and every byte after it is read as operators, which produces a
 * file that opens to a blank page rather than an error.
 */
function escapeLiteral(text: string): string {
  let out = '';
  for (const character of text) {
    if (character === '\\' || character === '(' || character === ')') out += '\\' + character;
    else if (character === '\r') out += '\\r';
    else if (character === '\n') out += '\\n';
    else if (character.charCodeAt(0) > 255) {
      // Outside WinAnsi. A standard font cannot render it, and emitting the
      // byte anyway produces a wrong glyph rather than a missing one — so it
      // becomes a question mark, and the caller is told through
      // `unsupportedCharacters` below.
      out += '?';
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * Which characters this writer cannot render.
 *
 * Reported so a caller can say what an export dropped BEFORE it runs, rather
 * than producing a page of question marks and letting somebody discover it.
 */
export function unsupportedCharacters(pages: readonly Page[]): string[] {
  const found = new Set<string>();
  for (const page of pages) {
    for (const run of page.runs) {
      for (const character of run.text) {
        if (character.charCodeAt(0) > 255) found.add(character);
      }
    }
  }
  return [...found];
}

function contentStream(page: Page): string {
  const parts: string[] = [];

  for (const rectangle of page.rectangles ?? []) {
    parts.push('q');
    if (rectangle.fillGrey !== undefined) parts.push(rectangle.fillGrey.toFixed(3) + ' g');
    if (rectangle.strokeGrey !== undefined) parts.push(rectangle.strokeGrey.toFixed(3) + ' G');
    parts.push(
      [rectangle.x, rectangle.y, rectangle.width, rectangle.height]
        .map((value) => value.toFixed(2))
        .join(' ') + ' re',
    );
    parts.push(
      rectangle.fillGrey !== undefined && rectangle.strokeGrey !== undefined
        ? 'B'
        : rectangle.fillGrey !== undefined
          ? 'f'
          : 'S',
    );
    parts.push('Q');
  }

  for (const line of page.lines ?? []) {
    parts.push('q');
    parts.push((line.grey ?? 0).toFixed(3) + ' G');
    parts.push((line.width ?? 1).toFixed(2) + ' w');
    parts.push(line.x1.toFixed(2) + ' ' + line.y1.toFixed(2) + ' m');
    parts.push(line.x2.toFixed(2) + ' ' + line.y2.toFixed(2) + ' l');
    parts.push('S');
    parts.push('Q');
  }

  for (const run of page.runs) {
    if (run.text.length === 0) continue;
    parts.push('BT');
    parts.push('/' + fontResourceName(run.font) + ' ' + run.size.toFixed(2) + ' Tf');
    // Td positions from the CURRENT text line, so each run opens its own text
    // object. Reusing one object and offsetting would accumulate rounding
    // across a page.
    parts.push(run.x.toFixed(2) + ' ' + run.y.toFixed(2) + ' Td');
    parts.push('(' + escapeLiteral(run.text) + ') Tj');
    parts.push('ET');
  }

  return parts.join('\n');
}

function fontResourceName(font: StandardFont): string {
  return 'F' + STANDARD_FONTS.indexOf(font);
}

const STANDARD_FONTS: readonly StandardFont[] = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Courier',
  'Courier-Bold',
];

/**
 * Build the file.
 *
 * Assembled as an array of byte chunks and joined once, so the offset of each
 * object is the running byte length rather than a character count.
 */
export function writePdf(pages: readonly Page[], info: DocumentInfo = {}): Uint8Array {
  if (pages.length === 0) {
    throw new RangeError('a PDF must have at least one page');
  }

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (text: string): void => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    length += bytes.length;
  };

  const beginObject = (number: number): void => {
    // Recorded BEFORE the object is written, because the cross-reference table
    // points at the first byte of "N 0 obj".
    offsets[number] = length;
    push(number + ' 0 obj\n');
  };

  push('%PDF-1.7\n');
  // A comment of high bytes, which tells a transfer program the file is
  // binary. Without it a naive text-mode copy rewrites the line endings and
  // every offset in the file becomes wrong.
  chunks.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  length += 6;

  // Object numbering, fixed so the references below can be written directly:
  //   1 catalogue, 2 page tree, 3 info, 4..(3+n) pages,
  //   (4+n)..(3+2n) content streams, then the fonts.
  const pageCount = pages.length;
  const firstPage = 4;
  const firstContent = firstPage + pageCount;
  const firstFont = firstContent + pageCount;

  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  push(
    '<< /Type /Pages /Count ' +
      pageCount +
      ' /Kids [' +
      pages.map((_, index) => firstPage + index + ' 0 R').join(' ') +
      '] >>\nendobj\n',
  );

  beginObject(3);
  push(
    '<< /Producer (Material Workspace)' +
      (info.title === undefined ? '' : ' /Title (' + escapeLiteral(info.title) + ')') +
      (info.author === undefined ? '' : ' /Author (' + escapeLiteral(info.author) + ')') +
      (info.createdAt === undefined ? '' : ' /CreationDate (' + escapeLiteral(info.createdAt) + ')') +
      ' >>\nendobj\n',
  );

  const fontResources = STANDARD_FONTS.map(
    (font, index) => '/' + fontResourceName(font) + ' ' + (firstFont + index) + ' 0 R',
  ).join(' ');

  pages.forEach((page, index) => {
    beginObject(firstPage + index);
    push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
        page.width.toFixed(2) +
        ' ' +
        page.height.toFixed(2) +
        '] /Resources << /Font << ' +
        fontResources +
        ' >> >> /Contents ' +
        (firstContent + index) +
        ' 0 R >>\nendobj\n',
    );
  });

  pages.forEach((page, index) => {
    const content = contentStream(page);
    const contentBytes = encoder.encode(content);
    beginObject(firstContent + index);
    // The declared length is the BYTE length of the stream. A character count
    // truncates the stream on any page containing non-ASCII text.
    push('<< /Length ' + contentBytes.length + ' >>\nstream\n');
    chunks.push(contentBytes);
    length += contentBytes.length;
    push('\nendstream\nendobj\n');
  });

  STANDARD_FONTS.forEach((font, index) => {
    beginObject(firstFont + index);
    push(
      '<< /Type /Font /Subtype /Type1 /BaseFont /' +
        font +
        ' /Encoding /WinAnsiEncoding >>\nendobj\n',
    );
  });

  const objectCount = firstFont + STANDARD_FONTS.length;
  const xrefOffset = length;

  push('xref\n');
  push('0 ' + objectCount + '\n');
  // Object zero is the head of the free list, generation 65535. It is not a
  // real object, and omitting it makes every lookup one entry out.
  push('0000000000 65535 f \n');
  for (let number = 1; number < objectCount; number += 1) {
    const offset = offsets[number] ?? 0;
    // Exactly twenty bytes per entry, including the trailing space and
    // newline. A shorter line makes every later lookup land mid-entry.
    push(String(offset).padStart(10, '0') + ' 00000 n \n');
  }

  push(
    'trailer\n<< /Size ' +
      objectCount +
      ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' +
      xrefOffset +
      '\n%%EOF\n',
  );

  const output = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

/**
 * Widths for the standard fonts, as thousandths of the point size.
 *
 * Enough to lay text out without measuring it in a browser, which the main
 * process cannot do. These are the real Adobe metrics for the characters that
 * occur in ordinary prose; anything else falls back to the average, which is
 * close enough for wrapping and is stated rather than hidden.
 */
const HELVETICA_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

const AVERAGE_WIDTH = 500;

/** Width of a string in points. Bold and monospace are scaled from Helvetica. */
export function measureText(text: string, size: number, font: StandardFont): number {
  const scale = font.startsWith('Courier') ? 0 : font.includes('Bold') ? 1.05 : 1;
  let thousandths = 0;
  for (const character of text) {
    // Courier is monospaced at exactly 600, so it needs no table at all.
    thousandths += scale === 0 ? 600 : (HELVETICA_WIDTHS[character] ?? AVERAGE_WIDTH) * scale;
  }
  return (thousandths * size) / 1000;
}

/**
 * Break text into lines that fit a width.
 *
 * Breaks between CJK characters as well as at spaces, for the same reason the
 * text engine does: a Chinese paragraph has no spaces and is otherwise one
 * unbreakable token that runs straight off the page.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  font: StandardFont,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    const tokens = paragraph.match(/[\u3000-\u9fff\uf900-\ufaff]|[^\s\u3000-\u9fff\uf900-\ufaff]+|\s+/gu) ?? [];

    for (const token of tokens) {
      const candidate = current + token;
      if (measureText(candidate, size, font) <= maxWidth || current.length === 0) {
        current = candidate;
        continue;
      }
      lines.push(current.trimEnd());
      current = /^\s+$/.test(token) ? '' : token;
    }
    lines.push(current.trimEnd());
  }

  return lines;
}
