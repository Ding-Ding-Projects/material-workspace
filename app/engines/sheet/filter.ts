/**
 * Filtering a range of rows.
 *
 * WHAT FILTERING IS, AND THE THING IT MUST NEVER BE. A filter HIDES rows; it
 * does not remove them. A spreadsheet that deletes what a filter excludes is a
 * spreadsheet that loses data every time somebody narrows a view, and the loss
 * is invisible until they clear the filter and find the rows gone.
 *
 * So this returns which row indices are visible, and nothing else. Nothing here
 * mutates a workbook.
 *
 * FIVE THINGS THAT LOOK RIGHT AND ARE WRONG.
 *
 *   - BLANK IS NOT EMPTY STRING AND NOT ZERO. A blank cell is a cell nobody has
 *     filled in, and a filter that treats it as "" puts it in the same bucket
 *     as a cell somebody deliberately cleared. Worse, treating it as 0 makes
 *     "less than 10" select every empty row in the sheet.
 *
 *   - A NUMBER STORED AS TEXT IS NOT A NUMBER. "10" sorts before "9" as text
 *     and after it as a number, and a filter that coerces silently gives an
 *     answer that is right for one of those and wrong for the other with no
 *     way to tell which happened.
 *
 *   - AN ERROR IS NOT A VALUE. A cell holding #DIV/0! matches no comparison. A
 *     filter that stringifies it makes "contains 0" select every division
 *     error in the column.
 *
 *   - THE HEADER ROW IS NOT DATA. Filtering it out is what makes a filtered
 *     table unreadable, and filtering it IN puts the word "Total" in the list
 *     of distinct values.
 *
 *   - TEXT COMPARISON IS CASE-INSENSITIVE AND ACCENT-SENSITIVE. Somebody
 *     filtering for "smith" expects "Smith"; nobody filtering for "resume"
 *     expects "résumé", and quietly folding accents merges names that are
 *     genuinely different people.
 */

import { BLANK, type ScalarValue, isError } from './values.js';

export type Comparison =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'greaterThan'
  | 'lessThan'
  | 'between'
  | 'isBlank'
  | 'isNotBlank'
  | 'isError'
  | 'oneOf';

export interface Condition {
  /** Zero-based, relative to the filtered range. */
  readonly column: number;
  readonly comparison: Comparison;
  /** The value compared against. Unused by isBlank, isNotBlank and isError. */
  readonly value?: string | number;
  /** The upper bound, for `between`. */
  readonly upper?: string | number;
  /** The chosen values, for `oneOf`. */
  readonly choices?: readonly (string | number)[];
}

export interface FilterOptions {
  /** True when the first row is a header and must always stay visible. */
  readonly hasHeader?: boolean;
}

export interface FilterResult {
  /** Row indices that survive, in their original order. */
  readonly visible: readonly number[];
  /** How many rows were considered, excluding a header. */
  readonly considered: number;
  /** How many were hidden. Reported so the surface can say it. */
  readonly hidden: number;
}

/** Which rows survive every condition. Conditions are combined with AND. */
export function filterRows(
  rows: readonly (readonly ScalarValue[])[],
  conditions: readonly Condition[],
  options: FilterOptions = {},
): FilterResult {
  const headerRows = options.hasHeader === true && rows.length > 0 ? 1 : 0;
  const visible: number[] = [];

  for (let index = 0; index < headerRows; index += 1) visible.push(index);

  for (let index = headerRows; index < rows.length; index += 1) {
    const row = rows[index] as readonly ScalarValue[];
    // AND across conditions. OR would need its own control, and a filter that
    // silently ORs when somebody expected AND returns far too much.
    if (conditions.every((condition) => matches(row[condition.column], condition))) {
      visible.push(index);
    }
  }

  const considered = rows.length - headerRows;
  return { visible, considered, hidden: considered - (visible.length - headerRows) };
}

/** Whether one cell satisfies one condition. */
export function matches(cell: ScalarValue | undefined, condition: Condition): boolean {
  const value = cell ?? BLANK;

  if (condition.comparison === 'isBlank') return value === BLANK;
  if (condition.comparison === 'isNotBlank') return value !== BLANK;
  if (condition.comparison === 'isError') return isError(value);

  // An error matches NOTHING else. A filter that stringifies it makes
  // "contains 0" select every #DIV/0! in the column.
  if (isError(value)) return false;

  // A blank matches nothing except the blank tests above. Treating it as 0
  // makes "less than 10" select every empty row in the sheet, and treating it
  // as "" puts it in the same bucket as a cell somebody deliberately cleared.
  if (value === BLANK) return false;

  switch (condition.comparison) {
    case 'equals':
      return same(value, condition.value);
    case 'notEquals':
      return !same(value, condition.value);
    case 'contains':
      return text(value).includes(text(condition.value ?? ''));
    case 'notContains':
      return !text(value).includes(text(condition.value ?? ''));
    case 'startsWith':
      return text(value).startsWith(text(condition.value ?? ''));
    case 'greaterThan': {
      const compared = compare(value, condition.value);
      return compared !== null && compared > 0;
    }
    case 'lessThan': {
      const compared = compare(value, condition.value);
      return compared !== null && compared < 0;
    }
    case 'between': {
      const low = compare(value, condition.value);
      const high = compare(value, condition.upper);
      // Inclusive at both ends, which is what "between 1 and 10" means to
      // everybody who is not writing the code.
      return low !== null && high !== null && low >= 0 && high <= 0;
    }
    case 'oneOf':
      return (condition.choices ?? []).some((choice) => same(value, choice));
    default:
      return false;
  }
}

/**
 * Equality, with the type respected.
 *
 * A number stored as text is NOT the number. "10" and 10 sort differently, and
 * coercing silently gives an answer that is right for one reading and wrong for
 * the other with nothing to say which happened.
 */
function same(value: ScalarValue, against: string | number | undefined): boolean {
  if (against === undefined) return false;
  if (typeof value === 'number' || typeof against === 'number') {
    // Both, or neither. A number compared with text is not equal, however
    // identical they look printed: "10" sorts before "9" and 10 does not, and
    // a filter that says they are the same is right for one reading of the
    // column and wrong for the other with nothing to say which happened.
    return typeof value === 'number' && typeof against === 'number' && value === against;
  }
  if (typeof value === 'boolean') return String(value).toLowerCase() === text(against);
  return text(value) === text(against);
}

/**
 * Ordering, or null when the two are not comparable.
 *
 * Null rather than a guess: comparing a word with a number has no answer, and
 * inventing one puts rows in a filtered view that nobody asked for.
 */
function compare(value: ScalarValue, against: string | number | undefined): number | null {
  if (against === undefined) return null;

  if (typeof value === 'number') {
    const other = typeof against === 'number' ? against : Number(against);
    if (!Number.isFinite(other)) return null;
    return value === other ? 0 : value < other ? -1 : 1;
  }

  if (typeof against === 'number') return null;

  const one = text(value);
  const two = text(against);
  return one === two ? 0 : one < two ? -1 : 1;
}

/**
 * Text for comparison: lower-cased, and NOT accent-folded.
 *
 * Somebody filtering for "smith" expects "Smith". Nobody filtering for "resume"
 * expects "résumé", and folding accents merges names that are genuinely
 * different people.
 */
function text(value: ScalarValue | string | number): string {
  if (value === BLANK) return '';
  return String(value).toLowerCase();
}

/**
 * The distinct values in a column, for a choose-from-a-list filter.
 *
 * Blanks are reported SEPARATELY rather than as an empty string in the list,
 * because "no value" and "the empty string" are different things and a list
 * that shows one blank-looking entry cannot say which it means.
 */
export interface DistinctValues {
  readonly values: readonly ScalarValue[];
  readonly blanks: number;
  readonly errors: number;
}

export function distinct(
  rows: readonly (readonly ScalarValue[])[],
  column: number,
  options: FilterOptions = {},
): DistinctValues {
  const start = options.hasHeader === true ? 1 : 0;
  const seen = new Map<string, ScalarValue>();
  let blanks = 0;
  let errors = 0;

  for (let index = start; index < rows.length; index += 1) {
    const value = (rows[index] as readonly ScalarValue[])[column] ?? BLANK;
    if (value === BLANK) {
      blanks += 1;
      continue;
    }
    if (isError(value)) {
      errors += 1;
      continue;
    }
    // Keyed by type AND text, so the number 10 and the string "10" are two
    // entries. Merging them is how a filter silently selects both.
    const key = typeof value + ':' + String(value);
    if (!seen.has(key)) seen.set(key, value);
  }

  const values = [...seen.values()].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  });

  return { values, blanks, errors };
}

/** A sentence for the surface: how many are shown, and how many are not. */
export function describeFilter(result: FilterResult): string {
  if (result.hidden === 0) {
    return result.considered + (result.considered === 1 ? ' row, none hidden.' : ' rows, none hidden.');
  }
  const shown = result.considered - result.hidden;
  return (
    shown + ' of ' + result.considered + ' rows shown. ' +
    result.hidden + (result.hidden === 1 ? ' row is hidden' : ' rows are hidden') +
    ', not removed - clear the filter to see them again.'
  );
}
