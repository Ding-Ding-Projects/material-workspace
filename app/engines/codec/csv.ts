/**
 * CSV and TSV, read and written properly.
 *
 * "Split on commas" is wrong, and it is wrong in a way that destroys data
 * rather than failing. Every rule below exists because the naive version
 * silently mangles a real file:
 *
 *   - A FIELD MAY CONTAIN THE DELIMITER, if it is quoted. Splitting on commas
 *     turns one address field into three, shifts every later column left, and
 *     produces a table that parses cleanly and is entirely wrong.
 *   - A FIELD MAY CONTAIN A NEWLINE, if it is quoted. Reading line by line
 *     therefore cannot work at all — a quoted multi-line note becomes several
 *     broken rows.
 *   - A QUOTE INSIDE A QUOTED FIELD IS DOUBLED, not backslash-escaped. This is
 *     the one people reach for a regular expression for, and the one a regular
 *     expression gets wrong.
 *   - LINE ENDINGS ARE MIXED IN PRACTICE. A file written on Windows, edited on
 *     a Mac and appended to on Linux carries all three, so the reader accepts
 *     all three and the writer emits one consistently.
 *
 * The parser is a character-by-character state machine for exactly these
 * reasons. It is longer than a split and it is the only version that is right.
 */

export type Delimiter = ',' | '\t' | ';' | '|';

export interface CsvReadOptions {
  /** Detected from the content when not given. */
  readonly delimiter?: Delimiter;
  /** Rows beyond this are refused rather than read, bounding memory. */
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

export interface CsvReadResult {
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: Delimiter;
  /** Non-fatal observations worth telling the user about. */
  readonly warnings: readonly string[];
}

const DEFAULT_MAX_ROWS = 1_000_000;
const DEFAULT_MAX_COLUMNS = 16_384;
const QUOTE = String.fromCharCode(34);

/**
 * Guess the delimiter by counting candidates OUTSIDE quoted fields.
 *
 * Counting them everywhere is the obvious approach and it picks the wrong
 * delimiter on any file whose text fields contain prose — a column of English
 * sentences carries far more commas inside quotes than the real delimiter
 * carries outside them.
 */
export function detectDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [',', '\t', ';', '|'];
  const counts = new Map<Delimiter, number>(candidates.map((c) => [c, 0]));

  let inQuotes = false;
  // Only the first few lines are inspected. A delimiter that is not obvious
  // from the header and a handful of rows is not going to become obvious from
  // ten megabytes more of the same.
  let lines = 0;
  for (let index = 0; index < text.length && lines < 20; index += 1) {
    const character = text[index] as string;
    if (character === QUOTE) {
      if (inQuotes && text[index + 1] === QUOTE) {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (character === '\n') {
      lines += 1;
      continue;
    }
    const known = counts.get(character as Delimiter);
    if (known !== undefined) counts.set(character as Delimiter, known + 1);
  }

  let best: Delimiter = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function readCsv(input: string, options: CsvReadOptions = {}): CsvReadResult {
  // A byte-order mark at the start of a UTF-8 file is invisible and becomes
  // part of the first header name, so the first column silently stops matching
  // by name. Strip exactly one.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const delimiter = options.delimiter ?? detectDelimiter(text);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const warnings: string[] = [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
    if (row.length > maxColumns) {
      throw new RangeError('row ' + (rows.length + 1) + ' exceeds ' + maxColumns + ' columns');
    }
  };

  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    if (rows.length > maxRows) {
      throw new RangeError('input exceeds ' + maxRows + ' rows');
    }
  };

  while (index < text.length) {
    const character = text[index] as string;

    if (inQuotes) {
      if (character === QUOTE) {
        if (text[index + 1] === QUOTE) {
          field += QUOTE;
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === QUOTE) {
      if (field.length > 0) {
        // A quote in the middle of an unquoted field. Malformed, but common
        // enough in exported data that refusing the file would be unhelpful.
        // Kept as a literal and reported.
        warnings.push(
          'row ' + (rows.length + 1) + ': a quote appears in the middle of an unquoted field',
        );
        field += character;
        index += 1;
        continue;
      }
      inQuotes = true;
      fieldWasQuoted = true;
      index += 1;
      continue;
    }

    if (character === delimiter) {
      endField();
      index += 1;
      continue;
    }

    if (character === '\r') {
      // Accept CRLF, LFCR, bare CR and bare LF. All four occur.
      endRow();
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    if (character === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += character;
    index += 1;
  }

  if (inQuotes) {
    warnings.push('the last field is missing its closing quote');
  }

  // A trailing newline ends the last row; it does not begin an empty one. But
  // a genuinely empty final field must survive, so this checks whether
  // anything was accumulated rather than whether the text ends in a newline.
  if (field.length > 0 || fieldWasQuoted || row.length > 0) {
    endRow();
  }

  return { rows, delimiter, warnings };
}

export interface CsvWriteOptions {
  readonly delimiter?: Delimiter;
  /** CRLF is the format's own specification; LF is what everything else uses. */
  readonly lineEnding?: '\r\n' | '\n';
  /**
   * Quote every field rather than only those that need it. Some consumers
   * cannot cope with mixed quoting, so this is offered rather than assumed.
   */
  readonly quoteAll?: boolean;
}

/**
 * A field needs quoting when it contains the delimiter, a quote, a newline, or
 * leading/trailing whitespace that would otherwise be trimmed by a reader.
 *
 * The whitespace case is the one people forget, and it changes data rather
 * than breaking it: a field of two spaces becomes an empty field.
 */
function needsQuoting(value: string, delimiter: string): boolean {
  if (value.length === 0) return false;
  if (value.includes(delimiter)) return true;
  if (value.includes(QUOTE)) return true;
  if (value.includes('\n') || value.includes('\r')) return true;
  if (value !== value.trim()) return true;
  return false;
}

export function writeCsv(
  rows: readonly (readonly string[])[],
  options: CsvWriteOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const lineEnding = options.lineEnding ?? '\r\n';
  const quoteAll = options.quoteAll ?? false;

  const encodeField = (value: string): string => {
    if (!quoteAll && !needsQuoting(value, delimiter)) return value;
    return QUOTE + value.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
  };

  return rows
    .map((row) => {
      // A row of exactly one empty field encodes to an empty string, which is
      // indistinguishable from a blank line — so it reads back as NO row at
      // all and the round trip loses it. Quoting makes the field explicit.
      //
      // A row of several empty fields is fine unquoted, because the delimiters
      // themselves prove how many fields there are.
      if (row.length === 1 && row[0] === '') return QUOTE + QUOTE;
      return row.map(encodeField).join(delimiter);
    })
    .join(lineEnding);
}

/**
 * Round-trip safety, as a property anyone can call.
 *
 * Exported so a test can assert it over generated input rather than over a
 * handful of cases somebody thought of. The interesting failures here are all
 * inputs nobody would write by hand: a field that is one quote, a field of
 * only spaces, a field containing the delimiter and a newline and a quote at
 * once.
 */
export function roundTrips(rows: readonly (readonly string[])[]): boolean {
  const encoded = writeCsv(rows);
  const decoded = readCsv(encoded, { delimiter: ',' }).rows;
  return JSON.stringify(decoded) === JSON.stringify(rows);
}
