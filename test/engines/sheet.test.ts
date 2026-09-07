/**
 * Sheet engine conformance.
 *
 * These assert exact values, not shapes. A test that only checks a formula
 * "produced a number" passes on an engine whose precedence is wrong, whose
 * blanks are zeros and whose lookups return the neighbouring row.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_COLUMNS,
  REF_ERROR,
  columnIndex,
  columnName,
  formatReference,
  parseReference,
  rangeSize,
  translateReference,
} from '../../app/engines/sheet/reference';
import { parseFormula, tokenize } from '../../app/engines/sheet/parser';
import { Workbook, parseLiteral } from '../../app/engines/sheet/workbook';
import { BLANK, isError } from '../../app/engines/sheet/values';

// --------------------------------------------------------------- addressing --

test('column letters are bijective base-26, not ordinary base-26', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  // The boundary that an ordinary base-26 implementation gets wrong. It would
  // produce BA here, because it has no way to represent a leading zero digit.
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(51), 'AZ');
  assert.equal(columnName(52), 'BA');
  assert.equal(columnName(701), 'ZZ');
  assert.equal(columnName(702), 'AAA');
  assert.equal(columnName(MAX_COLUMNS - 1), 'XFD');
});

test('column letters round-trip across the whole range', () => {
  // Not a spot check. An off-by-one in the bijective arithmetic shows up at
  // exactly one boundary, and spot checks are how it survives.
  for (let index = 0; index < MAX_COLUMNS; index += 1) {
    assert.equal(columnIndex(columnName(index)), index);
  }
});

test('dollar marks are tracked separately for row and column', () => {
  const relative = parseReference('A1');
  assert.equal(relative?.columnAbsolute, false);
  assert.equal(relative?.rowAbsolute, false);

  const columnLocked = parseReference('$A1');
  assert.equal(columnLocked?.columnAbsolute, true);
  assert.equal(columnLocked?.rowAbsolute, false);

  const rowLocked = parseReference('A$1');
  assert.equal(rowLocked?.columnAbsolute, false);
  assert.equal(rowLocked?.rowAbsolute, true);

  const both = parseReference('$A$1');
  assert.equal(both?.columnAbsolute, true);
  assert.equal(both?.rowAbsolute, true);
});

test('a quoted sheet name may contain a doubled quote and an exclamation mark', () => {
  const quote = String.fromCharCode(39);
  const reference = parseReference(quote + 'Bob' + quote + quote + 's data!' + quote + '!B7');
  assert.equal(reference?.sheet, 'Bob' + quote + 's data!');
  assert.equal(reference?.column, 1);
  assert.equal(reference?.row, 6);
});

test('reference formatting round-trips, quoting only when it must', () => {
  for (const text of ['A1', '$A1', 'A$1', '$A$1', 'XFD1048576', 'Sheet2!B3']) {
    const reference = parseReference(text);
    assert.ok(reference, text + ' should parse');
    assert.equal(formatReference(reference), text);
  }
});

test('translation moves relative parts, pins absolute parts, and refuses to wrap', () => {
  const reference = parseReference('B2');
  assert.ok(reference);
  const moved = translateReference(reference, 1, 1);
  assert.notEqual(moved, REF_ERROR);
  assert.equal(formatReference(moved as never), 'C3');

  const pinned = parseReference('$B$2');
  assert.ok(pinned);
  assert.equal(formatReference(translateReference(pinned, 5, 5) as never), '$B$2');

  // Off the left edge. Must be an error, never a wrap to the far right.
  const edge = parseReference('A1');
  assert.ok(edge);
  assert.equal(translateReference(edge, -1, 0), REF_ERROR);
  assert.equal(translateReference(edge, 0, -1), REF_ERROR);
});

test('a range is measured normalised, so a reversed range still has a size', () => {
  const start = parseReference('B4');
  const end = parseReference('A1');
  assert.ok(start && end);
  assert.equal(rangeSize({ start, end }), 8);
});

// ------------------------------------------------------------------ parsing --

test('comparison binds looser than arithmetic', () => {
  // The single most commonly mis-implemented precedence rule. If comparison
  // bound tighter, this would parse as 1 + (2 = 3) + 4 and evaluate to 5.
  const node = parseFormula('1 + 2 = 3 + 4');
  assert.equal(node.kind, 'binary');
  assert.equal((node as { operator: string }).operator, '=');
});

test('concatenation binds looser than addition and tighter than comparison', () => {
  const node = parseFormula('1 & 2 + 3');
  assert.equal((node as { operator: string }).operator, '&');
  const compared = parseFormula('1 & 2 = 3');
  assert.equal((compared as { operator: string }).operator, '=');
});

test('exponentiation is left-associative, matching the spreadsheet convention', () => {
  // 2^3^2 is 64 here, not the mathematical 512. Deliberate.
  const workbook = new Workbook();
  workbook.setCell('Sheet1', { column: 0, row: 0 }, '=2^3^2');
  assert.equal(workbook.read('Sheet1', { column: 0, row: 0 }), 64);
});

test('a doubled quote inside a string literal is one quote', () => {
  const tokens = tokenize('"say ""hello"" now"');
  assert.equal(tokens[0]?.kind, 'string');
  assert.equal((tokens[0] as { value: string }).value, 'say "hello" now');
});

test('a ragged array literal is refused rather than padded', () => {
  assert.throws(() => parseFormula('{1,2;3}'));
});

test('a range spanning two sheets is refused', () => {
  assert.throws(() => parseFormula('Sheet1!A1:Sheet2!B2'));
});

// --------------------------------------------------------------- literals --

test('a leading apostrophe forces text', () => {
  assert.equal(parseLiteral("'0012"), '0012');
  assert.equal(parseLiteral('0012'), 12);
});

test('a number that would not round-trip stays text', () => {
  // A long account number must not silently lose its last digits to double
  // precision. The cell has to show what was typed.
  const long = '12345678901234567890';
  assert.equal(parseLiteral(long), long);
});

test('booleans and percentages are recognised', () => {
  assert.equal(parseLiteral('TRUE'), true);
  assert.equal(parseLiteral('false'), false);
  assert.equal(parseLiteral('25%'), 0.25);
});

// ------------------------------------------------------------- evaluation --

function sheetWith(cells: Record<string, string>): Workbook {
  const workbook = new Workbook();
  for (const [address, input] of Object.entries(cells)) {
    const reference = parseReference(address);
    assert.ok(reference, address + ' should parse');
    workbook.setCell('Sheet1', reference, input);
  }
  return workbook;
}

function valueAt(workbook: Workbook, address: string): unknown {
  const reference = parseReference(address);
  assert.ok(reference);
  return workbook.read('Sheet1', reference);
}

test('arithmetic and references', () => {
  const workbook = sheetWith({ A1: '2', A2: '3', A3: '=A1*A2+1' });
  assert.equal(valueAt(workbook, 'A3'), 7);
});

test('editing a precedent recalculates its dependents transitively', () => {
  const workbook = sheetWith({ A1: '1', B1: '=A1+1', C1: '=B1+1', D1: '=C1+1' });
  assert.equal(valueAt(workbook, 'D1'), 4);
  workbook.setCell('Sheet1', parseReference('A1') as never, '10');
  assert.equal(valueAt(workbook, 'D1'), 13);
});

test('a deep dependency chain does not blow the stack', () => {
  // Recursion here would die at a few thousand. A real column of running
  // totals reaches that easily.
  const workbook = new Workbook();
  workbook.setCell('Sheet1', { column: 0, row: 0 }, '1');
  for (let row = 1; row < 5000; row += 1) {
    workbook.setCell('Sheet1', { column: 0, row }, '=A' + row + '+1');
  }
  assert.equal(workbook.read('Sheet1', { column: 0, row: 4999 }), 5000);
});

test('a cycle produces a circular error in every cell of the cycle, not a hang', () => {
  const workbook = sheetWith({ A1: '=B1+1', B1: '=A1+1' });
  const a = valueAt(workbook, 'A1');
  const b = valueAt(workbook, 'B1');
  assert.ok(isError(a) && a.error === 'CIRCULAR');
  assert.ok(isError(b) && b.error === 'CIRCULAR');
});

test('a cell referring to itself is circular', () => {
  const workbook = sheetWith({ A1: '=A1+1' });
  const value = valueAt(workbook, 'A1');
  assert.ok(isError(value) && value.error === 'CIRCULAR');
});

test('a blank cell is zero in arithmetic but is not counted', () => {
  const workbook = sheetWith({
    A1: '10',
    A3: '20',
    B1: '=A1+A2',
    B2: '=COUNT(A1:A3)',
    B3: '=AVERAGE(A1:A3)',
  });
  assert.equal(valueAt(workbook, 'B1'), 10);
  assert.equal(valueAt(workbook, 'B2'), 2);
  // The number that goes wrong if a blank is treated as zero: it would be 10.
  assert.equal(valueAt(workbook, 'B3'), 15);
});

test('text sorts above every number in a comparison', () => {
  const workbook = sheetWith({ A1: '=1000000 > "a"', A2: '="a" > 1000000' });
  assert.equal(valueAt(workbook, 'A1'), false);
  assert.equal(valueAt(workbook, 'A2'), true);
});

test('division by zero is its own error, distinguishable from a value error', () => {
  const workbook = sheetWith({ A1: '=1/0', A2: '=1+"nonsense"' });
  const divided = valueAt(workbook, 'A1');
  const invalid = valueAt(workbook, 'A2');
  assert.ok(isError(divided) && divided.error === 'DIV/0');
  assert.ok(isError(invalid) && invalid.error === 'VALUE');
});

test('IF does not evaluate the branch it does not take', () => {
  // The whole point of laziness. An eager IF makes this a division error and
  // the guard people actually write stops working.
  const workbook = sheetWith({ A1: '0', B1: '=IF(A1=0, "safe", 1/A1)' });
  assert.equal(valueAt(workbook, 'B1'), 'safe');
});

test('AND and OR short-circuit', () => {
  const workbook = sheetWith({ A1: '0', B1: '=AND(A1<>0, 1/A1>0)', C1: '=OR(A1=0, 1/A1>0)' });
  assert.equal(valueAt(workbook, 'B1'), false);
  assert.equal(valueAt(workbook, 'C1'), true);
});

test('an error propagates, and the first one wins', () => {
  const workbook = sheetWith({ A1: '=1/0', B1: '=A1+1', C1: '=B1*2' });
  const value = valueAt(workbook, 'C1');
  assert.ok(isError(value) && value.error === 'DIV/0');
});

test('MOD takes the sign of its divisor, unlike the remainder operator', () => {
  const workbook = sheetWith({ A1: '=MOD(-3, 2)', A2: '=MOD(3, -2)' });
  // JavaScript's remainder would give -1 and 1 respectively.
  assert.equal(valueAt(workbook, 'A1'), 1);
  assert.equal(valueAt(workbook, 'A2'), -1);
});

test('ROUND is half-away-from-zero, and does not reintroduce float noise', () => {
  const workbook = sheetWith({
    A1: '=ROUND(2.5, 0)',
    A2: '=ROUND(-2.5, 0)',
    A3: '=ROUND(1.005, 2)',
    A4: '=INT(-2.5)',
  });
  assert.equal(valueAt(workbook, 'A1'), 3);
  // Math.round would give -2 here.
  assert.equal(valueAt(workbook, 'A2'), -3);
  assert.equal(valueAt(workbook, 'A3'), 1.01);
  // Floor, not truncate.
  assert.equal(valueAt(workbook, 'A4'), -3);
});

test('aggregates skip text inside a range but reject it as a direct argument', () => {
  const workbook = sheetWith({
    A1: '10',
    A2: 'heading',
    A3: '20',
    B1: '=SUM(A1:A3)',
    B2: '=SUM(10, "heading")',
  });
  assert.equal(valueAt(workbook, 'B1'), 30);
  const direct = valueAt(workbook, 'B2');
  assert.ok(isError(direct) && direct.error === 'VALUE');
});

test('COUNTIF understands operators and wildcards, and escapes metacharacters', () => {
  const workbook = sheetWith({
    A1: '5',
    A2: '15',
    A3: '25',
    B1: 'apple.pie',
    B2: 'applesauce',
    B3: 'banana',
    C1: '=COUNTIF(A1:A3, ">10")',
    C2: '=COUNTIF(B1:B3, "apple*")',
    // The dot must be literal, not a regular-expression wildcard. If it were
    // not escaped this would also match applesauce.
    C3: '=COUNTIF(B1:B3, "apple.pie")',
  });
  assert.equal(valueAt(workbook, 'C1'), 2);
  assert.equal(valueAt(workbook, 'C2'), 2);
  assert.equal(valueAt(workbook, 'C3'), 1);
});

test('SUMIF can sum a different range from the one it tests', () => {
  const workbook = sheetWith({
    A1: 'north',
    A2: 'south',
    A3: 'north',
    B1: '10',
    B2: '20',
    B3: '30',
    C1: '=SUMIF(A1:A3, "north", B1:B3)',
  });
  assert.equal(valueAt(workbook, 'C1'), 40);
});

test('VLOOKUP defaults to approximate, and exact mode reports a real miss', () => {
  const workbook = sheetWith({
    A1: '1',
    B1: 'one',
    A2: '10',
    B2: 'ten',
    A3: '20',
    B3: 'twenty',
    D1: '=VLOOKUP(15, A1:B3, 2)',
    D2: '=VLOOKUP(15, A1:B3, 2, FALSE)',
    D3: '=VLOOKUP(10, A1:B3, 2, FALSE)',
  });
  // Approximate takes the largest value not exceeding the needle.
  assert.equal(valueAt(workbook, 'D1'), 'ten');
  const missed = valueAt(workbook, 'D2');
  assert.ok(isError(missed) && missed.error === 'N/A');
  assert.equal(valueAt(workbook, 'D3'), 'ten');
});

test('INDEX and MATCH compose, and out of range is not-available rather than blank', () => {
  const workbook = sheetWith({
    A1: 'a',
    A2: 'b',
    A3: 'c',
    C1: '=INDEX(A1:A3, MATCH("b", A1:A3, 0))',
    C2: '=INDEX(A1:A3, 9)',
  });
  assert.equal(valueAt(workbook, 'C1'), 'b');
  const outside = valueAt(workbook, 'C2');
  assert.ok(isError(outside) && outside.error === 'N/A');
});

test('text functions behave as the specification says, not as their names suggest', () => {
  const workbook = sheetWith({
    A1: '  many   spaces  here ',
    B1: '=TRIM(A1)',
    B2: '=EXACT("abc", "ABC")',
    B3: '="abc" = "ABC"',
    B4: '=PROPER("hong kong TEA house")',
    B5: '=MID("abcdef", 2, 3)',
    B6: '=SUBSTITUTE("a-b-a-b", "a", "X", 2)',
  });
  // TRIM collapses interior runs too. String.trim() would not.
  assert.equal(valueAt(workbook, 'B1'), 'many spaces here');
  // EXACT is case-sensitive; the equals operator is not.
  assert.equal(valueAt(workbook, 'B2'), false);
  assert.equal(valueAt(workbook, 'B3'), true);
  assert.equal(valueAt(workbook, 'B4'), 'Hong Kong Tea House');
  assert.equal(valueAt(workbook, 'B5'), 'bcd');
  assert.equal(valueAt(workbook, 'B6'), 'a-b-X-b');
});

test('FIND is case-sensitive and SEARCH is not, and a miss is an error not zero', () => {
  const workbook = sheetWith({
    A1: '=FIND("B", "abc")',
    A2: '=SEARCH("B", "abc")',
  });
  const missed = valueAt(workbook, 'A1');
  assert.ok(isError(missed) && missed.error === 'VALUE');
  assert.equal(valueAt(workbook, 'A2'), 2);
});

test('REPT is bounded so one cell cannot exhaust memory', () => {
  const workbook = sheetWith({ A1: '=REPT("abcdefghij", 100000)' });
  const value = valueAt(workbook, 'A1');
  assert.ok(isError(value) && value.error === 'VALUE');
});

test('an oversized range is refused rather than materialised', () => {
  const workbook = sheetWith({ A1: '=SUM(A1:XFD1048576)' });
  const value = valueAt(workbook, 'A1');
  assert.ok(isError(value));
});

test('operators broadcast across ranges, and refuse mismatched shapes', () => {
  const workbook = sheetWith({
    A1: '1',
    A2: '2',
    B1: '10',
    B2: '20',
    C1: '3',
    D1: '=SUMPRODUCT(A1:A2, B1:B2)',
    D2: '=SUMPRODUCT(A1:A2, C1:C1)',
  });
  assert.equal(valueAt(workbook, 'D1'), 50);
  const mismatched = valueAt(workbook, 'D2');
  assert.ok(isError(mismatched) && mismatched.error === 'VALUE');
});

test('a formula that will not parse keeps its text and shows an error', () => {
  const workbook = sheetWith({ A1: '=SUM(' });
  const value = valueAt(workbook, 'A1');
  assert.ok(isError(value));
  assert.equal(workbook.getCell('Sheet1', parseReference('A1') as never)?.input, '=SUM(');
  assert.ok(workbook.getCell('Sheet1', parseReference('A1') as never)?.parseError);
});

test('an unknown function is a name error, not a crash', () => {
  const workbook = sheetWith({ A1: '=NOTAFUNCTION(1)' });
  const value = valueAt(workbook, 'A1');
  assert.ok(isError(value) && value.error === 'NAME');
});

test('clearing a cell recalculates what depended on it', () => {
  const workbook = sheetWith({ A1: '5', B1: '=A1*2' });
  assert.equal(valueAt(workbook, 'B1'), 10);
  workbook.setCell('Sheet1', parseReference('A1') as never, '');
  assert.equal(valueAt(workbook, 'B1'), 0);
  assert.equal(valueAt(workbook, 'A1'), BLANK);
});

test('cross-sheet references resolve, and unqualified ones stay local', () => {
  const workbook = new Workbook(['Sheet1', 'Data']);
  workbook.setCell('Data', { column: 0, row: 0 }, '42');
  workbook.setCell('Sheet1', { column: 0, row: 0 }, '7');
  workbook.setCell('Sheet1', { column: 1, row: 0 }, '=Data!A1 + A1');
  assert.equal(workbook.read('Sheet1', { column: 1, row: 0 }), 49);
});

test('breaking a cycle restores real values', () => {
  const workbook = sheetWith({ A1: '=B1+1', B1: '=A1+1' });
  assert.ok(isError(valueAt(workbook, 'A1')));
  workbook.setCell('Sheet1', parseReference('B1') as never, '10');
  assert.equal(valueAt(workbook, 'B1'), 10);
  assert.equal(valueAt(workbook, 'A1'), 11);
});
