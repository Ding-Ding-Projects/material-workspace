/**
 * The value system, and the coercion rules that go with it.
 *
 * Coercion is where a spreadsheet engine's compatibility is actually decided,
 * and the rules are genuinely strange. They are written out here rather than
 * left implicit, because every one of them is a decision somebody will
 * otherwise "fix" into incompatibility:
 *
 *   - A BLANK CELL IS NOT ZERO, except when it is. Arithmetic treats it as 0;
 *     comparison treats it as an empty string against text and as 0 against a
 *     number; COUNT does not count it; AVERAGE does not include it. One
 *     "blank means zero" shortcut breaks the last two silently, and an average
 *     that quietly counts empty rows is a wrong number that looks right.
 *
 *   - TEXT SORTS ABOVE EVERY NUMBER. In a comparison between a number and a
 *     string, the string is always greater, whatever the two contain. So a
 *     number is never greater than text, which surprises everyone once.
 *
 *   - BOOLEANS SORT ABOVE TEXT. The full ordering is number, then text, then
 *     boolean. It exists so a mixed column has a total order at all.
 *
 *   - AN ERROR IS CONTAGIOUS. Any operand that is an error makes the result
 *     that same error, and the FIRST error wins so the message points at the
 *     original cause rather than at whatever noticed it last.
 */

import type { ErrorKind } from './parser';

export const BLANK = Symbol('blank');
export type Blank = typeof BLANK;

export interface CellError {
  readonly kind: 'error';
  readonly error: ErrorKind;
}

export type ScalarValue = number | string | boolean | Blank | CellError;

/** A rectangular block of values, as a range or an array literal produces. */
export interface Matrix {
  readonly kind: 'matrix';
  readonly rows: number;
  readonly columns: number;
  readonly values: readonly ScalarValue[];
}

export type Value = ScalarValue | Matrix;

export function makeError(error: ErrorKind): CellError {
  return { kind: 'error', error };
}

export const DIV_ZERO = makeError('DIV/0');
export const VALUE_ERROR = makeError('VALUE');
export const REFERENCE_ERROR = makeError('REF');
export const NAME_ERROR = makeError('NAME');
export const NUMBER_ERROR = makeError('NUM');
export const NOT_AVAILABLE = makeError('N/A');
export const CIRCULAR_ERROR = makeError('CIRCULAR');

/**
 * Takes unknown rather than Value on purpose.
 *
 * Half the helpers in the engine return `T | CellError`, and a guard typed to
 * Value cannot narrow those — so every call site would need a cast, and a cast
 * is exactly where a real type error hides. Widening the parameter keeps the
 * narrowing honest everywhere.
 */
export function isError(value: unknown): value is CellError {
  return typeof value === 'object' && value !== null && (value as CellError).kind === 'error';
}

export function isMatrix(value: Value): value is Matrix {
  return typeof value === 'object' && value !== null && (value as Matrix).kind === 'matrix';
}

export function isBlank(value: Value): value is Blank {
  return value === BLANK;
}

export function matrix(rows: number, columns: number, values: readonly ScalarValue[]): Matrix {
  if (values.length !== rows * columns) {
    throw new RangeError('matrix size does not match its values');
  }
  return { kind: 'matrix', rows, columns, values };
}

export function matrixAt(source: Matrix, row: number, column: number): ScalarValue {
  const value = source.values[row * source.columns + column];
  return value === undefined ? BLANK : value;
}

/**
 * Reduce a value to a single scalar.
 *
 * A one-cell matrix is that cell. A larger matrix used where a scalar is wanted
 * is a value error rather than its first element, because silently taking the
 * first element of a range is how a formula produces a confident wrong answer.
 */
export function toScalar(value: Value): ScalarValue {
  if (!isMatrix(value)) return value;
  if (value.rows === 1 && value.columns === 1) return matrixAt(value, 0, 0);
  return VALUE_ERROR;
}

const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const PERCENT_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*%$/;

/**
 * Coerce to a number for arithmetic.
 *
 * Text that LOOKS like a number is accepted, which is what makes a CSV import
 * usable. Text that does not is a value error, never NaN — NaN propagates
 * silently through arithmetic and surfaces far from its cause, whereas the
 * error names the cell that produced it.
 */
export function toNumber(value: ScalarValue): number | CellError {
  if (isError(value)) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === BLANK) return 0;

  const trimmed = value.trim();
  if (trimmed.length === 0) return 0;
  if (NUMERIC_PATTERN.test(trimmed)) return Number(trimmed);

  const percent = PERCENT_PATTERN.exec(trimmed);
  if (percent && percent[1] !== undefined) return Number(percent[1]) / 100;

  return VALUE_ERROR;
}

export function toText(value: ScalarValue): string | CellError {
  if (isError(value)) return value;
  if (value === BLANK) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return formatNumberForText(value);
}

/**
 * Numbers rendered into text.
 *
 * Fifteen significant digits, because that is the precision a double can carry
 * without exposing binary representation artefacts. Rendering all seventeen
 * turns 0.1 + 0.2 into a number with a tail of nines, which is accurate and
 * useless.
 */
export function formatNumberForText(value: number): string {
  if (!Number.isFinite(value)) return 'NUM';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rendered = value.toPrecision(15);
  if (rendered.includes('e') || rendered.includes('E')) return String(Number(rendered));
  // Trim the trailing zeros toPrecision adds, and any bare decimal point left
  // behind by trimming them.
  let trimmed = rendered;
  while (trimmed.includes('.') && trimmed.endsWith('0')) trimmed = trimmed.slice(0, -1);
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export function toBoolean(value: ScalarValue): boolean | CellError {
  if (isError(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === BLANK) return false;
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  const asNumber = toNumber(value);
  if (isError(asNumber)) return VALUE_ERROR;
  return asNumber !== 0;
}

/** number < text < boolean. See the note at the top of this file. */
function typeRank(value: ScalarValue): number {
  if (typeof value === 'number' || value === BLANK) return 0;
  if (typeof value === 'string') return 1;
  return 2;
}

/**
 * Compare two scalars, returning -1, 0 or 1, or an error.
 *
 * Text comparison is case-insensitive, which is the spreadsheet convention and
 * not the programming one. EXACT() exists precisely because this is not exact.
 */
export function compareValues(left: ScalarValue, right: ScalarValue): number | CellError {
  if (isError(left)) return left;
  if (isError(right)) return right;

  // A blank compared against text behaves as an empty string, and against a
  // number behaves as zero. Resolving that here keeps the type ranking honest.
  const leftResolved = left === BLANK ? (typeof right === 'string' ? '' : 0) : left;
  const rightResolved = right === BLANK ? (typeof left === 'string' ? '' : 0) : right;

  const leftRank = typeRank(leftResolved);
  const rightRank = typeRank(rightResolved);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;

  if (typeof leftResolved === 'string' && typeof rightResolved === 'string') {
    const a = leftResolved.toUpperCase();
    const b = rightResolved.toUpperCase();
    return a === b ? 0 : a < b ? -1 : 1;
  }

  if (typeof leftResolved === 'boolean' && typeof rightResolved === 'boolean') {
    return leftResolved === rightResolved ? 0 : leftResolved ? 1 : -1;
  }

  const a = leftResolved as number;
  const b = rightResolved as number;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Every scalar inside a value, flattened.
 *
 * Used by the aggregate functions, which take ranges and arrays
 * interchangeably.
 */
export function flatten(value: Value): readonly ScalarValue[] {
  return isMatrix(value) ? value.values : [value];
}
