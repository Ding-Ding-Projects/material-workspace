/**
 * OpenDocument conformance.
 *
 * The formula translation and the run-length encoding get the most attention,
 * because they are the two places where a reader that "works" produces a file
 * that is quietly wrong rather than one that fails.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  a1FormulaToOdf,
  odfFormulaToA1,
  readOds,
  readOdt,
  writeOds,
  writeOdt,
} from '../../app/engines/codec/odf';
import { readZip, writeZip } from '../../app/engines/codec/zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// -------------------------------------------------------- formula syntax --

test('an OpenDocument formula translates to A1', () => {
  assert.equal(odfFormulaToA1('of:=SUM([.A1:.A9])'), 'SUM(A1:A9)');
  assert.equal(odfFormulaToA1('of:=[.A1]+[.B2]'), 'A1+B2');
  assert.equal(odfFormulaToA1('=[.C3]*2'), 'C3*2');
  assert.equal(odfFormulaToA1('of:=[Sheet2.A1]'), 'Sheet2!A1');
});

test('an A1 formula translates to OpenDocument', () => {
  // Storing an A1 formula unchanged produces a file that opens with every
  // formula broken, so this is not optional dressing.
  assert.equal(a1FormulaToOdf('SUM(A1:A9)'), 'of:=SUM([.A1:.A9])');
  assert.equal(a1FormulaToOdf('=A1+B2'), 'of:=[.A1]+[.B2]');
  assert.equal(a1FormulaToOdf('Sheet2!A1'), 'of:=[Sheet2.A1]');
});

test('formula translation round-trips both ways', () => {
  for (const a1 of ['SUM(A1:A9)', 'A1+B2', 'MAX(B2:B10)*2', 'IF(A1>0,B1,C1)']) {
    assert.equal(odfFormulaToA1(a1FormulaToOdf(a1)), a1, 'failed for ' + a1);
  }
});

test('a range lands inside ONE bracket pair, not two', () => {
  // Two pairs is a syntax error in the format, and it looks entirely
  // reasonable if you convert each reference independently.
  const converted = a1FormulaToOdf('SUM(A1:A9)');
  assert.equal(converted.split('[').length - 1, 1);
  assert.ok(converted.includes('[.A1:.A9]'));
});

// -------------------------------------------------------------- the shape --

test('the mimetype entry is written FIRST and stored', async () => {
  // A reader identifies the file by reading that entry at a fixed offset
  // without unpacking the archive, so its position is part of the format.
  const bytes = writeOds({ sheets: [{ name: 'S', cells: [{ column: 0, row: 0, value: 1 }] }] });

  // The local header of the first entry sits at offset 0, its name at 30.
  const name = decoder.decode(bytes.subarray(30, 38));
  assert.equal(name, 'mimetype');

  const parts = await readZip(bytes);
  assert.equal(
    decoder.decode(parts.get('mimetype')),
    'application/vnd.oasis.opendocument.spreadsheet',
  );
});

test('a file declaring the wrong mimetype is refused', async () => {
  const wrong = writeZip([
    { name: 'mimetype', data: encoder.encode('application/vnd.oasis.opendocument.text') },
    { name: 'content.xml', data: encoder.encode('<a/>') },
  ]);
  await assert.rejects(() => readOds(wrong), /declares itself as/);
});

// ---------------------------------------------------------------- .ods --

function handBuiltOds(tableXml: string): Uint8Array {
  return writeZip([
    {
      name: 'mimetype',
      data: encoder.encode('application/vnd.oasis.opendocument.spreadsheet'),
    },
    {
      name: 'content.xml',
      data: encoder.encode(
        '<?xml version="1.0"?>' +
          '<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x">' +
          '<office:body><office:spreadsheet>' +
          tableXml +
          '</office:spreadsheet></office:body></office:document-content>',
      ),
    },
  ]);
}

test('repeated empty cells are a GAP, not a collapse', async () => {
  // The defect this guards: a sheet with a value in A1 and another further
  // along reads as two adjacent cells, which looks like a tidy little table
  // and is wrong.
  const workbook = await readOds(
    handBuiltOds(
      '<table:table table:name="S"><table:table-row>' +
        '<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>' +
        '<table:table-cell table:number-columns-repeated="5"/>' +
        '<table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>' +
        '</table:table-row></table:table>',
    ),
  );
  const cells = workbook.sheets[0]?.cells ?? [];
  assert.deepEqual(
    cells.map((cell) => [cell.column, cell.value]),
    [
      [0, 1],
      [6, 2],
    ],
  );
});

test('a repeated cell that holds a value is repeated in full', async () => {
  const workbook = await readOds(
    handBuiltOds(
      '<table:table table:name="S"><table:table-row>' +
        '<table:table-cell table:number-columns-repeated="3" office:value-type="float" office:value="7">' +
        '<text:p>7</text:p></table:table-cell>' +
        '</table:table-row></table:table>',
    ),
  );
  assert.deepEqual(
    (workbook.sheets[0]?.cells ?? []).map((cell) => [cell.column, cell.value]),
    [
      [0, 7],
      [1, 7],
      [2, 7],
    ],
  );
});

test('an enormous repeat count is treated as padding, not honoured', async () => {
  // Writers pad rows to the sheet's full width with one repeated empty cell.
  // Honouring the count allocates a million cells for a row of one value.
  const workbook = await readOds(
    handBuiltOds(
      '<table:table table:name="S"><table:table-row>' +
        '<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>' +
        '<table:table-cell table:number-columns-repeated="1048576"/>' +
        '</table:table-row></table:table>',
    ),
  );
  assert.equal(workbook.sheets[0]?.cells.length, 1);
});

test('a cell value comes from the ATTRIBUTE, not the displayed text', async () => {
  // The text is a locale-formatted display string. Reading it gives a string
  // where a number belongs.
  const workbook = await readOds(
    handBuiltOds(
      '<table:table table:name="S"><table:table-row>' +
        '<table:table-cell office:value-type="float" office:value="1234.5">' +
        '<text:p>1,234.50</text:p></table:table-cell>' +
        '</table:table-row></table:table>',
    ),
  );
  assert.equal(workbook.sheets[0]?.cells[0]?.value, 1234.5);
});

test('a formula cell is read and translated', async () => {
  const workbook = await readOds(
    handBuiltOds(
      '<table:table table:name="S"><table:table-row>' +
        '<table:table-cell table:formula="of:=SUM([.A1:.A9])" office:value-type="float" office:value="42">' +
        '<text:p>42</text:p></table:table-cell>' +
        '</table:table-row></table:table>',
    ),
  );
  const cell = workbook.sheets[0]?.cells[0];
  assert.equal(cell?.formula, 'SUM(A1:A9)');
  assert.equal(cell?.value, 42);
});

test('an ods this module writes reads back with values, gaps and formulas intact', async () => {
  const written = writeOds({
    sheets: [
      {
        name: 'Orders',
        cells: [
          { column: 0, row: 0, value: 'Product', isText: true },
          { column: 0, row: 1, value: 'Har gow', isText: true },
          { column: 1, row: 1, value: 3 },
          // A deliberate gap, to exercise the run-length encoding on both
          // sides of the round trip.
          { column: 5, row: 1, value: true },
          { column: 1, row: 2, formula: 'SUM(B2:B2)', value: 3 },
        ],
      },
    ],
  });

  const read = await readOds(written);
  const sheet = read.sheets[0];
  const at = (column: number, row: number) =>
    sheet?.cells.find((cell) => cell.column === column && cell.row === row);

  assert.equal(sheet?.name, 'Orders');
  assert.equal(at(0, 1)?.value, 'Har gow');
  assert.equal(at(1, 1)?.value, 3);
  assert.equal(at(5, 1)?.value, true);
  assert.equal(at(1, 2)?.formula, 'SUM(B2:B2)');
  // Nothing invented in the gap.
  assert.equal(at(2, 1), undefined);
});

// ---------------------------------------------------------------- .odt --

test('an odt this module writes reads back with structure and formatting', async () => {
  const original = {
    blocks: [
      { kind: 'heading1' as const, runs: [{ text: 'Tea houses' }] },
      {
        kind: 'body' as const,
        runs: [{ text: 'A ' }, { text: 'bold', bold: true }, { text: ' word.' }],
      },
      { kind: 'bullet' as const, runs: [{ text: 'Har gow' }] },
      { kind: 'bullet' as const, runs: [{ text: 'Siu mai' }] },
    ],
  };

  const read = await readOdt(writeOdt(original));
  assert.deepEqual(
    read.blocks.map((block) => block.kind),
    ['heading1', 'body', 'bullet', 'bullet'],
  );
  assert.equal(read.blocks[1]?.runs.find((run) => run.bold === true)?.text, 'bold');
  assert.equal(
    read.blocks.map((block) => block.runs.map((run) => run.text).join('')).join('|'),
    'Tea houses|A bold word.|Har gow|Siu mai',
  );
});

test('consecutive list items go in ONE list, not one list each', async () => {
  // A document where every bullet is its own list restarts numbering at each
  // item, which is visible immediately in any reader.
  const bytes = writeOdt({
    blocks: [
      { kind: 'numbered', runs: [{ text: 'one' }] },
      { kind: 'numbered', runs: [{ text: 'two' }] },
      { kind: 'numbered', runs: [{ text: 'three' }] },
    ],
  });
  const parts = await readZip(bytes);
  const content = decoder.decode(parts.get('content.xml'));
  assert.equal(content.split('<text:list ').length - 1, 1);
  assert.equal(content.split('<text:list-item>').length - 1, 3);
});

test('a line break survives as a break element, not as a space', async () => {
  const read = await readOdt(
    writeOdt({ blocks: [{ kind: 'body', runs: [{ text: 'first\nsecond' }] }] }),
  );
  assert.equal(read.blocks[0]?.runs.map((run) => run.text).join(''), 'first\nsecond');
});

test('Cantonese and XML metacharacters survive a round trip', async () => {
  const hostile = '香港 1 < 2 & 3 > 0';
  const read = await readOdt(
    writeOdt({ blocks: [{ kind: 'body', runs: [{ text: hostile }] }] }),
  );
  assert.equal(read.blocks[0]?.runs.map((run) => run.text).join(''), hostile);
});

test('an explicit run of spaces is not collapsed', async () => {
  const bytes = writeZip([
    { name: 'mimetype', data: encoder.encode('application/vnd.oasis.opendocument.text') },
    {
      name: 'content.xml',
      data: encoder.encode(
        '<?xml version="1.0"?>' +
          '<office:document-content xmlns:office="o" xmlns:text="x">' +
          '<office:body><office:text>' +
          '<text:p>a<text:s text:c="4"/>b</text:p>' +
          '</office:text></office:body></office:document-content>',
      ),
    },
  ]);
  const read = await readOdt(bytes);
  assert.equal(read.blocks[0]?.runs.map((run) => run.text).join(''), 'a    b');
});

test('a file that is not an OpenDocument is refused clearly', async () => {
  const notOdf = writeZip([{ name: 'random.txt', data: encoder.encode('hi') }]);
  await assert.rejects(() => readOds(notOdf), /not an OpenDocument file/);
});
