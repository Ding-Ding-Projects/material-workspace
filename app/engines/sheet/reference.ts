/**
 * Cell addressing.
 *
 * A1 notation looks trivial and is not. Three things go wrong in almost every
 * from-scratch implementation, and each is guarded here by name:
 *
 *   1. COLUMN LETTERS ARE NOT BASE-26. There is no zero digit, so the sequence
 *      is A..Z, AA..AZ, BA.. — a bijective base-26. Treating it as ordinary
 *      base-26 makes Z and AA collide, and the error only appears at column 27,
 *      which is past where anyone tests by hand.
 *
 *   2. DOLLAR MARKS TRAVEL SEPARATELY FOR ROW AND COLUMN. Three different
 *      references exist with three different copy behaviours, and collapsing
 *      them into one "absolute" flag silently breaks the single most common
 *      spreadsheet operation there is: dragging a formula down a column.
 *
 *   3. TRANSLATION MUST FAIL RATHER THAN WRAP. Copying a formula leftwards off
 *      the edge of the grid must yield a reference error. Wrapping round to the
 *      far right produces a number instead of an error, which is worse than
 *      failing because it looks like an answer.
 */

/** Sheets are bounded so a typo in a range cannot ask for infinite memory. */
export const MAX_COLUMNS = 16384;
export const MAX_ROWS = 1048576;

export interface CellAddress {
  /** Zero-based. */
  readonly column: number;
  /** Zero-based. */
  readonly row: number;
}

export interface CellReference extends CellAddress {
  readonly columnAbsolute: boolean;
  readonly rowAbsolute: boolean;
  /** Undefined means "this sheet". */
  readonly sheet?: string;
}

export interface RangeReference {
  readonly start: CellReference;
  readonly end: CellReference;
}

/** The sentinel a reference becomes when translation moves it off the grid. */
export const REF_ERROR = Symbol('ref-error');
export type Translated<T> = T | typeof REF_ERROR;

/**
 * Column index to letters. Bijective base-26: subtract one before each digit,
 * which is what makes index 25 into Z and index 26 into AA rather than BA.
 */
export function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_COLUMNS) {
    throw new RangeError('column index out of range: ' + index);
  }
  let remaining = index;
  let name = '';
  while (remaining >= 0) {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return name;
}

/** Letters to column index. Returns -1 for anything that is not a column. */
export function columnIndex(name: string): number {
  if (name.length === 0 || name.length > 3) return -1;
  let index = 0;
  for (let position = 0; position < name.length; position += 1) {
    const code = name.charCodeAt(position);
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    if (upper < 65 || upper > 90) return -1;
    index = index * 26 + (upper - 64);
  }
  const zeroBased = index - 1;
  return zeroBased >= MAX_COLUMNS ? -1 : zeroBased;
}

const CELL_PATTERN = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;
const DOLLAR = '$';
const QUOTE = String.fromCharCode(39);

/**
 * Parse a single cell reference, optionally sheet-qualified.
 *
 * A quoted sheet name escapes its own quote by doubling it. Splitting on the
 * last exclamation mark without handling that would truncate any sheet name
 * containing one.
 */
export function parseReference(text: string): CellReference | undefined {
  let body = text;
  let sheet: string | undefined;

  if (body.startsWith(QUOTE)) {
    let cursor = 1;
    let name = '';
    while (cursor < body.length) {
      if (body[cursor] === QUOTE) {
        if (body[cursor + 1] === QUOTE) {
          name += QUOTE;
          cursor += 2;
          continue;
        }
        break;
      }
      name += body[cursor];
      cursor += 1;
    }
    if (body[cursor] !== QUOTE || body[cursor + 1] !== '!') return undefined;
    sheet = name;
    body = body.slice(cursor + 2);
  } else {
    const bang = body.indexOf('!');
    if (bang >= 0) {
      sheet = body.slice(0, bang);
      body = body.slice(bang + 1);
      if (sheet.length === 0) return undefined;
    }
  }

  const match = CELL_PATTERN.exec(body);
  if (!match) return undefined;

  // Destructured rather than indexed. Under noUncheckedIndexedAccess every
  // group reads as possibly undefined even though the pattern guarantees all
  // four, and silencing that with a non-null assertion would remove the one
  // check that catches a later edit changing the group count.
  const [, columnDollar, columnLetters, rowDollar, rowDigits] = match;
  if (columnLetters === undefined || rowDigits === undefined) return undefined;

  const column = columnIndex(columnLetters);
  if (column < 0) return undefined;

  const rowNumber = Number(rowDigits);
  if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS) return undefined;

  return {
    column,
    row: rowNumber - 1,
    columnAbsolute: columnDollar === DOLLAR,
    rowAbsolute: rowDollar === DOLLAR,
    sheet,
  };
}

export function formatReference(reference: CellReference): string {
  const cell =
    (reference.columnAbsolute ? DOLLAR : '') +
    columnName(reference.column) +
    (reference.rowAbsolute ? DOLLAR : '') +
    String(reference.row + 1);
  if (reference.sheet === undefined) return cell;
  const needsQuotes = /[^A-Za-z0-9_]/.test(reference.sheet);
  const doubled = reference.sheet.split(QUOTE).join(QUOTE + QUOTE);
  const name = needsQuotes ? QUOTE + doubled + QUOTE : reference.sheet;
  return name + '!' + cell;
}

/**
 * Move a reference by a delta, as copying a formula does.
 *
 * An absolute component does not move. A component that would leave the grid
 * yields the reference-error sentinel rather than clamping, because a clamped
 * reference silently points at the wrong cell and produces a plausible number.
 */
export function translateReference(
  reference: CellReference,
  columnDelta: number,
  rowDelta: number,
): Translated<CellReference> {
  const column = reference.columnAbsolute ? reference.column : reference.column + columnDelta;
  const row = reference.rowAbsolute ? reference.row : reference.row + rowDelta;
  if (column < 0 || column >= MAX_COLUMNS) return REF_ERROR;
  if (row < 0 || row >= MAX_ROWS) return REF_ERROR;
  return { ...reference, column, row };
}

/** A range is stored as written but iterated normalised, so B4:A1 still works. */
export function normaliseRange(range: RangeReference): {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
} {
  return {
    top: Math.min(range.start.row, range.end.row),
    bottom: Math.max(range.start.row, range.end.row),
    left: Math.min(range.start.column, range.end.column),
    right: Math.max(range.start.column, range.end.column),
  };
}

export function rangeSize(range: RangeReference): number {
  const box = normaliseRange(range);
  return (box.bottom - box.top + 1) * (box.right - box.left + 1);
}

export function* iterateRange(range: RangeReference): Generator<CellAddress> {
  const box = normaliseRange(range);
  for (let row = box.top; row <= box.bottom; row += 1) {
    for (let column = box.left; column <= box.right; column += 1) {
      yield { column, row };
    }
  }
}

export function rangeContains(range: RangeReference, address: CellAddress): boolean {
  const box = normaliseRange(range);
  return (
    address.row >= box.top &&
    address.row <= box.bottom &&
    address.column >= box.left &&
    address.column <= box.right
  );
}

/**
 * A stable key for graph bookkeeping. Sheet-qualified, always.
 *
 * The separator is NUL because a sheet name may legitimately contain a space,
 * a comma, a colon and almost every other printable character. A separator the
 * name can contain lets two different cells share one key, which in a
 * dependency graph means one cell silently inheriting another cell dependents.
 *
 * Written as fromCharCode rather than as a literal, because a raw NUL byte in
 * a source file is invisible in every editor and diff, and any tool that
 * sanitises control characters would remove it without a word.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

export function addressKey(sheet: string, address: CellAddress): string {
  return sheet + KEY_SEPARATOR + address.column + KEY_SEPARATOR + address.row;
}
