/**
 * Number formats.
 *
 * A format is PRESENTATION. The stored value never changes, and every formula
 * that reads the cell reads what was stored - which is the whole distinction a
 * format has to keep, and the one that is easiest to lose.
 *
 * FIVE THINGS THAT MAKE A FORMATTED CELL LOOK RIGHT AND BE WRONG.
 *
 *   - A PERCENT FORMAT MULTIPLIES THE DISPLAY, NEVER THE VALUE. 0.25 shows as
 *     25%, and SUM over that column still adds 0.25. A formatter that writes
 *     25 back into the cell has changed the spreadsheet's arithmetic while
 *     appearing to change only its appearance, and the error compounds every
 *     time the format is reapplied.
 *
 *   - ROUNDING IS DISPLAY ONLY. A column shown to two places whose values are
 *     stored to six will not add up to its own displayed total, and that is
 *     correct - the alternative is silently destroying precision the author
 *     entered. The application says so rather than hiding it.
 *
 *   - A FORMAT MEETS VALUES IT WAS NOT MEANT FOR. Text in a currency column,
 *     an error, a blank. Producing "NaN" or "£NaN" for those is worse than
 *     showing them plainly, because it looks like a computed result.
 *
 *   - A NEGATIVE NUMBER IN PARENTHESES IS STILL NEGATIVE. Accountancy style
 *     drops the minus sign, so a reader who is not told what the style means
 *     reads a loss as a profit. The style is offered, and the sign is never
 *     dropped without the parentheses that replace it.
 *
 *   - THOUSANDS SEPARATORS ARE LOCALE-SHAPED, and this project does not
 *     pretend otherwise: the separator is stated in the format rather than
 *     guessed from the machine, so a file opened elsewhere shows what its
 *     author chose.
 */

import { BLANK, type ScalarValue, isBlank, isError } from './values.js';

export type FormatKind =
  | 'general'
  | 'number'
  | 'percent'
  | 'currency'
  | 'scientific'
  | 'date'
  | 'time'
  | 'text';

export interface NumberFormat {
  readonly kind: FormatKind;
  /** Decimal places. Ignored by general, text and the date formats. */
  readonly places?: number;
  /** Group the integer part in threes. */
  readonly thousands?: boolean;
  /** The symbol for a currency format, written out rather than guessed. */
  readonly symbol?: string;
  /** Negatives in parentheses, the accountancy convention. */
  readonly parenthesised?: boolean;
}

export const GENERAL: NumberFormat = { kind: 'general' };

/** The formats offered in the interface, with the names shown for them. */
export const PRESETS: readonly { label: string; format: NumberFormat }[] = [
  { label: 'General', format: { kind: 'general' } },
  { label: 'Number, 2 places', format: { kind: 'number', places: 2, thousands: true } },
  { label: 'Number, 0 places', format: { kind: 'number', places: 0, thousands: true } },
  { label: 'Percent', format: { kind: 'percent', places: 1 } },
  {
    label: 'Currency',
    format: { kind: 'currency', places: 2, thousands: true, symbol: '$' },
  },
  {
    label: 'Accountancy',
    format: {
      kind: 'currency',
      places: 2,
      thousands: true,
      symbol: '$',
      parenthesised: true,
    },
  },
  { label: 'Scientific', format: { kind: 'scientific', places: 2 } },
  { label: 'Date', format: { kind: 'date' } },
  { label: 'Time', format: { kind: 'time' } },
  { label: 'Text', format: { kind: 'text' } },
];

/**
 * Group the integer part in threes.
 *
 * Written here rather than taken from the platform, because the platform's
 * grouping follows the machine's locale - so the same file would show
 * differently on two machines and neither would be what its author chose.
 */
function group(digits: string): string {
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ',';
    out += digits[index];
  }
  return out;
}

function fixed(value: number, places: number, thousands: boolean): string {
  const text = Math.abs(value).toFixed(places);
  const dot = text.indexOf('.');
  const whole = dot < 0 ? text : text.slice(0, dot);
  const rest = dot < 0 ? '' : text.slice(dot);
  return (thousands ? group(whole) : whole) + rest;
}

function signed(body: string, negative: boolean, parenthesised: boolean): string {
  if (!negative) return body;
  // The sign is never simply dropped: parentheses REPLACE it, and without them
  // a loss reads as a profit.
  return parenthesised ? '(' + body + ')' : '-' + body;
}

/**
 * The epoch a serial date counts from.
 *
 * 1899-12-30, matching the spreadsheet convention, so a date read from a
 * spreadsheet file lands on the day its author saw. Choosing 1900-01-01
 * instead - the obvious reading of "day 1" - puts every date two days out, and
 * it is off by exactly the amount nobody notices until a deadline moves.
 */
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

export function dateFromSerial(serial: number): Date {
  return new Date(EPOCH + Math.round(serial * DAY));
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Format one value for display.
 *
 * Values a format was not meant for pass through as they are. A currency
 * format meeting the word "total" shows "total", not "$NaN" - which looks like
 * a computed result and sends a reader hunting for a fault in their formulas.
 */
export function formatValue(value: ScalarValue, format: NumberFormat): string {
  if (isBlank(value)) return '';
  if (isError(value)) return '#' + value.error;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  if (typeof value === 'string') {
    // Text stays text under every format. A "number" format that coerced it
    // would turn a label into a zero.
    return value;
  }

  if (format.kind === 'text') return String(value);

  const places = format.places ?? 2;
  const thousands = format.thousands === true;
  const negative = value < 0;

  switch (format.kind) {
    case 'number':
      return signed(fixed(value, places, thousands), negative, format.parenthesised === true);

    case 'percent':
      // The DISPLAY is multiplied. The stored value is untouched, so a sum over
      // the column still adds the fractions it holds.
      return signed(
        fixed(value * 100, places, thousands) + '%',
        negative,
        format.parenthesised === true,
      );

    case 'currency': {
      const symbol = format.symbol ?? '$';
      return signed(
        symbol + fixed(value, places, thousands),
        negative,
        format.parenthesised === true,
      );
    }

    case 'scientific': {
      const text = Math.abs(value).toExponential(places);
      return signed(text, negative, format.parenthesised === true);
    }

    case 'date': {
      const date = dateFromSerial(value);
      return (
        date.getUTCFullYear() +
        '-' +
        two(date.getUTCMonth() + 1) +
        '-' +
        two(date.getUTCDate())
      );
    }

    case 'time': {
      // The fractional part is the time of day. Taking the whole number would
      // show midnight for every value.
      const fraction = value - Math.floor(value);
      const seconds = Math.round(fraction * 86400);
      return (
        two(Math.floor(seconds / 3600) % 24) +
        ':' +
        two(Math.floor(seconds / 60) % 60) +
        ':' +
        two(seconds % 60)
      );
    }

    default:
      return String(value);
  }
}

/**
 * Whether the format shows fewer decimals than the value carries.
 *
 * Asked so the application can SAY that a column does not add up to its own
 * displayed total, rather than leaving somebody to discover it and conclude
 * the arithmetic is broken.
 */
export function roundsForDisplay(value: ScalarValue, format: NumberFormat): boolean {
  if (typeof value !== 'number') return false;
  if (format.kind === 'general' || format.kind === 'text') return false;
  if (format.kind === 'date' || format.kind === 'time') return false;

  const places = format.places ?? 2;
  const scaled = format.kind === 'percent' ? value * 100 : value;
  return Math.abs(scaled - Number(scaled.toFixed(places))) > Number.EPSILON;
}

/** A short description, for the status line and for a screen reader. */
export function describeFormat(format: NumberFormat): string {
  const preset = PRESETS.find(
    (candidate) =>
      candidate.format.kind === format.kind &&
      candidate.format.places === format.places &&
      candidate.format.parenthesised === format.parenthesised,
  );
  if (preset !== undefined) return preset.label;
  return format.kind + (format.places === undefined ? '' : ', ' + format.places + ' places');
}

export { BLANK };
