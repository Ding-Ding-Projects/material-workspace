/**
 * Sorting a range of rows.
 *
 * THE ONE THING THIS EXISTS TO PREVENT is sorting a single column in place.
 * Every value in that column then belongs to a different row from the one it
 * was entered against - names against the wrong salaries, quantities against
 * the wrong parts - and nothing about the result looks wrong. It is the most
 * expensive ordinary mistake a spreadsheet can make, it has no undo once the
 * file is saved, and it is what happens when a sort moves cells rather than
 * rows.
 *
 * FOUR MORE THINGS THAT LOOK RIGHT AND ARE WRONG.
 *
 *   - MIXED TYPES NEED A DEFINED ORDER. A plain less-than over numbers, text
 *     and booleans is not merely arbitrary, it can be non-transitive, and a
 *     comparator that is non-transitive makes a sort produce a different
 *     answer depending on the starting order. The order here is fixed and
 *     stated: numbers, then text, then booleans, then errors, then blanks.
 *
 *   - BLANKS SORT LAST BOTH WAYS. Reversing them puts every empty row at the
 *     top of a descending sort, which buries the data the sort was for.
 *
 *   - THE SORT MUST BE STABLE. Rows with equal keys keep the order they were
 *     in, so sorting by one column and then another gives the compound order
 *     somebody expects rather than a reshuffle.
 *
 *   - A FORMULA INSIDE THE RANGE MOVES WITH ITS ROW AND ITS REFERENCES DO NOT.
 *     This engine does not rewrite references, so rather than producing a
 *     sorted sheet whose formulas quietly point at other people's rows, it
 *     REFUSES and names the cells. A refusal is recoverable; a silently wrong
 *     spreadsheet is not.
 */

import { BLANK, type ScalarValue, isError } from './values.js';

/**
 * Empty, by identity.
 *
 * Compared against the sentinel directly rather than through the shared
 * predicate, because that one takes a value a cell can never hold and the
 * widening loses the sentinel's own type on the way in.
 */
const isEmpty = (value: ScalarValue | undefined): boolean =>
  value === undefined || value === BLANK;

export type Direction = 'ascending' | 'descending';

export interface SortRow {
  /** Where the row came from, so the caller can move whole rows back. */
  readonly index: number;
  readonly values: readonly (ScalarValue | undefined)[];
}

export interface SortRequest {
  readonly rows: readonly SortRow[];
  /** Which column decides the order. */
  readonly column: number;
  readonly direction: Direction;
}

export interface SortRefusal {
  readonly ok: false;
  readonly reason: string;
}

export interface SortOrder {
  readonly ok: true;
  /** The original row indexes, in their new order. */
  readonly order: readonly number[];
  /** Said in words: what moved, and how. */
  readonly summary: string;
}

export type SortResult = SortOrder | SortRefusal;

/**
 * The rank of a value's TYPE.
 *
 * Fixed and stated, because a comparator that decides type order by accident
 * decides it differently for different inputs.
 */
function typeRank(value: ScalarValue | undefined): number {
  if (isEmpty(value)) return 4;
  if (isError(value)) return 3;
  if (typeof value === 'boolean') return 2;
  if (typeof value === 'string') return 1;
  return 0;
}

/**
 * Compare two values in ascending order, blanks aside.
 *
 * Returns 0 for two values of different types only when both are blank, so the
 * comparator is transitive: rank first, then within a rank.
 */
export function compareValues(
  one: ScalarValue | undefined,
  two: ScalarValue | undefined,
): number {
  const rankOne = typeRank(one);
  const rankTwo = typeRank(two);
  if (rankOne !== rankTwo) return rankOne - rankTwo;

  if (rankOne === 4) return 0;
  if (rankOne === 3) {
    const a = isError(one) ? one.error : '';
    const b = isError(two) ? two.error : '';
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (rankOne === 2) return Number(one) - Number(two);
  if (rankOne === 1) {
    // Case-insensitive, because a column of names sorted with every capital
    // ahead of every lower-case letter is not sorted as far as a reader is
    // concerned.
    const a = String(one).toLowerCase();
    const b = String(two).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(one) - Number(two);
}

/**
 * Work out the new row order.
 *
 * Returns an ORDER rather than reordered rows, because the caller has to move
 * whole rows - every column of them - and handing back one column's values
 * sorted is exactly the mistake this module exists to prevent.
 */
export function sortRows(request: SortRequest): SortResult {
  const { rows, column, direction } = request;

  if (rows.length === 0) return { ok: false, reason: 'There are no rows to sort.' };
  if (column < 0) return { ok: false, reason: 'No column was chosen to sort by.' };

  const wide = rows.every((row) => column < row.values.length);
  if (!wide) {
    return {
      ok: false,
      reason: 'That column is outside the rows being sorted.',
    };
  }

  // Annotated, because inferring the object literal widens the blank
  // sentinel's unique symbol to a plain symbol and it stops matching the value
  // type it came from.
  const decorated: { row: SortRow; position: number; key: ScalarValue | undefined }[] = rows.map(
    (row, position) => ({ row, position, key: row.values[column] }),
  );

  decorated.sort((one, two) => {
    const blankOne = isEmpty(one.key);
    const blankTwo = isEmpty(two.key);
    // Blanks last in BOTH directions. Reversing them buries the data.
    if (blankOne !== blankTwo) return blankOne ? 1 : -1;

    const compared = compareValues(one.key, two.key);
    if (compared !== 0) return direction === 'ascending' ? compared : -compared;

    // Stable: equal keys keep their original order, so sorting by one column
    // and then another composes.
    return one.position - two.position;
  });

  const moved = decorated.filter((entry, position) => entry.position !== position).length;

  return {
    ok: true,
    order: decorated.map((entry) => entry.row.index),
    summary:
      moved === 0
        ? 'Already in that order, so nothing moved.'
        : moved + (moved === 1 ? ' row moved. ' : ' rows moved. ') +
          'Whole rows moved together, so every value stayed with the row it was entered against.',
  };
}

/**
 * Refuse when a formula inside the range would be left pointing elsewhere.
 *
 * Called by the application before it sorts. The cells are NAMED, because
 * "cannot sort" without saying which cell is a dead end for somebody looking
 * at three hundred rows.
 */
export function formulasBlocking(
  cells: readonly { readonly address: string; readonly input: string }[],
): SortRefusal | null {
  const formulas = cells.filter((cell) => cell.input.startsWith('='));
  if (formulas.length === 0) return null;

  const named = formulas
    .slice(0, 5)
    .map((cell) => cell.address)
    .join(', ');

  return {
    ok: false,
    reason:
      'This range holds ' +
      formulas.length +
      (formulas.length === 1 ? ' formula (' : ' formulas (') +
      named +
      (formulas.length > 5 ? ' and more' : '') +
      '). Sorting would move them without moving what they point at, so the ' +
      'sort was refused rather than left quietly wrong.',
  };
}
