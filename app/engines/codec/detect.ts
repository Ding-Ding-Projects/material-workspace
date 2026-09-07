/**
 * What kind of file is this, decided from its CONTENT.
 *
 * Never from the extension. A `.csv` that is really a zip is a spreadsheet
 * somebody renamed, and reading its binary as text produces a screen of
 * mojibake instead of an error anybody can act on. A `.txt` that is really a
 * Word document is the same failure with a different name.
 *
 * Inside a zip the four office formats are told apart by which parts they
 * contain, not by a magic number — they all begin with the same two bytes,
 * because they are all zips.
 */

import { readZip } from './zip';

export type DetectedFormat =
  | 'xlsx'
  | 'docx'
  | 'ods'
  | 'odt'
  | 'zip-unknown'
  | 'text';

const decoder = new TextDecoder();

/** The two bytes every zip begins with, plus the two that follow a real one. */
export function looksLikeZip(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    // 0x0304 is a local file header, 0x0506 an empty archive. Anything else
    // with the same first two bytes is not a zip we should try to open.
    ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))
  );
}

export async function detectFormat(bytes: Uint8Array): Promise<DetectedFormat> {
  if (!looksLikeZip(bytes.subarray(0, 4))) return 'text';

  let parts: Map<string, Uint8Array>;
  try {
    parts = await readZip(bytes);
  } catch {
    // A zip that will not open is not a text file either. Saying so lets the
    // caller report a real error rather than showing its bytes as characters.
    return 'zip-unknown';
  }

  // OpenDocument declares itself outright, which is the whole reason the
  // mimetype entry exists. Checked first because it is authoritative.
  const mimetype = parts.get('mimetype');
  if (mimetype !== undefined) {
    const declared = decoder.decode(mimetype).trim();
    if (declared === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
    if (declared === 'application/vnd.oasis.opendocument.text') return 'odt';
  }

  if (parts.has('xl/workbook.xml')) return 'xlsx';
  if (parts.has('word/document.xml')) return 'docx';

  // A well-formed OpenDocument without its mimetype entry. Malformed, but
  // recoverable: the body element says which it is.
  const content = parts.get('content.xml');
  if (content !== undefined) {
    const text = decoder.decode(content.subarray(0, 4096));
    if (text.includes('office:spreadsheet')) return 'ods';
    if (text.includes('office:text')) return 'odt';
  }

  return 'zip-unknown';
}

/** A human-readable name, for the message shown when a file cannot be opened. */
export function describeFormat(format: DetectedFormat): string {
  switch (format) {
    case 'xlsx':
      return 'an Excel workbook';
    case 'docx':
      return 'a Word document';
    case 'ods':
      return 'an OpenDocument spreadsheet';
    case 'odt':
      return 'an OpenDocument text document';
    case 'zip-unknown':
      return 'a zip archive of an unrecognised kind';
    default:
      return 'a text file';
  }
}
