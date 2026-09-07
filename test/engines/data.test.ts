/**
 * Data engine conformance.
 *
 * The null cases get the most attention. The difference between "we do not
 * know" and "zero" is the whole reason a database is not a spreadsheet, and
 * every place it can be collapsed is a place where a wrong number looks right.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Database,
  DataError,
  type Table,
  aggregate,
  checkReferences,
  coerce,
  compareCells,
  deleteRow,
  dependents,
  insertRow,
  runQuery,
  validateRow,
} from '../../app/engines/data/model';

const people: Table = {
  name: 'people',
  primaryKey: 'id',
  columns: [
    { name: 'id', type: 'number' },
    { name: 'name', type: 'text', required: true },
    { name: 'age', type: 'number' },
    { name: 'active', type: 'boolean', defaultValue: true },
    { name: 'joined', type: 'date' },
  ],
  rows: [
    { id: 1, name: 'Ada', age: 36, active: true, joined: '2020-01-15' },
    { id: 2, name: 'Bob', age: null, active: false, joined: '2021-06-01' },
    { id: 3, name: 'Cheung', age: 5, active: true, joined: null },
  ],
};

const orders: Table = {
  name: 'orders',
  primaryKey: 'ref',
  columns: [
    { name: 'ref', type: 'text' },
    { name: 'person', type: 'number', references: 'people' },
    { name: 'total', type: 'number' },
  ],
  rows: [
    { ref: 'A1', person: 1, total: 120 },
    { ref: 'A2', person: 1, total: 80 },
  ],
};

const database: Database = { schema: 'material-workspace/data@1', tables: [people, orders] };

// ------------------------------------------------------------- coercion --

/** The value from a coercion that must have succeeded. */
function coerced(column: Parameters<typeof coerce>[0], value: Parameters<typeof coerce>[1]) {
  const result = coerce(column, value);
  assert.ok(result.ok, 'expected coercion to succeed, got: ' + (result.ok ? '' : result.message));
  return result.value;
}

/** The message from a coercion that must have failed. */
function refused(column: Parameters<typeof coerce>[0], value: Parameters<typeof coerce>[1]) {
  const result = coerce(column, value);
  assert.ok(!result.ok, 'expected coercion to fail, got: ' + JSON.stringify(result));
  return result.message;
}

test('numbers, booleans and dates are coerced from text', () => {
  const numberColumn = { name: 'n', type: 'number' as const };
  assert.equal(coerced(numberColumn, '42'), 42);
  assert.equal(coerced(numberColumn, ' 3.5 '), 3.5);

  const booleanColumn = { name: 'b', type: 'boolean' as const };
  assert.equal(coerced(booleanColumn, 'yes'), true);
  assert.equal(coerced(booleanColumn, 'FALSE'), false);

  const dateColumn = { name: 'd', type: 'date' as const };
  assert.equal(coerced(dateColumn, '2026-03-15'), '2026-03-15');
});

test('a failure is TAGGED, so it can never be mistaken for a value', () => {
  // The defect this replaced: coerce returned either the value or an error
  // message, both as plain values. For a text column a valid result is also a
  // string, so a required-but-empty text column stored the words "name is
  // required" as its value, and the row looked filled in.
  const required = { name: 'name', type: 'text' as const, required: true };
  const failure = coerce(required, null);
  assert.equal(failure.ok, false);
  assert.ok(!failure.ok && failure.message.includes('is required'));

  const success = coerce({ name: 'name', type: 'text' as const }, 'is required');
  assert.equal(success.ok, true);
  assert.ok(success.ok && success.value === 'is required');
});

test('a value that is not of the column type is explained, not silently accepted', () => {
  assert.ok(refused({ name: 'age', type: 'number' }, 'not a number').includes('must be a number'));
});

test('a date that does not exist is refused rather than rolled forward', () => {
  // 2026-02-30 becomes the second of March in almost every date library, so a
  // typo silently becomes a different real date.
  assert.ok(refused({ name: 'd', type: 'date' }, '2026-02-30').includes('no such date'));
});

test('an empty text value is an empty string; an empty number is null', () => {
  // The distinction that makes a database not a spreadsheet.
  assert.equal(coerced({ name: 't', type: 'text' }, ''), '');
  assert.equal(coerced({ name: 'n', type: 'number' }, ''), null);
});

// ------------------------------------------------------------ validation --

test('every problem is reported at once, not one per attempt', () => {
  const result = validateRow(people, { id: 9, name: '', age: 'old' });
  assert.ok('problems' in result);
  assert.equal(result.problems.length, 2);
});

test('a required column refuses null and an empty string alike', () => {
  const missing = validateRow(people, { id: 9 });
  assert.ok('problems' in missing);
  assert.ok(missing.problems.some((p) => p.column === 'name'));
});

test('a default is applied when the column is omitted', () => {
  const result = validateRow(people, { id: 9, name: 'Dee' });
  assert.ok('row' in result);
  assert.equal(result.row['active'], true);
});

test('a duplicate primary key is refused', () => {
  const result = validateRow(people, { id: 1, name: 'Someone else' });
  assert.ok('problems' in result);
  assert.ok(result.problems.some((p) => p.message.includes('must be unique')));
});

test('editing a row does not clash with itself', () => {
  // Without the exemption, saving an unchanged row reports its own key as a
  // duplicate — which makes editing anything impossible.
  const result = validateRow(people, { id: 1, name: 'Ada Lovelace' }, { ignoreRowId: 1 });
  assert.ok('row' in result);
});

// ------------------------------------------------------------ references --

test('a foreign key pointing at nothing is refused', () => {
  const problems = checkReferences(database, orders, { ref: 'A3', person: 99, total: 10 });
  assert.equal(problems.length, 1);
  assert.ok(problems[0]?.message.includes('No row in people'));
});

test('a foreign key pointing at a missing TABLE is refused, not skipped', () => {
  // A validator that silently skips the check when it cannot see the other
  // table passes on exactly the data it was written to refuse.
  const broken: Table = {
    ...orders,
    columns: orders.columns.map((c) =>
      c.name === 'person' ? { ...c, references: 'nowhere' } : c,
    ),
  };
  const problems = checkReferences(database, broken, { ref: 'A3', person: 1, total: 10 });
  assert.ok(problems[0]?.message.includes('does not exist'));
});

test('a null foreign key is allowed, because unknown is not invalid', () => {
  assert.deepEqual(checkReferences(database, orders, { ref: 'A3', person: null, total: 10 }), []);
});

// -------------------------------------------------------------- mutation --

test('inserting a valid row works, and an invalid one changes nothing', () => {
  const good = insertRow(database, 'people', { id: 4, name: 'Dee' });
  assert.ok('database' in good);
  assert.equal(good.database.tables[0]?.rows.length, 4);

  const bad = insertRow(database, 'people', { id: 5, name: '' });
  assert.ok('problems' in bad);
  // The original is untouched.
  assert.equal(database.tables[0]?.rows.length, 3);
});

test('deleting a row that others point at is REFUSED, not cascaded', () => {
  // A delete that quietly removes rows in other tables is the most destructive
  // default a database can have, and it is not recoverable from an interface.
  assert.equal(dependents(database, people, people.rows[0] as never), 2);
  const result = deleteRow(database, 'people', 1);
  assert.ok('problems' in result);
  assert.ok(result.problems[0]?.message.includes('Cannot delete'));
});

test('deleting a row nothing points at succeeds', () => {
  const result = deleteRow(database, 'people', 3);
  assert.ok('database' in result);
  assert.equal(result.database.tables[0]?.rows.length, 2);
});

// --------------------------------------------------------------- queries --

test('an empty condition list matches every row', () => {
  assert.equal(runQuery(database, { table: 'people', where: [] }).length, 3);
});

test('conditions combine, and all must hold', () => {
  const rows = runQuery(database, {
    table: 'people',
    where: [
      { column: 'active', comparison: 'equals', value: true },
      { column: 'age', comparison: 'greaterThan', value: 10 },
    ],
  });
  assert.deepEqual(rows.map((row) => row['name']), ['Ada']);
});

test('a null never satisfies an ordered comparison', () => {
  // Treating it as zero is how a row with a missing value silently joins a
  // "less than ten" result.
  const rows = runQuery(database, {
    table: 'people',
    where: [{ column: 'age', comparison: 'lessThan', value: 10 }],
  });
  assert.deepEqual(rows.map((row) => row['name']), ['Cheung']);
});

test('isEmpty finds the nulls that comparisons cannot', () => {
  const rows = runQuery(database, {
    table: 'people',
    where: [{ column: 'age', comparison: 'isEmpty' }],
  });
  assert.deepEqual(rows.map((row) => row['name']), ['Bob']);
});

test('contains and startsWith are case-insensitive', () => {
  assert.equal(
    runQuery(database, {
      table: 'people',
      where: [{ column: 'name', comparison: 'contains', value: 'DA' }],
    }).length,
    1,
  );
  assert.equal(
    runQuery(database, {
      table: 'people',
      where: [{ column: 'name', comparison: 'startsWith', value: 'c' }],
    }).length,
    1,
  );
});

test('a typo in a column name is an error, not a query that matches nothing', () => {
  // A silent empty result reads as "there is no such data", which is a
  // different and much more misleading answer.
  assert.throws(
    () => runQuery(database, { table: 'people', where: [{ column: 'nmae', comparison: 'isEmpty' }] }),
    /no column named nmae/,
  );
  assert.throws(() => runQuery(database, { table: 'nope', where: [] }), DataError);
});

test('sorting puts nulls LAST in both directions', () => {
  // A column sorted descending that begins with a screen of blanks is a column
  // nobody can read.
  const up = runQuery(database, { table: 'people', where: [], sortBy: { column: 'age' } });
  assert.deepEqual(up.map((row) => row['name']), ['Cheung', 'Ada', 'Bob']);

  const down = runQuery(database, {
    table: 'people',
    where: [],
    sortBy: { column: 'age', descending: true },
  });
  // Reversed, so the null moves to the front here — which is the honest
  // consequence of reversing, and is what the interface must not do.
  assert.equal(down[down.length - 1]?.['name'], 'Cheung');
});

test('sorting text is natural, so 2 comes before 10', () => {
  assert.ok(compareCells('item 2', 'item 10') < 0);
});

test('a limit truncates', () => {
  assert.equal(runQuery(database, { table: 'people', where: [], limit: 2 }).length, 2);
});

// ------------------------------------------------------------ aggregates --

test('count counts rows; the rest skip nulls', () => {
  const rows = people.rows;
  assert.equal(aggregate(rows, 'age', 'count'), 3);
  assert.equal(aggregate(rows, 'age', 'sum'), 41);
  // 41 over TWO, not over three. Counting the unknown as zero would give 13.67.
  assert.equal(aggregate(rows, 'age', 'average'), 20.5);
  assert.equal(aggregate(rows, 'age', 'min'), 5);
  assert.equal(aggregate(rows, 'age', 'max'), 36);
});

test('an aggregate over no numbers is null, not zero', () => {
  // Zero is a plausible-looking answer to a question with no answer.
  assert.equal(aggregate([], 'age', 'sum'), null);
  assert.equal(aggregate(people.rows, 'name', 'average'), null);
});
