/**
 * ZIP, because every modern office format is one.
 *
 * `.xlsx`, `.docx`, `.pptx`, `.odt`, `.ods` and `.odp` are all ZIP archives of
 * XML. There is no reading any of them without this.
 *
 * DESIGN DECISIONS, each with a reason:
 *
 *   - READING supports both stored and deflated entries. Real files from real
 *     applications are deflated, so store-only reading would open almost
 *     nothing.
 *   - WRITING emits stored entries only. The cost is size; the benefit is that
 *     one implementation works identically in the main process and the
 *     renderer with no compression library and no split code path. A stored
 *     ZIP is a perfectly valid ZIP and every consumer opens it. The size cost
 *     is stated in the documentation rather than hidden.
 *   - DECOMPRESSION USES THE PLATFORM. `DecompressionStream('deflate-raw')`
 *     exists in both Node and Chromium, so there is exactly one code path and
 *     no vendored inflate to go subtly wrong on one of them.
 *
 * The central directory is what is read, never the local headers. A local
 * header may carry zeroed sizes with the real values in a trailing data
 * descriptor, so walking local headers works on files produced by some writers
 * and silently mis-reads files produced by others.
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Bounds, so a hostile archive cannot exhaust memory. */
export interface ZipReadOptions {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_MAX_TOTAL = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRY = 64 * 1024 * 1024;

const SIGNATURE_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SIGNATURE_CENTRAL_FILE = 0x02014b50;
const SIGNATURE_LOCAL_FILE = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

/**
 * Find the end-of-central-directory record.
 *
 * Searched BACKWARDS from the end, because the record sits last and its
 * signature can also occur inside compressed data — scanning forwards finds a
 * false positive on any archive whose content happens to contain those four
 * bytes, which for a large archive is close to certain.
 *
 * The comment field can be up to 65535 bytes, so the search window is bounded
 * by that plus the record size rather than by the whole file.
 */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = 22;
  if (bytes.length < minimum) throw new ZipError('too short to be a zip archive');

  const searchFrom = Math.max(0, bytes.length - (minimum + 0xffff));
  for (let offset = bytes.length - minimum; offset >= searchFrom; offset -= 1) {
    if (readUint32(view, offset) === SIGNATURE_END_OF_CENTRAL_DIRECTORY) {
      // Confirm the comment length matches the remaining bytes, so a false
      // signature inside data is rejected rather than followed.
      const commentLength = readUint16(view, offset + 20);
      if (offset + minimum + commentLength === bytes.length) return offset;
    }
  }
  throw new ZipError('no end-of-central-directory record; not a zip archive');
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // One code path for Node and the renderer. Both provide this.
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('this platform provides no DecompressionStream');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Read an archive into named entries.
 *
 * Async because inflation is. Callers that only need one entry still pay for
 * the whole archive here; a lazy variant is worth adding when a real file
 * makes that cost visible, and not before.
 */
export async function readZip(
  bytes: Uint8Array,
  options: ZipReadOptions = {},
): Promise<Map<string, Uint8Array>> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  const maxEntry = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(bytes);

  const entryCount = readUint16(view, end + 10);
  const directoryOffset = readUint32(view, end + 16);

  if (entryCount > maxEntries) {
    throw new ZipError('archive declares ' + entryCount + ' entries, over the limit');
  }

  const result = new Map<string, Uint8Array>();
  let cursor = directoryOffset;
  let total = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length) throw new ZipError('central directory is truncated');
    if (readUint32(view, cursor) !== SIGNATURE_CENTRAL_FILE) {
      throw new ZipError('central directory entry ' + index + ' has a bad signature');
    }

    const method = readUint16(view, cursor + 10);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localOffset = readUint32(view, cursor + 42);

    if (uncompressedSize > maxEntry) {
      throw new ZipError('an entry declares ' + uncompressedSize + ' bytes, over the limit');
    }
    total += uncompressedSize;
    if (total > maxTotal) {
      throw new ZipError('archive expands past the total byte limit');
    }

    const name = new TextDecoder().decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    // Path traversal. An archive can name an entry so that writing it escapes
    // the destination directory. Nothing here writes to disk, but a caller
    // might, and refusing at the reader is where it costs nothing.
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw new ZipError('entry name is unsafe: ' + name);
    }

    cursor += 46 + nameLength + extraLength + commentLength;

    // Read the LOCAL header only for its variable-length fields, which is the
    // one thing it is reliable for. Sizes come from the central directory.
    if (localOffset + 30 > bytes.length) throw new ZipError('local header is out of range');
    if (readUint32(view, localOffset) !== SIGNATURE_LOCAL_FILE) {
      throw new ZipError('local header for ' + name + ' has a bad signature');
    }
    const localNameLength = readUint16(view, localOffset + 26);
    const localExtraLength = readUint16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new ZipError('entry data for ' + name + ' is truncated');

    const raw = bytes.subarray(dataStart, dataEnd);

    if (method === METHOD_STORE) {
      result.set(name, raw.slice());
    } else if (method === METHOD_DEFLATE) {
      const inflated = await inflateRaw(raw);
      if (inflated.length !== uncompressedSize) {
        throw new ZipError(
          'entry ' + name + ' inflated to ' + inflated.length + ', expected ' + uncompressedSize,
        );
      }
      result.set(name, inflated);
    } else {
      throw new ZipError('entry ' + name + ' uses unsupported method ' + method);
    }
  }

  return result;
}

/**
 * CRC-32, which the format requires and consumers check.
 *
 * The table is built once. Writing zero here produces an archive that some
 * readers accept and others reject as corrupt, which is the worst of both.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Write a stored archive.
 *
 * Stored rather than deflated. See the note at the top: the cost is size, the
 * benefit is one code path with no compression dependency, and every consumer
 * opens a stored ZIP.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, SIGNATURE_LOCAL_FILE, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0x0800, true); // flags: names are UTF-8
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint16(10, 0, true); // time
    localView.setUint16(12, 0x21, true); // date: 1 Jan 1980, the format's epoch
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIGNATURE_CENTRAL_FILE, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, METHOD_STORE, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x21, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, SIGNATURE_END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const totalSize = offset + centralSize + endRecord.length;
  const output = new Uint8Array(totalSize);
  let write = 0;
  for (const part of locals) {
    output.set(part, write);
    write += part.length;
  }
  for (const part of centrals) {
    output.set(part, write);
    write += part.length;
  }
  output.set(endRecord, write);
  return output;
}
