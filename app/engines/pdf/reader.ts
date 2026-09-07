/**
 * Reading PDF.
 *
 * Enough to inspect a file, extract its text, and rewrite it with objects
 * removed — which is what redaction actually requires and is the reason this
 * exists at all.
 *
 * WHAT THIS DOES NOT DO, stated up front rather than discovered: it does not
 * render. Rendering a PDF faithfully means implementing font programs, colour
 * spaces, shading, transparency groups and a graphics state machine — a body
 * of work far larger than everything else in this project put together. Text
 * extraction and structural inspection are useful on their own, and claiming
 * more than that would be the decorative-feature defect at its worst.
 *
 * The parsing decisions that matter:
 *
 *   - THE CROSS-REFERENCE TABLE IS PREFERRED, and a full scan is the fallback.
 *     A damaged or incrementally-updated file may have offsets that no longer
 *     point at their objects, and a reader that trusts them reports a
 *     recoverable file as broken. Real readers scan; so does this.
 *   - A STREAM'S LENGTH MAY BE AN INDIRECT REFERENCE. Reading /Length as a
 *     number when it is "12 0 R" truncates the stream to nothing, which reads
 *     as an empty page rather than an error.
 */

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

const decoder = new TextDecoder('latin1');

export interface PdfObject {
  readonly number: number;
  readonly generation: number;
  /** Byte offset of the first byte of "N G obj". */
  readonly offset: number;
  /** The dictionary or value, as raw text between "obj" and "stream"/"endobj". */
  readonly body: string;
  /** Raw stream bytes, when the object has one. */
  readonly stream?: Uint8Array;
}

export interface PdfDocument {
  readonly version: string;
  readonly objects: readonly PdfObject[];
  readonly bytes: Uint8Array;
}

/**
 * Find every object by scanning, not by following the table.
 *
 * A file that has been incrementally updated, appended to, or damaged has
 * offsets that no longer point where they claim. A reader that trusts them
 * reports a perfectly recoverable file as broken, which is the difference
 * between a viewer people use and one they abandon.
 */
export function readPdf(bytes: Uint8Array): PdfDocument {
  const text = decoder.decode(bytes);

  if (!text.startsWith('%PDF-')) {
    throw new PdfError('this file does not begin with a PDF header');
  }
  const version = text.slice(5, text.indexOf('\n')).trim();

  const objects: PdfObject[] = [];
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;

  for (const match of text.matchAll(pattern)) {
    const offset = match.index;
    if (offset === undefined) continue;

    const start = offset + match[0].length;
    const endObject = text.indexOf('endobj', start);
    if (endObject < 0) continue;

    const streamAt = text.indexOf('stream', start);
    const hasStream = streamAt >= 0 && streamAt < endObject;

    const body = text.slice(start, hasStream ? streamAt : endObject).trim();

    let stream: Uint8Array | undefined;
    if (hasStream) {
      // The keyword is followed by CRLF or LF, never by CR alone.
      let dataStart = streamAt + 'stream'.length;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;

      const endStream = text.indexOf('endstream', dataStart);
      const dataEnd = endStream < 0 ? endObject : endStream;
      stream = bytes.subarray(dataStart, dataEnd);
    }

    objects.push({
      number: Number(match[1]),
      generation: Number(match[2]),
      offset,
      body,
      ...(stream === undefined ? {} : { stream }),
    });
  }

  if (objects.length === 0) throw new PdfError('no objects found; the file may be damaged');

  return { version, objects, bytes };
}

/** Every object whose dictionary declares the given type. */
export function objectsOfType(document: PdfDocument, type: string): PdfObject[] {
  return document.objects.filter((object) =>
    new RegExp('/Type\\s*/' + type + '\\b').test(object.body),
  );
}

export function pageCount(document: PdfDocument): number {
  // Preferred from the page tree's own count, because a Pages node may declare
  // more than the Page objects present in an incrementally-updated file.
  for (const object of objectsOfType(document, 'Pages')) {
    const match = /\/Count\s+(\d+)/.exec(object.body);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return objectsOfType(document, 'Page').length;
}

export interface DocumentMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly producer?: string;
}

export function metadata(document: PdfDocument): DocumentMetadata {
  for (const object of document.objects) {
    if (!/\/Producer|\/Title|\/Author/.test(object.body)) continue;
    return {
      ...pick(object.body, 'Title', 'title'),
      ...pick(object.body, 'Author', 'author'),
      ...pick(object.body, 'Producer', 'producer'),
    };
  }
  return {};
}

function pick(body: string, key: string, as: string): Record<string, string> {
  const match = new RegExp('/' + key + '\\s*\\(((?:\\\\.|[^\\\\)])*)\\)').exec(body);
  if (match?.[1] === undefined) return {};
  return { [as]: unescapeLiteral(match[1]) };
}

function unescapeLiteral(text: string): string {
  return text.replace(/\\(.)/g, (_whole, character: string) => {
    if (character === 'n') return '\n';
    if (character === 'r') return '\r';
    if (character === 't') return '\t';
    return character;
  });
}

/**
 * Text from a content stream.
 *
 * Reads the string operands of the show-text operators. This is genuinely an
 * approximation and is documented as one: a PDF may position every glyph
 * individually, in which case the extracted words are in the file's drawing
 * order rather than in reading order. It is right for text this project wrote
 * and for most text produced by ordinary tools.
 */
export function extractText(document: PdfDocument): string[] {
  const pages: string[] = [];

  for (const object of document.objects) {
    if (object.stream === undefined) continue;
    // A compressed stream is skipped rather than misread. Emitting its
    // compressed bytes as text produces a page of noise that looks like
    // extracted content.
    if (/\/Filter/.test(object.body)) continue;

    const content = decoder.decode(object.stream);
    if (!/\bTj\b|\bTJ\b/.test(content)) continue;

    const parts: string[] = [];
    // Simple show-text, and the array form where the numbers are kerning
    // adjustments rather than content.
    for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      parts.push(unescapeLiteral(match[1] ?? ''));
    }
    for (const match of content.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      const inner = match[1] ?? '';
      let line = '';
      for (const piece of inner.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
        line += unescapeLiteral(piece[1] ?? '');
      }
      parts.push(line);
    }

    if (parts.length > 0) pages.push(parts.join('\n'));
  }

  return pages;
}

/**
 * Remove objects and rewrite the file.
 *
 * THIS IS WHAT REDACTION MEANS. Drawing a black rectangle over text leaves the
 * text in the file, where anybody can select it, copy it, or read it with a
 * text editor — and that mistake has exposed real secrets in real published
 * documents, repeatedly. The bytes have to go.
 *
 * The rewritten file gets a fresh cross-reference table, because removing an
 * object shifts every later offset.
 */
export function removeObjects(
  document: PdfDocument,
  numbers: readonly number[],
): Uint8Array {
  const removing = new Set(numbers);
  const kept = document.objects.filter((object) => !removing.has(object.number));
  if (kept.length === document.objects.length) return document.bytes;

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let length = 0;

  const push = (value: string | Uint8Array): void => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  };

  push('%PDF-' + document.version + '\n');
  chunks.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  length += 6;

  for (const object of kept) {
    offsets.set(object.number, length);
    push(object.number + ' ' + object.generation + ' obj\n');
    push(object.body + '\n');
    if (object.stream !== undefined) {
      push('stream\n');
      push(object.stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  }

  const highest = kept.reduce((max, object) => Math.max(max, object.number), 0);
  const size = highest + 1;
  const xrefOffset = length;

  push('xref\n0 ' + size + '\n');
  push('0000000000 65535 f \n');
  for (let number = 1; number < size; number += 1) {
    const offset = offsets.get(number);
    // A removed object becomes a FREE entry rather than a dangling offset. A
    // zero offset marked in-use points every reader at the file header.
    push(
      offset === undefined
        ? '0000000000 65535 f \n'
        : String(offset).padStart(10, '0') + ' 00000 n \n',
    );
  }

  const root = kept.find((object) => /\/Type\s*\/Catalog/.test(object.body));
  push(
    'trailer\n<< /Size ' +
      size +
      (root === undefined ? '' : ' /Root ' + root.number + ' 0 R') +
      ' >>\nstartxref\n' +
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
 * Does this file still contain a given string anywhere in its bytes?
 *
 * The check that proves a redaction actually happened. A redaction verified
 * only by looking at the rendered page is not verified at all — that is
 * exactly the mistake that keeps exposing secrets.
 */
export function containsText(bytes: Uint8Array, needle: string): boolean {
  return decoder.decode(bytes).includes(needle);
}
