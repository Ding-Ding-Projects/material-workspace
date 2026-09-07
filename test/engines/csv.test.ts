/**
 * CSV conformance.
 *
 * The cases that matter are the ones nobody writes by hand: a field that is a
 * single quote, a field of only spaces, a field carrying the delimiter and a
 * newline and a quote at once. A test suite made of tidy examples passes on a
 * parser that splits on commas.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectDelimiter,
  readCsv,
  roundTrips,
  writeCsv,
} from '../../app/engines/codec/csv';

const QUOTE = String.fromCharCode(34);
const q = (inner: string): string => QUOTE + inner + QUOTE;

test('an ordinary file reads', () => {
  const result = readCsv('a,b,c\n1,2,3');
  assert.deepEqual(result.rows, [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('a quoted field may contain the delimiter', () => {
  // Splitting on commas turns this into three columns and shifts everything
  // after it left. The result parses cleanly and is entirely wrong.
  const result = readCsv('name,address\nBob,' + q('12 Main St, Kowloon, HK'));
  assert.deepEqual(result.rows[1], ['Bob', '12 Main St, Kowloon, HK']);
});

test('a quoted field may contain a newline', () => {
  // This is why reading line by line cannot work at all.
  const result = readCsv('note\n' + q('first line\nsecond line'));
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[1], ['first line\nsecond line']);
});

test('a doubled quote inside a quoted field is one quote', () => {
  const result = readCsv(q('she said ' + QUOTE + QUOTE + 'hello' + QUOTE + QUOTE));
  assert.deepEqual(result.rows[0], ['she said ' + QUOTE + 'hello' + QUOTE]);
});

test('a field that is exactly one quote survives a round trip', () => {
  assert.ok(roundTrips([[QUOTE]]));
});

test('all four line endings are accepted', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const result = readCsv('a,b' + ending + 'c,d');
    assert.deepEqual(
      result.rows,
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      'failed for ' + JSON.stringify(ending),
    );
  }
});

test('a trailing newline does not invent an empty final row', () => {
  assert.equal(readCsv('a,b\nc,d\n').rows.length, 2);
  assert.equal(readCsv('a,b\nc,d\r\n').rows.length, 2);
});

test('but a genuinely empty final field survives', () => {
  assert.deepEqual(readCsv('a,b,').rows[0], ['a', 'b', '']);
  assert.deepEqual(readCsv('a,b,' + q('')).rows[0], ['a', 'b', '']);
});

test('a byte-order mark is stripped from the first header', () => {
  // Otherwise the first column silently stops matching by name, and the mark
  // is invisible in every editor so nobody can see why.
  const result = readCsv(String.fromCharCode(0xfeff) + 'id,name\n1,Bob');
  assert.deepEqual(result.rows[0], ['id', 'name']);
});

test('the delimiter is detected from outside quotes, not from everywhere', () => {
  // A column of prose carries far more commas inside quotes than the real
  // delimiter carries outside them. Counting everywhere picks the comma.
  const text =
    'id\tnote\n1\t' +
    q('a sentence, with several, commas in it') +
    '\n2\t' +
    q('another, one, here, too');
  assert.equal(detectDelimiter(text), '\t');
  assert.deepEqual(readCsv(text).rows[1], ['1', 'a sentence, with several, commas in it']);
});

test('semicolon and pipe files are recognised', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
});

test('leading and trailing whitespace is quoted on write, so it survives', () => {
  // The forgotten case, and it changes data rather than breaking it: a field
  // of two spaces would otherwise come back empty.
  const encoded = writeCsv([['  ', 'x']]);
  assert.equal(encoded, q('  ') + ',x');
  assert.deepEqual(readCsv(encoded).rows[0], ['  ', 'x']);
});

test('only the fields that need quoting get quoted', () => {
  assert.equal(writeCsv([['plain', 'has,comma']]), 'plain,' + q('has,comma'));
});

test('quoteAll quotes everything, for consumers that demand it', () => {
  assert.equal(writeCsv([['a', 'b']], { quoteAll: true }), q('a') + ',' + q('b'));
});

test('the writer emits one consistent line ending', () => {
  assert.equal(writeCsv([['a'], ['b']], { lineEnding: '\n' }), 'a\nb');
  assert.equal(writeCsv([['a'], ['b']], { lineEnding: '\r\n' }), 'a\r\nb');
});

test('the hostile cases all round-trip', () => {
  const hostile: string[][] = [
    [QUOTE],
    [QUOTE + QUOTE],
    ['  leading and trailing  '],
    ['has,comma'],
    ['has\nnewline'],
    ['has\r\ncrlf'],
    ['all three, ' + QUOTE + ' and\na newline'],
    [''],
    ['', '', ''],
    ['\t'],
    ['香港茶樓'],
  ];
  for (const row of hostile) {
    assert.ok(roundTrips([row]), 'did not round-trip: ' + JSON.stringify(row));
  }
});

test('a run of generated rows round-trips', () => {
  // Not random — deterministic, so a failure is reproducible. Random input in
  // a test produces a failure nobody can repeat.
  const pieces = ['a', ',', QUOTE, '\n', ' ', '', '\r', '茶'];
  const rows: string[][] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = 0; j < pieces.length; j += 1) {
      rows.push([pieces[i] as string, pieces[j] as string]);
    }
  }
  assert.ok(roundTrips(rows), 'the generated matrix did not round-trip');
});

test('an unterminated quote is reported rather than silently swallowing the rest', () => {
  const result = readCsv('a,' + QUOTE + 'unterminated');
  assert.ok(result.warnings.some((w) => w.includes('closing quote')));
});

test('bounds are enforced rather than exhausting memory', () => {
  assert.throws(() => readCsv('a\nb\nc\nd', { maxRows: 2 }), /exceeds 2 rows/);
  assert.throws(() => readCsv('a,b,c', { maxColumns: 2 }), /exceeds 2 columns/);
});
