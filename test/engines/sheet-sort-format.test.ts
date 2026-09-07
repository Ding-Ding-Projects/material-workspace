/**
 * Sorting and number formats.
 *
 * The headline is the sort. Sorting a single column in place detaches every
 * value from its row - names against the wrong salaries, quantities against the
 * wrong parts - and nothing about the result looks wrong. It is the most
 * expensive ordinary mistake a spreadsheet can make and it has no undo once the
 * file is saved.
 *
 * The formats have a quieter version of the same problem: a percent format that
 * multiplies the stored value rather than the display changes the spreadsheet's
 * arithmetic while appearing to change only its appearance, and it compounds
 * every time the format is reapplied.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GENERAL,
  PRESETS,
  dateFromSerial,
  describeFormat,
  formatValue,
  roundsForDisplay,
} from '../../app/engines/sheet/format';
import {
  compareValues,
  formulasBlocking,
  sortRows,
} from '../../app/engines/sheet/sort';
import { BLANK, type ScalarValue, makeError } from '../../app/engines/sheet/values';

const rowsOf = (table: readonly (readonly (ScalarValue | undefined)[])[]) =>
  table.map((values, index) => ({ index, values }));

// ------------------------------------------------------------ whole rows --

test('a sort returns an ORDER, so the caller has to move whole rows', () => {
  // Handing back one column's values sorted is the mistake this module exists
  // to prevent, so the shape of the answer makes it impossible.
  const result = sortRows({
    rows: rowsOf([
      ['Chan', 30],
      ['Au', 50],
      ['Wong', 40],
    ]),
    column: 0,
    direction: 'ascending',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual([...result.order], [1, 0, 2]);
});

test('every value stays with the row it was entered against', () => {
  // The direct statement of the disaster: reorder by the name column and the
  // salaries must follow their own names.
  const table: readonly (readonly ScalarValue[])[] = [
    ['Chan', 30000],
    ['Au', 50000],
    ['Wong', 40000],
  ];
  const result = sortRows({ rows: rowsOf(table), column: 0, direction: 'ascending' });
  assert.ok(result.ok);
  if (!result.ok) return;

  const moved = result.order.map((index) => table[index]);
  assert.deepEqual(moved, [
    ['Au', 50000],
    ['Chan', 30000],
    ['Wong', 40000],
  ]);
});

test('the summary says whole rows moved, rather than reporting a count alone', () => {
  const result = sortRows({
    rows: rowsOf([[2], [1]]),
    column: 0,
    direction: 'ascending',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.match(result.summary, /rows moved/);
  assert.match(result.summary, /stayed with the row/);
});

test('a sort that changes nothing says so instead of claiming work', () => {
  const result = sortRows({
    rows: rowsOf([[1], [2], [3]]),
    column: 0,
    direction: 'ascending',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.match(result.summary, /Already in that order/);
});

// -------------------------------------------------------------- the order --

test('mixed types have a fixed order, and it is transitive', () => {
  // A plain less-than over these is not merely arbitrary, it can be
  // non-transitive - and a non-transitive comparator makes the sort depend on
  // the starting order.
  const values: (ScalarValue | undefined)[] = [
    'text',
    42,
    true,
    makeError('VALUE'),
    BLANK,
  ];

  for (const a of values) {
    for (const b of values) {
      for (const c of values) {
        if (compareValues(a, b) <= 0 && compareValues(b, c) <= 0) {
          assert.ok(
            compareValues(a, c) <= 0,
            'not transitive: ' + String(a) + ' ' + String(b) + ' ' + String(c),
          );
        }
      }
    }
  }
});

test('numbers come before text, text before booleans, errors before blanks', () => {
  const result = sortRows({
    rows: rowsOf([[BLANK], [makeError('VALUE')], [true], ['apple'], [7]]),
    column: 0,
    direction: 'ascending',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual([...result.order], [4, 3, 2, 1, 0]);
});

test('blanks sort last BOTH ways, because reversing them buries the data', () => {
  const table = rowsOf([[BLANK], [3], [1]]);

  const up = sortRows({ rows: table, column: 0, direction: 'ascending' });
  const down = sortRows({ rows: table, column: 0, direction: 'descending' });
  assert.ok(up.ok && down.ok);
  if (!up.ok || !down.ok) return;

  assert.equal(up.order[up.order.length - 1], 0, 'blank was not last ascending');
  assert.equal(down.order[down.order.length - 1], 0, 'blank was not last descending');
});

test('a missing cell counts as blank rather than as an error', () => {
  const result = sortRows({
    rows: [
      { index: 0, values: [undefined] },
      { index: 1, values: [5] },
    ],
    column: 0,
    direction: 'ascending',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual([...result.order], [1, 0]);
});

test('the sort is stable, so sorting twice composes', () => {
  // By the second column, then by the first: within each first-column group the
  // second-column order must survive.
  const table = rowsOf([
    ['b', 2],
    ['a', 2],
    ['b', 1],
    ['a', 1],
  ]);

  const byNumber = sortRows({ rows: table, column: 1, direction: 'ascending' });
  assert.ok(byNumber.ok);
  if (!byNumber.ok) return;

  const afterNumber = byNumber.order.map((index) => table[index] as (typeof table)[number]);
  const byLetter = sortRows({
    rows: afterNumber.map((row, index) => ({ index, values: row.values })),
    column: 0,
    direction: 'ascending',
  });
  assert.ok(byLetter.ok);
  if (!byLetter.ok) return;

  const final = byLetter.order.map((index) => afterNumber[index]?.values);
  assert.deepEqual(final, [
    ['a', 1],
    ['a', 2],
    ['b', 1],
    ['b', 2],
  ]);
});

test('text sorts case-insensitively, or half a name column looks unsorted', () => {
  const result = sortRows({
    rows: rowsOf([['banana'], ['Apple'], ['cherry']]),
    column: 0,
    direction: 'ascending',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual([...result.order], [1, 0, 2]);
});

// ------------------------------------------------------------- refusals --

test('a formula in the range is REFUSED, and the cells are named', () => {
  // A refusal is recoverable. A sorted sheet whose formulas point at other
  // people's rows is not, and it looks completely normal.
  const refusal = formulasBlocking([
    { address: 'B2', input: '=A2*2' },
    { address: 'B3', input: '17' },
  ]);
  assert.notEqual(refusal, null);
  assert.match(refusal?.reason ?? '', /B2/);
  assert.match(refusal?.reason ?? '', /refused/);
});

test('a range of plain values is not refused', () => {
  assert.equal(formulasBlocking([{ address: 'A1', input: '17' }]), null);
});

test('an empty range and a bad column are refused with reasons, not with an empty order', () => {
  const none = sortRows({ rows: [], column: 0, direction: 'ascending' });
  assert.equal(none.ok, false);

  const narrow = sortRows({ rows: rowsOf([[1]]), column: 4, direction: 'ascending' });
  assert.equal(narrow.ok, false);
  if (narrow.ok) return;
  assert.match(narrow.reason, /outside the rows/);
});

// ------------------------------------------------------------- formats --

test('a percent format multiplies the DISPLAY and leaves the value alone', () => {
  // The whole distinction a format has to keep. A formatter that writes 25 back
  // into the cell changes the arithmetic while appearing to change only the
  // appearance, and it compounds each time it is reapplied.
  const value = 0.25;
  assert.equal(formatValue(value, { kind: 'percent', places: 0 }), '25%');
  assert.equal(value, 0.25);
});

test('a negative percent keeps its sign', () => {
  assert.equal(formatValue(-0.125, { kind: 'percent', places: 1 }), '-12.5%');
});

test('accountancy style puts a negative in parentheses INSTEAD of the minus', () => {
  // Never as well as, and never neither - a loss with no marking reads as a
  // profit.
  const style = { kind: 'currency' as const, places: 2, symbol: '$', parenthesised: true };
  assert.equal(formatValue(-1234.5, style), '($1234.50)');
  assert.equal(formatValue(1234.5, style), '$1234.50');
});

test('thousands are grouped in threes, from the right', () => {
  assert.equal(formatValue(1234567, { kind: 'number', places: 0, thousands: true }), '1,234,567');
  assert.equal(formatValue(999, { kind: 'number', places: 0, thousands: true }), '999');
  assert.equal(formatValue(1000, { kind: 'number', places: 0, thousands: true }), '1,000');
});

test('grouping applies to the whole part only, never inside the decimals', () => {
  assert.equal(
    formatValue(1234.5678, { kind: 'number', places: 4, thousands: true }),
    '1,234.5678',
  );
});

test('text under a number format stays text, rather than becoming zero', () => {
  assert.equal(formatValue('total', { kind: 'currency', places: 2, symbol: '$' }), 'total');
});

test('a blank formats as nothing, and an error as its own name', () => {
  // "$NaN" looks like a computed result and sends a reader hunting for a fault
  // in their formulas.
  assert.equal(formatValue(BLANK, { kind: 'currency', places: 2, symbol: '$' }), '');
  assert.equal(formatValue(makeError('DIV/0'), { kind: 'number', places: 2 }), '#DIV/0');
});

test('a boolean formats as TRUE or FALSE under every format', () => {
  assert.equal(formatValue(true, { kind: 'percent', places: 2 }), 'TRUE');
  assert.equal(formatValue(false, GENERAL), 'FALSE');
});

test('a date serial counts from 1899-12-30, which is where spreadsheets count from', () => {
  // 1900-01-01 is the obvious reading of "day 1" and puts every date two days
  // out - off by exactly the amount nobody notices until a deadline moves.
  assert.equal(dateFromSerial(1).toISOString().slice(0, 10), '1899-12-31');
  assert.equal(formatValue(45000, { kind: 'date' }), '2023-03-15');
});

test('a time format reads the FRACTION, not the whole number', () => {
  // Taking the integer part shows midnight for every value.
  assert.equal(formatValue(45000.5, { kind: 'time' }), '12:00:00');
  assert.equal(formatValue(0.25, { kind: 'time' }), '06:00:00');
});

test('scientific keeps its exponent and its sign', () => {
  assert.equal(formatValue(12345, { kind: 'scientific', places: 2 }), '1.23e+4');
  assert.equal(formatValue(-0.00012, { kind: 'scientific', places: 1 }), '-1.2e-4');
});

test('rounding for display is reported, so a column that will not add up says so', () => {
  // A column shown to two places whose values hold six will not equal its own
  // displayed total. That is correct, and it has to be said.
  assert.equal(roundsForDisplay(1.005, { kind: 'number', places: 2 }), true);
  assert.equal(roundsForDisplay(1.5, { kind: 'number', places: 2 }), false);
  assert.equal(roundsForDisplay('text', { kind: 'number', places: 2 }), false);
  assert.equal(roundsForDisplay(1.005, GENERAL), false);
});

test('every preset has a name, and the names are distinct', () => {
  // A picker with two entries reading the same is a picker nobody can use.
  const labels = PRESETS.map((preset) => preset.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const preset of PRESETS) {
    assert.ok(preset.label.length > 2, preset.label);
    assert.equal(describeFormat(preset.format), preset.label);
  }
});

test('general leaves a number as it was typed', () => {
  assert.equal(formatValue(42, GENERAL), '42');
  assert.equal(formatValue(0.5, GENERAL), '0.5');
});
