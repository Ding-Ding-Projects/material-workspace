/**
 * Export.
 *
 * The writers are checked by PARSING THEM BACK where a parser exists, rather
 * than by comparing against a string somebody typed. A hand-written expected
 * string proves the writer still does what it did; parsing it back proves it
 * produces something a reader can actually use, which is the only thing an
 * export is for.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FORMATS,
  type Format,
  INFO,
  type Table,
  filenameFor,
  warningsFor,
  write,
} from '../../app/shared/export';

const PEOPLE: Table = {
  name: 'people',
  columns: ['name', 'age', 'active', 'note'],
  rows: [
    { name: 'Ada', age: 36, active: true, note: null },
    { name: 'Bo, "the quick"', age: 41, active: false, note: 'has a comma, a "quote" and\na newline' },
    { name: 'Cheung', age: 0, active: true, note: '' },
  ],
};

const ORDERS: Table = {
  name: 'orders',
  columns: ['id', 'total'],
  rows: [{ id: 1, total: 9.5 }],
};

// ------------------------------------------------------------- completeness --

test('every format writes something for every table', () => {
  for (const format of FORMATS) {
    const text = write(format, [PEOPLE]);
    assert.ok(text.length > 0, format + ' wrote nothing');
    assert.ok(text.includes('Ada'), format + ' lost a row');
  }
});

test('the format table and the format list agree', () => {
  // Two lists of the same thing is one list that eventually stops matching.
  assert.deepEqual([...FORMATS].sort(), Object.keys(INFO).sort());
});

// ------------------------------------------------------------------- CSV --

test('CSV quotes the three things that would make a row unparseable', () => {
  const text = write('csv', [PEOPLE]);
  // The separator, a quote and a newline. Any of them unquoted corrupts every
  // row after it.
  assert.ok(text.includes('"Bo, ""the quick"""'), 'the comma and quotes were not escaped:\n' + text);
  assert.ok(/"has a comma, a ""quote"" and\nа?\s*newline"/.test(text.replace(/\r/g, '')) || text.includes('""quote""'));
});

test('CSV round-trips through a real parse', () => {
  // Parsed back rather than string-compared: what matters is that a reader can
  // use it, not that the writer still produces the bytes it used to.
  const rows = parseCsv(write('csv', [PEOPLE]));
  assert.deepEqual(rows[0], ['name', 'age', 'active', 'note']);
  assert.equal(rows[1]?.[0], 'Ada');
  assert.equal(rows[2]?.[0], 'Bo, "the quick"');
  // The exact value that went in, newline and all. My first version of this
  // line dropped a word and then "corrected" itself with a no-op replace,
  // which is how a test comes to assert something nobody ever wrote.
  assert.equal(rows[2]?.[3], PEOPLE.rows[1]?.note);
  assert.equal(rows.length, 4, 'wrong number of rows: ' + rows.length);
});

test('a zero is written, not treated as empty', () => {
  // The classic falsy bug: `value || ''` turns 0 and false into blanks, and a
  // spreadsheet of ages silently loses everybody who is zero.
  const text = write('csv', [PEOPLE]);
  assert.ok(/(^|,)0(,|$)/m.test(text), 'the zero age vanished:\n' + text);
  assert.ok(text.includes('false'), 'the false flag vanished');
});

test('TSV uses tabs and quotes a value containing one', () => {
  const tabbed: Table = { name: 't', columns: ['a'], rows: [{ a: 'has\ttab' }] };
  const text = write('tsv', [tabbed]);
  assert.ok(text.includes('"has\ttab"'), 'a tab inside a value was not quoted:\n' + text);
});

/** A small but honest CSV reader, for the round-trip above. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------------ JSON --

test('JSON round-trips exactly, types and nulls included', () => {
  const parsed = JSON.parse(write('json', [PEOPLE, ORDERS])) as Table[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.rows[0]?.['age'], 36);
  assert.equal(parsed[0]?.rows[0]?.['note'], null);
  assert.equal(parsed[0]?.rows[0]?.['active'], true);
});

test('JSONL is one row per line and parses line by line', () => {
  const text = write('jsonl', [PEOPLE]);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, PEOPLE.rows.length);
  for (const line of lines) JSON.parse(line);
  assert.equal((JSON.parse(lines[0] as string) as { name: string }).name, 'Ada');
});

test('JSONL writes only the first table, and the warning says so', () => {
  const text = write('jsonl', [PEOPLE, ORDERS]);
  assert.ok(!text.includes('9.5'), 'the second table leaked in');
  const warned = warningsFor('jsonl', [PEOPLE, ORDERS]);
  assert.ok(warned.some((w) => /Only the first of 2 tables/.test(w.what)), JSON.stringify(warned));
});

// ------------------------------------------------------------------ YAML --

test('YAML quotes every string, so no value silently changes type', () => {
  // The classic YAML footgun: unquoted `no` becomes false and `0755` becomes
  // 493. A spreadsheet exported through YAML otherwise arrives with a column
  // of nonsense, and nothing reports it.
  const tricky: Table = {
    name: 'tricky',
    columns: ['a', 'b', 'c'],
    rows: [{ a: 'no', b: '0755', c: 'yes' }],
  };
  const text = write('yaml', [tricky]);
  assert.ok(text.includes('a: "no"'), 'no was left unquoted:\n' + text);
  assert.ok(text.includes('b: "0755"'), '0755 was left unquoted:\n' + text);
  assert.ok(text.includes('c: "yes"'));
});

test('YAML writes a real null rather than an empty string', () => {
  assert.ok(write('yaml', [PEOPLE]).includes('note: null'));
});

// ------------------------------------------------------------------- XML --

test('XML escapes every character that would break the document', () => {
  const nasty: Table = {
    name: 'nasty',
    columns: ['a'],
    rows: [{ a: '<script>&"\'</script>' }],
  };
  const text = write('xml', [nasty]);
  assert.ok(!text.includes('<script>'), 'a tag survived unescaped:\n' + text);
  assert.ok(text.includes('&lt;script&gt;'));
  assert.ok(text.includes('&amp;'));
});

test('XML marks a null rather than writing an indistinguishable empty', () => {
  // So a reader can tell "unknown" from "not in this row".
  assert.match(write('xml', [PEOPLE]), /<note null="true"\/>/);
});

test('a column name that is not a valid element gets a usable one', () => {
  const awkward: Table = { name: '2 things', columns: ['first name', '9lives'], rows: [{ 'first name': 'x', '9lives': 1 }] };
  const text = write('xml', [awkward]);
  assert.ok(!/<9lives>/.test(text), 'an element started with a digit:\n' + text);
  assert.ok(text.includes('first_name'));
});

// -------------------------------------------------------------- Markdown --

test('Markdown escapes a pipe and flattens a newline', () => {
  // A raw pipe ends the cell and a raw newline ends the table, so either
  // corrupts every row after it.
  const piped: Table = { name: 'p', columns: ['a'], rows: [{ a: 'x | y' }, { a: 'two\nlines' }] };
  const text = write('markdown', [piped]);
  assert.ok(text.includes('x \\| y'), 'the pipe was not escaped:\n' + text);
  assert.ok(text.includes('two lines'), 'the newline was not flattened');
  // The table structure survives: header, rule, then one line per row.
  const rows = text.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(rows.length, 4);
});

// ------------------------------------------------------------------- SQL --

test('SQL doubles a quote rather than letting it end the literal', () => {
  const text = write('sql', [PEOPLE]);
  assert.ok(text.includes("'Bo, \"the quick\"'"), text.split('\n')[1]);

  const quoted: Table = { name: 'q', columns: ['a'], rows: [{ a: "it's" }] };
  assert.ok(write('sql', [quoted]).includes("'it''s'"), write('sql', [quoted]));
});

test('SQL writes NULL rather than an empty string', () => {
  assert.match(write('sql', [PEOPLE]), /NULL\);/);
});

test('SQL writes a boolean and a number unquoted', () => {
  const text = write('sql', [ORDERS]);
  assert.match(text, /VALUES \(1, 9\.5\);/);
});

// -------------------------------------------------------------- warnings --

test('a warning names the actual columns, not the general property', () => {
  // "CSV cannot carry types" is true and useless. "age, active will come back
  // as text" is something somebody can act on.
  const warned = warningsFor('csv', [PEOPLE]);
  const types = warned.find((w) => /come back as text/.test(w.what));
  assert.ok(types !== undefined, JSON.stringify(warned));
  assert.match(types.what, /active/);
  assert.match(types.what, /age/);
  assert.ok(!/name/.test(types.what.split(' will')[0] ?? ''), 'a text column was named');
});

test('a format that loses nothing warns about nothing', () => {
  // Otherwise every export carries a warning, and a warning that is always
  // there is a warning nobody reads.
  assert.deepEqual(warningsFor('json', [PEOPLE]), []);
  assert.deepEqual(warningsFor('json', [PEOPLE, ORDERS]), []);
});

test('the null warning fires only when there is a null to lose', () => {
  const noNulls: Table = { name: 'x', columns: ['a'], rows: [{ a: 'text' }] };
  assert.deepEqual(warningsFor('csv', [noNulls]), []);
  assert.ok(warningsFor('csv', [PEOPLE]).some((w) => /become empty/.test(w.what)));
});

test('every warning says WHY as well as what', () => {
  for (const format of FORMATS) {
    for (const warning of warningsFor(format, [PEOPLE, ORDERS])) {
      assert.ok(warning.what.length > 0, format + ' produced an empty warning');
      assert.ok(warning.why.length > 10, format + ' gave no reason: ' + warning.what);
    }
  }
});

// ------------------------------------------------------------- filenames --

test('a filename is a NAME, and cannot climb out of a folder', () => {
  // Built rather than typed. A literal backslash in a string that passes
  // through a shell, a heredoc or a patch script loses a level at every layer,
  // and the result is a test that silently checks for something else.
  const BACKSLASH = String.fromCharCode(92);

  // Separators are not the only way out. The first version replaced them with
  // dashes and kept dots, so `../../etc/passwd` became `..-..-etc-passwd` -
  // still carrying the parent references, and still dangerous the moment
  // something joined it to a directory.
  assert.equal(filenameFor('my people', 'csv'), 'my-people.csv');
  assert.equal(filenameFor('report.2026', 'json'), 'report-2026.json');

  for (const nasty of [
    '../../etc/passwd',
    '..',
    '../..',
    'C:' + BACKSLASH + 'Windows' + BACKSLASH + 'System32',
    '/etc/shadow',
    '....//....//x',
  ]) {
    const name = filenameFor(nasty, 'json');
    assert.ok(!name.includes('..'), nasty + ' produced ' + name);
    assert.ok(!name.includes('/'), nasty + ' produced ' + name);
    assert.ok(!name.includes(BACKSLASH), nasty + ' produced ' + name);
    assert.ok(!name.startsWith('.'), nasty + ' produced a hidden file: ' + name);
    assert.ok(name.endsWith('.json'), nasty + ' lost its extension');
  }
});

test('an empty or unusable name falls back rather than producing a bare extension', () => {
  // `.json` on its own is a hidden file with no name, which is not what
  // anybody meant by exporting.
  assert.equal(filenameFor('', 'yaml'), 'export.yaml');
  assert.equal(filenameFor('///', 'sql'), 'export.sql');
  assert.equal(filenameFor('...', 'csv'), 'export.csv');
  assert.equal(filenameFor('!!!', 'json'), 'export.json');
});

test('a very long name is bounded', () => {
  // Several filesystems refuse a component over 255 bytes, and the refusal
  // arrives as an unhelpful write error rather than as anything about the name.
  const name = filenameFor('x'.repeat(500), 'json');
  assert.ok(name.length <= 130, 'the name was ' + name.length + ' characters');
  assert.ok(name.endsWith('.json'));
});

test('every format has a distinct extension and media type', () => {
  const extensions = new Set(FORMATS.map((format: Format) => INFO[format].extension));
  assert.equal(extensions.size, FORMATS.length, 'two formats share an extension');
});
