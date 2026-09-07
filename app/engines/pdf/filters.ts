/**
 * PDF stream filters.
 *
 * Nearly every PDF produced by anything deflates its content streams, so a
 * reader that skips compressed streams reads almost no real files at all. It
 * does not fail while doing it, either: it returns an empty page and reports
 * success, which is the worst shape a gap can take.
 *
 * SIX THINGS THAT MAKE A DECODED STREAM LOOK RIGHT AND BE WRONG.
 *
 *   - A FILTER CHAIN IS ORDERED. `/Filter [/ASCII85Decode /FlateDecode]` means
 *     ASCII85 first and then Flate. Applying them the other way round produces
 *     bytes that are not merely wrong, they decode without complaint.
 *
 *   - FLATEDECODE IS ZLIB, NOT RAW DEFLATE. The two differ by a two-byte
 *     header, and a raw inflate of a zlib stream consumes that header as data
 *     and returns garbage. Some producers genuinely emit raw anyway, so both
 *     are tried - zlib first, because that is what the specification says.
 *
 *   - A PREDICTOR IS NOT A FILTER. It lives in `/DecodeParms` and is applied
 *     AFTER decompression. Ignoring it gives bytes that inflate perfectly and
 *     are still wrong, every row off by the row before it.
 *
 *   - AN IMAGE FILTER IS NOT A FAILURE. `/DCTDecode` is a JPEG; there is no
 *     text in it to extract. Calling that an error makes a normal document
 *     look broken, so it is reported as what it is.
 *
 *   - AN UNKNOWN FILTER MUST BE NAMED. Returning the compressed bytes and
 *     letting the caller treat them as text produces a page of noise that
 *     looks exactly like extracted content.
 *
 *   - CORRUPT DATA THROWS, AND THE THROW MUST BE CAUGHT. A truncated stream is
 *     common in a damaged file, and one bad object must not take the whole
 *     document down with it.
 */

export interface DecodedStream {
  readonly ok: true;
  readonly bytes: Uint8Array;
  /** The filters that were applied, in the order they were applied. */
  readonly applied: readonly string[];
}

export interface UndecodedStream {
  readonly ok: false;
  /** Said in words, naming the filter, so a caller can report it honestly. */
  readonly reason: string;
  /** True when the stream is fine and simply is not text - an image, say. */
  readonly notText: boolean;
}

export type StreamResult = DecodedStream | UndecodedStream;

/** Filters that carry image data. Not an error; there is just no text in one. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

/**
 * The filter names on an object, in application order.
 *
 * Both forms are real: a single name, and an array. A reader that handles only
 * the array form silently skips every single-filter stream, which is most of
 * them.
 */
export function filterNames(body: string): string[] {
  const array = /\/Filter\s*\[([^\]]*)\]/.exec(body);
  if (array !== null) {
    return [...(array[1] ?? '').matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1] as string);
  }
  const single = /\/Filter\s*\/([A-Za-z0-9]+)/.exec(body);
  return single === null ? [] : [single[1] as string];
}

/** The predictor parameters, when there are any. */
export function predictorFor(body: string): { predictor: number; columns: number; colors: number } {
  const predictor = Number(/\/Predictor\s+([0-9]+)/.exec(body)?.[1] ?? '1');
  const columns = Number(/\/Columns\s+([0-9]+)/.exec(body)?.[1] ?? '1');
  const colors = Number(/\/Colors\s+([0-9]+)/.exec(body)?.[1] ?? '1');
  return { predictor, columns, colors };
}

// ------------------------------------------------------------- the filters --

/**
 * Hexadecimal, ending at the `>`.
 *
 * An odd number of digits is not a corrupt file: the specification says the
 * final digit is paired with a zero, and refusing it would reject valid files.
 */
export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high: number | null = null;
  for (const byte of data) {
    const character = String.fromCharCode(byte);
    if (character === '>') break;
    const digit = parseInt(character, 16);
    if (Number.isNaN(digit)) continue;
    if (high === null) high = digit;
    else {
      out.push(high * 16 + digit);
      high = null;
    }
  }
  if (high !== null) out.push(high * 16);
  return Uint8Array.from(out);
}

/**
 * ASCII85, the `z` shorthand included.
 *
 * `z` stands for four zero bytes and appears constantly in real files. A
 * decoder that treats it as an ordinary character produces output that is the
 * right kind of wrong: mostly correct, with holes.
 */
export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];

  const flush = (count: number): void => {
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    for (let index = 0; index < count - 1; index += 1) out.push(bytes[index] as number);
    group.length = 0;
  };

  for (let index = 0; index < data.length; index += 1) {
    const character = String.fromCharCode(data[index] as number);
    if (character === '~') break;
    if (/\s/.test(character)) continue;
    if (character === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const value = data[index] as number;
    if (value < 33 || value > 117) continue;
    group.push(value - 33);
    if (group.length === 5) flush(5);
  }
  if (group.length > 0) flush(group.length);
  return Uint8Array.from(out);
}

/** Run length: a byte under 128 means a literal run, over means a repeat. */
export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < data.length) {
    const length = data[index] as number;
    index += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let step = 0; step <= length; step += 1) {
        if (index < data.length) out.push(data[index] as number);
        index += 1;
      }
    } else {
      const byte = data[index] as number;
      index += 1;
      for (let step = 0; step < 257 - length; step += 1) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Inflate, zlib first and raw as the fallback.
 *
 * The platform's own decompressor rather than one written here: a hand-rolled
 * inflate is a large amount of code to get subtly wrong, and it would be the
 * only copy of it in the project.
 */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this platform provides no DecompressionStream');
  }

  const attempt = async (format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(
      new DecompressionStream(format),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  try {
    return await attempt('deflate');
  } catch {
    // Some producers emit raw deflate despite the specification. Trying it is
    // cheap; guessing which one from the first byte is not reliable.
    return attempt('deflate-raw');
  }
}

/**
 * Undo a PNG predictor.
 *
 * Each row carries a leading filter byte naming how it was transformed against
 * the row above. Dropping the filter byte and keeping the rest - the obvious
 * shortcut - gives data that is exactly one byte narrower per row and wrong
 * everywhere.
 */
export function undoPngPredictor(data: Uint8Array, columns: number, colors: number): Uint8Array {
  const bytesPerPixel = Math.max(1, colors);
  const rowLength = columns * bytesPerPixel;
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);

  let previous = new Uint8Array(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const start = row * (rowLength + 1);
    const type = data[start] as number;
    const current = new Uint8Array(rowLength);

    for (let index = 0; index < rowLength; index += 1) {
      const raw = data[start + 1 + index] ?? 0;
      const left = index >= bytesPerPixel ? (current[index - bytesPerPixel] as number) : 0;
      const up = previous[index] as number;
      const upLeft = index >= bytesPerPixel ? (previous[index - bytesPerPixel] as number) : 0;

      let value = raw;
      if (type === 1) value = raw + left;
      else if (type === 2) value = raw + up;
      else if (type === 3) value = raw + Math.floor((left + up) / 2);
      else if (type === 4) {
        // Paeth: the neighbour whose prediction is closest.
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpLeft = Math.abs(estimate - upLeft);
        value =
          raw +
          (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
            ? left
            : distanceUp <= distanceUpLeft
              ? up
              : upLeft);
      }
      current[index] = value & 255;
    }

    out.set(current, row * rowLength);
    previous = current;
  }

  return out;
}

// -------------------------------------------------------------- the chain --

/**
 * Decode one object's stream, applying its whole filter chain in order.
 *
 * Returns a refusal rather than throwing, because one damaged object in a
 * long document should cost that object and not the document.
 */
export async function decodeStream(
  body: string,
  stream: Uint8Array | undefined,
): Promise<StreamResult> {
  if (stream === undefined) {
    return { ok: false, reason: 'the object carries no stream', notText: false };
  }

  const names = filterNames(body);
  if (names.length === 0) return { ok: true, bytes: stream, applied: [] };

  const image = names.find((name) => IMAGE_FILTERS.has(name));
  if (image !== undefined) {
    return {
      ok: false,
      reason: image + ' carries image data, so there is no text in it',
      notText: true,
    };
  }

  let bytes = stream;
  const applied: string[] = [];

  for (const name of names) {
    try {
      if (name === 'FlateDecode') bytes = await inflate(bytes);
      else if (name === 'ASCIIHexDecode') bytes = asciiHexDecode(bytes);
      else if (name === 'ASCII85Decode') bytes = ascii85Decode(bytes);
      else if (name === 'RunLengthDecode') bytes = runLengthDecode(bytes);
      else {
        return {
          ok: false,
          reason: 'the filter ' + name + ' is not supported, so the stream was left alone',
          notText: false,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason:
          name + ' failed on this stream: ' + (error instanceof Error ? error.message : 'unknown'),
        notText: false,
      };
    }
    applied.push(name);
  }

  const { predictor, columns, colors } = predictorFor(body);
  if (predictor >= 10) {
    bytes = undoPngPredictor(bytes, columns, colors);
    applied.push('PNG predictor ' + predictor);
  }

  return { ok: true, bytes, applied };
}
