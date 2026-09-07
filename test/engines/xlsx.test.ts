/**
 * XLSX and XML conformance.
 *
 * The reader is exercised against HAND-BUILT worksheet XML in the shapes real
 * writers actually emit — shared strings, omitted references, formula cells
 * carrying both a formula and a cached value — not only against files this
 * module wrote. A codec tested against its own output proves the two halves
 * agree with each other and nothing about the format.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  XmlError,
  childElements,
  parseXml,
  textOf,
  writeXml,
} from '../../app/engines/codec/xml';
import { readXlsx, serialToDate, writeXlsx } from '../../app/engines/codec/xlsx';
import { writeZip } from '../../app/engines/codec/zip';

const encoder = new TextEncoder();
const QUOTE = String.fromCharCode(34);

// --------------------------------------------------------------------- XML --

test('elements, attributes, text and self-closing tags parse', () => {
  const root = parseXml('<a x="1"><b>text</b><c/></a>');
  assert.equal(root.name, 'a');
  assert.equal(root.attributes.get('x'), '1');
  assert.equal(childElements(root).length, 2);
  assert.equal(textOf(root), 'text');
});

test('the five predefined entities and numeric references decode', () => {
  const root = parseXml('<a>&lt;&amp;&gt;&quot;&apos;&#65;&#x42;</a>');
  assert.equal(textOf(root), '<&>' + QUOTE + String.fromCharCode(39) + 'AB');
});

test('CDATA is literal, so entities inside it are NOT resolved', () => {
  const root = parseXml('<a><![CDATA[&lt;not an entity&gt;]]></a>');
  assert.equal(textOf(root), '&lt;not an entity&gt;');
});

test('a DOCTYPE is refused outright', () => {
  // This is the whole XXE and billion-laughs surface. Refusing it is more
  // reliable than configuring a parser not to expand entities, because there
  // is simply no code here that could.
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>'), XmlError);
});

test('mismatched tags are refused rather than guessed at', () => {
  assert.throws(() => parseXml('<a><b></a></b>'), XmlError);
  assert.throws(() => parseXml('<a><b></b>'), /unclosed/);
});

test('nesting beyond the limit is refused', () => {
  const deep = '<a>'.repeat(300) + '</a>'.repeat(300);
  assert.throws(() => parseXml(deep), /too deep/);
});

test('writing escapes text and attributes, including quotes', () => {
  const xml = writeXml(
    { name: 'a', attributes: { v: 'x"y<z' }, children: ['1 < 2 & 3'] },
    false,
  );
  assert.ok(xml.includes('&quot;'));
  assert.ok(xml.includes('&lt;'));
  assert.ok(xml.includes('1 &lt; 2 &amp; 3'));
  // And it round-trips.
  assert.equal(parseXml(xml).attributes.get('v'), 'x"y<z');
  assert.equal(textOf(parseXml(xml)), '1 < 2 & 3');
});

// -------------------------------------------------------------------- XLSX --

/** Build an xlsx by hand, in the shapes real writers emit. */
function handBuiltWorkbook(sheetXml: string, sharedStringsXml?: string): Uint8Array {
  const parts = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode('<?xml version="1.0"?><Types xmlns="x"/>'),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        '<?xml version="1.0"?><workbook><sheets>' +
          '<sheet name="Orders" sheetId="1" r:id="rId1"/>' +
          '</sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        '<?xml version="1.0"?><Relationships>' +
          '<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml) },
  ];
  if (sharedStringsXml !== undefined) {
    parts.push({ name: 'xl/sharedStrings.xml', data: encoder.encode(sharedStringsXml) });
  }
  return writeZip(parts);
}

test('a shared string is resolved through the table, not read as its index', async () => {
  // The defect this guards against returns 0, 1, 2 for text cells — numbers
  // that look entirely plausible in a spreadsheet and are completely wrong.
  const workbook = await readXlsx(
    handBuiltWorkbook(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
      '<?xml version="1.0"?><sst><si><t>Har gow</t></si><si><t>Siu mai</t></si></sst>',
    ),
  );
  const cells = workbook.sheets[0]?.cells ?? [];
  assert.equal(cells[0]?.value, 'Har gow');
  assert.equal(cells[1]?.value, 'Siu mai');
  assert.equal(cells[0]?.isText, true);
});

test('a run-formatted shared string is read whole, not truncated to its first run', async () => {
  const workbook = await readXlsx(
    handBuiltWorkbook(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        '</sheetData></worksheet>',
      '<?xml version="1.0"?><sst><si>' +
        '<r><t>Hong </t></r><r><t>Kong</t></r><r><t> tea</t></r>' +
        '</si></sst>',
    ),
  );
  assert.equal(workbook.sheets[0]?.cells[0]?.value, 'Hong Kong tea');
});

test('a cell that omits its reference is placed in the next column', async () => {
  // Ignoring this shifts every cell after the first omission one column left.
  const workbook = await readXlsx(
    handBuiltWorkbook(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1"><v>1</v></c><c><v>2</v></c><c><v>3</v></c></row>' +
        '</sheetData></worksheet>',
    ),
  );
  const cells = workbook.sheets[0]?.cells ?? [];
  assert.deepEqual(
    cells.map((cell) => [cell.column, cell.value]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  );
});

test('a formula cell keeps BOTH its formula and its cached value', async () => {
  // Reading only the formula shows nothing until recalculation; reading only
  // the value silently discards every formula in the workbook.
  const workbook = await readXlsx(
    handBuiltWorkbook(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>42</v></c></row>' +
        '</sheetData></worksheet>',
    ),
  );
  const cell = workbook.sheets[0]?.cells[0];
  assert.equal(cell?.formula, 'SUM(B1:B9)');
  assert.equal(cell?.value, 42);
});

test('booleans, inline strings and error cells are each read as themselves', async () => {
  const workbook = await readXlsx(
    handBuiltWorkbook(
      '<?xml version="1.0"?><worksheet><sheetData><row r="1">' +
        '<c r="A1" t="b"><v>1</v></c>' +
        '<c r="B1" t="b"><v>0</v></c>' +
        '<c r="C1" t="inlineStr"><is><t>inline</t></is></c>' +
        '<c r="D1" t="e"><v>#DIV/0!</v></c>' +
        '</row></sheetData></worksheet>',
    ),
  );
  const values = (workbook.sheets[0]?.cells ?? []).map((cell) => cell.value);
  assert.deepEqual(values, [true, false, 'inline', '#DIV/0!']);
});

test('the sheet name comes from the workbook part', async () => {
  const workbook = await readXlsx(
    handBuiltWorkbook('<?xml version="1.0"?><worksheet><sheetData/></worksheet>'),
  );
  assert.equal(workbook.sheets[0]?.name, 'Orders');
});

test('a file that is not an xlsx is refused clearly', async () => {
  const notXlsx = writeZip([{ name: 'random.txt', data: encoder.encode('hello') }]);
  await assert.rejects(() => readXlsx(notXlsx), /not an xlsx file/);
});

test('a workbook this module writes reads back with every value intact', async () => {
  const written = writeXlsx({
    sheets: [
      {
        name: 'Orders',
        cells: [
          { column: 0, row: 0, value: 'Product', isText: true },
          { column: 1, row: 0, value: 'Qty', isText: true },
          { column: 0, row: 1, value: 'Har gow', isText: true },
          { column: 1, row: 1, value: 3 },
          { column: 0, row: 2, value: 'Siu mai', isText: true },
          { column: 1, row: 2, value: 2 },
          { column: 1, row: 3, formula: 'SUM(B2:B3)', value: 5 },
          { column: 2, row: 1, value: true },
          { column: 3, row: 1, value: '  leading and trailing  ', isText: true },
        ],
      },
    ],
  });

  const read = await readXlsx(written);
  const sheet = read.sheets[0];
  assert.equal(sheet?.name, 'Orders');

  const at = (column: number, row: number) =>
    sheet?.cells.find((cell) => cell.column === column && cell.row === row);

  assert.equal(at(0, 0)?.value, 'Product');
  assert.equal(at(0, 1)?.value, 'Har gow');
  assert.equal(at(1, 1)?.value, 3);
  assert.equal(at(2, 1)?.value, true);
  assert.equal(at(1, 3)?.formula, 'SUM(B2:B3)');
  assert.equal(at(1, 3)?.value, 5);
  // xml:space="preserve" is what keeps this from being trimmed.
  assert.equal(at(3, 1)?.value, '  leading and trailing  ');
});

test('repeated strings are shared rather than written once each', () => {
  const repeated = Array.from({ length: 50 }, (_, index) => ({
    column: 0,
    row: index,
    value: 'the same category every time',
    isText: true as const,
  }));
  const written = writeXlsx({ sheets: [{ name: 'S', cells: repeated }] });
  const text = new TextDecoder().decode(written);
  // The string must appear once in the shared table, not fifty times.
  const occurrences = text.split('the same category every time').length - 1;
  assert.equal(occurrences, 1);
});

test('the 1900 leap-year bug is reproduced deliberately, not corrected', () => {
  // Day 60 is 29 February 1900, a date that did not exist. Correcting it
  // shifts every earlier date by one day relative to every other application.
  const day59 = serialToDate(59);
  const day61 = serialToDate(61);
  assert.equal(day59.toISOString().slice(0, 10), '1900-02-28');
  assert.equal(day61.toISOString().slice(0, 10), '1900-03-01');
  // And a modern date lands correctly.
  assert.equal(serialToDate(45000).toISOString().slice(0, 10), '2023-03-15');
});

test('an empty workbook is refused rather than written as a broken file', () => {
  assert.throws(() => writeXlsx({ sheets: [] }), /at least one sheet/);
});
