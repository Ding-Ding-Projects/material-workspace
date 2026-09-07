/**
 * Tables and images in a paginated document.
 *
 * Every trap here produces a document that looks plausible and is wrong, which
 * is why each has its own test: none of them throws, and none of them shows up
 * as anything but "the table renders oddly".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type LayoutResult, type TextMeasurer, layout } from '../../app/engines/text/layout';
import { type Block, type TextDocument } from '../../app/engines/text/model';
import {
  CELL_PADDING,
  fitImage,
  layoutTable,
  normaliseWidths,
  splitTable,
} from '../../app/engines/text/table';

/**
 * A measurer with no font behind it.
 *
 * Deterministic on purpose: a layout test against a real font measures the
 * font, and passes or fails on whichever machine it runs on.
 */
const measurer: TextMeasurer = {
  width: (text) => text.length * 6,
  height: (style) => style.size * 1.2,
};

const documentWith = (blocks: Block[]): TextDocument => ({
  schema: 'material-workspace/text@1',
  blocks,
  footnotes: [],
  page: {
    width: 400,
    height: 300,
    marginTop: 20,
    marginRight: 20,
    marginBottom: 20,
    marginLeft: 20,
  },
  defaultStyle: { family: 'Test', size: 10, lineHeight: 1.2 },
});

const paragraph = (id: string, text: string): Block => ({
  id,
  kind: 'paragraph',
  runs: [{ text, formatting: {} }],
  style: {},
});

const cell = (text: string) => ({ blocks: [paragraph('c-' + text, text)] });

const tableBlock = (
  id: string,
  rows: { cells: { blocks: Block[] }[]; header?: boolean }[],
  widths: number[],
): Block => ({
  id,
  kind: 'table',
  runs: [],
  style: {},
  table: { rows, columnWidths: widths },
});

// -------------------------------------------------------------- the widths --

test('column widths are shared out to sum EXACTLY to the space available', () => {
  // Falling short leaves a gap down the side; overshooting pushes the last
  // column off the page. Both read as a rendering fault.
  const widths = normaliseWidths([1, 1, 2], 400);
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 400);
  assert.deepEqual(widths, [100, 100, 200]);
});

test('proportions are kept, so an author who made one column wider keeps it', () => {
  const widths = normaliseWidths([50, 150], 400);
  assert.equal(widths[1], (widths[0] as number) * 3);
});

test('a column asking for nothing still gets space rather than vanishing', () => {
  const widths = normaliseWidths([0, 0, 0], 300);
  assert.equal(widths.length, 3);
  assert.ok(widths.every((width) => width > 0), JSON.stringify(widths));
  assert.equal(Math.round(widths.reduce((sum, width) => sum + width, 0)), 300);
});

test('rounding lands on the last column, not scattered through the row', () => {
  const widths = normaliseWidths([1, 1, 1], 100);
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100);
});

// --------------------------------------------------------------- the cells --

test('a cell wraps against its OWN width, not the page width', () => {
  // Measuring against the page gives cells that never wrap, so text runs
  // straight over the column beside it and the table appears to have no
  // columns at all.
  const document = documentWith([]);
  const long = 'one two three four five six seven eight nine ten';
  const laid = layoutTable(
    { rows: [{ cells: [cell(long), cell('x')] }], columnWidths: [1, 1] },
    360,
    document,
    measurer,
  );

  const wide = laid.rows[0]?.cells[0];
  assert.ok(wide !== undefined);
  // 180pt wide less padding, at 6pt a character, is about 28 characters a
  // line - so a 47-character string cannot be one line.
  assert.ok((wide?.lines.length ?? 0) > 1, 'the cell did not wrap: ' + wide?.lines.length);
  for (const line of wide?.lines ?? []) {
    const width = line.runs.reduce((sum, run) => sum + run.width, 0);
    assert.ok(width <= 180 - CELL_PADDING * 2 + 6, 'a line overflowed its cell: ' + width);
  }
});

test('every cell in a row gets the ROW height, or the borders do not line up', () => {
  const document = documentWith([]);
  const laid = layoutTable(
    {
      rows: [{ cells: [cell('short'), cell('a much longer piece of text that wraps over lines')] }],
      columnWidths: [1, 1],
    },
    200,
    document,
    measurer,
  );

  const row = laid.rows[0];
  assert.ok(row !== undefined);
  // The row's height is the tallest cell's, and it is the row that carries it.
  const tallest = Math.max(...(row?.cells.map((one) => one.naturalHeight) ?? [0]));
  assert.equal(row?.height, tallest);
});

test('an empty cell still occupies its column', () => {
  // Dropping it shifts every later cell one column left, and the result is a
  // plausible table that is not the one anybody wrote.
  const document = documentWith([]);
  const laid = layoutTable(
    { rows: [{ cells: [cell('a')] }], columnWidths: [1, 1, 1] },
    300,
    document,
    measurer,
  );
  assert.equal(laid.rows[0]?.cells.length, 3);
  assert.equal(laid.rows[0]?.cells[2]?.x, 200);
});

test('a row is never shorter than one line of text, even when every cell is empty', () => {
  const document = documentWith([]);
  const laid = layoutTable(
    { rows: [{ cells: [{ blocks: [] }, { blocks: [] }] }], columnWidths: [1, 1] },
    200,
    document,
    measurer,
  );
  assert.ok((laid.rows[0]?.height ?? 0) >= 12, String(laid.rows[0]?.height));
});

// ------------------------------------------------------------ the splitting --

test('a table breaks at a ROW boundary, never through the middle of one', () => {
  const document = documentWith([]);
  const laid = layoutTable(
    {
      rows: [
        { cells: [cell('one')] },
        { cells: [cell('two')] },
        { cells: [cell('three')] },
        { cells: [cell('four')] },
      ],
      columnWidths: [1],
    },
    200,
    document,
    measurer,
  );

  const rowHeight = laid.rows[0]?.height ?? 0;
  // Room for two and a half rows: two must be taken, not two and a half.
  const slice = splitTable(laid.rows, rowHeight * 2.5);
  assert.equal(slice.rows.length, 2);
  assert.equal(slice.remaining.length, 2);
  assert.equal(slice.height, rowHeight * 2);
});

test('a header row repeats on the second page, so it is not a wall of numbers', () => {
  const document = documentWith([]);
  const laid = layoutTable(
    {
      rows: [
        { cells: [cell('Name')], header: true },
        { cells: [cell('one')] },
        { cells: [cell('two')] },
      ],
      columnWidths: [1],
    },
    200,
    document,
    measurer,
  );

  const headers = laid.rows.filter((row) => row.header);
  const body = laid.rows.filter((row) => !row.header);
  const rowHeight = laid.rows[0]?.height ?? 0;

  const second = splitTable(body, rowHeight * 2, headers);
  assert.equal(second.rows[0]?.header, true, 'the header did not repeat');
  assert.equal(second.rows.length, 2, 'the repeated header did not take a row of room');
});

test('a row taller than a whole page is placed and REPORTED, not clipped', () => {
  // A row that cannot fit anywhere is a document problem the author has to
  // know about, and silently cutting it off loses whatever was at the bottom.
  const document = documentWith([]);
  const laid = layoutTable(
    { rows: [{ cells: [cell('a very tall row indeed with a great deal of text in it')] }], columnWidths: [1] },
    60,
    document,
    measurer,
  );

  const slice = splitTable(laid.rows, 10);
  assert.equal(slice.oversized, true);
  assert.equal(slice.rows.length, 1, 'the row was dropped rather than placed');
  assert.equal(slice.remaining.length, 0, 'it would have looped for ever');
});

// ------------------------------------------------- through the whole layout --

test('a table reaches the page, with its rows on it', () => {
  const result: LayoutResult = layout(
    documentWith([
      paragraph('p1', 'Before'),
      tableBlock('t1', [{ cells: [cell('a'), cell('b')] }], [1, 1]),
      paragraph('p2', 'After'),
    ]),
    measurer,
  );

  const page = result.pages[0];
  assert.equal(page?.tables.length, 1);
  assert.equal(page?.tables[0]?.rows[0]?.cells.length, 2);
  // And the paragraph after it is BELOW it, not on top of it.
  const afterLine = page?.lines.find((line) => line.blockId === 'p2');
  const table = page?.tables[0];
  assert.ok(afterLine !== undefined && table !== undefined);
  assert.ok(
    (afterLine?.y ?? 0) >= (table?.y ?? 0) + (table?.height ?? 0),
    'the paragraph after the table overlapped it',
  );
});

test('a long table runs onto a second page rather than off the bottom of the first', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    cells: [cell('row ' + index)],
  }));
  const result = layout(documentWith([tableBlock('t1', rows, [1])]), measurer);

  assert.ok(result.pages.length > 1, 'it all stayed on one page');
  for (const page of result.pages) {
    for (const table of page.tables) {
      assert.ok(
        table.y + table.height <= page.contentHeight + 1,
        'a table overflowed page ' + page.index,
      );
    }
  }
});

// -------------------------------------------------------------- the images --

test('an image scaled to fit keeps its proportions', () => {
  // Changing only the width stretches it, and a stretched photograph is a
  // defect nobody reports because it looks like a bad photograph.
  const fitted = fitImage(
    { source: 'x', width: 800, height: 400, naturalWidth: 800, naturalHeight: 400, alt: 'a' },
    400,
  );
  assert.equal(fitted.width, 400);
  assert.equal(fitted.height, 200);
  assert.equal(fitted.reduced, true);
});

test('an image that already fits is left alone, not scaled up', () => {
  const fitted = fitImage(
    { source: 'x', width: 100, height: 50, naturalWidth: 100, naturalHeight: 50, alt: 'a' },
    400,
  );
  assert.deepEqual([fitted.width, fitted.height, fitted.reduced], [100, 50, false]);
});

test('an image reaches the page carrying its alternative text', () => {
  const result = layout(
    documentWith([
      {
        id: 'i1',
        kind: 'image',
        runs: [],
        style: {},
        image: {
          source: 'data:image/png;base64,AAAA',
          width: 200,
          height: 100,
          naturalWidth: 200,
          naturalHeight: 100,
          alt: 'A chart of monthly totals',
        },
      },
    ]),
    measurer,
  );

  const image = result.pages[0]?.images[0];
  assert.equal(image?.alt, 'A chart of monthly totals');
  assert.equal(image?.width, 200);
});

test('a whole image moves to the next page rather than being cut in half', () => {
  // Half a photograph is not a smaller photograph, it is a mistake.
  const blocks: Block[] = [];
  for (let index = 0; index < 12; index += 1) blocks.push(paragraph('p' + index, 'filler line'));
  blocks.push({
    id: 'big',
    kind: 'image',
    runs: [],
    style: {},
    image: {
      source: 'x',
      width: 200,
      height: 180,
      naturalWidth: 200,
      naturalHeight: 180,
      alt: 'tall',
    },
  });

  const result = layout(documentWith(blocks), measurer);
  for (const page of result.pages) {
    for (const image of page.images) {
      assert.ok(
        image.y + image.height <= page.contentHeight + 1,
        'an image overflowed page ' + page.index,
      );
    }
  }
  assert.ok(
    result.pages.some((page) => page.images.length > 0),
    'the image was lost entirely',
  );
});

test('a centred image is centred, and an end-aligned one sits at the end', () => {
  const make = (align: 'start' | 'center' | 'end'): number => {
    const result = layout(
      documentWith([
        {
          id: 'i',
          kind: 'image',
          runs: [],
          style: { align },
          image: {
            source: 'x',
            width: 100,
            height: 50,
            naturalWidth: 100,
            naturalHeight: 50,
            alt: 'a',
          },
        },
      ]),
      measurer,
    );
    return result.pages[0]?.images[0]?.x ?? -1;
  };

  // The content area is 360pt wide; a 100pt image centres at 130.
  assert.equal(make('start'), 0);
  assert.equal(make('center'), 130);
  assert.equal(make('end'), 260);
});

// ------------------------------------------------- what the export admits --

test('a table survives a whole round trip through .docx', async () => {
  // The end-to-end claim. Every layer between here and the file has its own
  // chance to lose the table quietly, and a block with no text runs writes an
  // empty paragraph - so a partial failure looks exactly like a document that
  // never had a table in it.
  const { documentToDocx, docxToDocument } = await import('../../app/engines/codec/docx-bridge');
  const { readDocx, writeDocx } = await import('../../app/engines/codec/docx');

  const original = documentWith([
    paragraph('p', 'Before the table'),
    {
      id: 't',
      kind: 'table',
      runs: [],
      style: {},
      table: {
        rows: [
          { cells: [cell('Name'), cell('Amount')], header: true },
          { cells: [cell('Chan'), cell('30')] },
        ],
        columnWidths: [120, 60],
      },
    },
  ]);

  const bytes = writeDocx(documentToDocx(original));
  const back = docxToDocument(await readDocx(bytes));

  const table = back.blocks.find((block) => block.kind === 'table');
  assert.ok(table !== undefined, 'the table did not come back at all');
  assert.equal(table?.table?.rows.length, 2);
  assert.equal(table?.table?.rows[0]?.header, true, 'the header row lost its marking');
  assert.equal(table?.table?.rows[0]?.cells.length, 2);

  const text = (row: number, column: number): string =>
    (table?.table?.rows[row]?.cells[column]?.blocks ?? [])
      .flatMap((block) => block.runs.map((run) => run.text))
      .join('');
  assert.equal(text(0, 0), 'Name');
  assert.equal(text(1, 1), '30');
});

test('the column widths come back as points, not twentieths of one', async () => {
  // w:w carries twentieths. Keeping the raw numbers makes every column twenty
  // times too wide, which normalisation then hides by scaling them - so the
  // proportions survive and the sizes are meaningless, which is the harder
  // version to notice.
  const { documentToDocx, docxToDocument } = await import('../../app/engines/codec/docx-bridge');
  const { readDocx, writeDocx } = await import('../../app/engines/codec/docx');

  const original = documentWith([
    {
      id: 't',
      kind: 'table',
      runs: [],
      style: {},
      table: { rows: [{ cells: [cell('a'), cell('b')] }], columnWidths: [120, 60] },
    },
  ]);

  const back = docxToDocument(await readDocx(writeDocx(documentToDocx(original))));
  const widths = back.blocks.find((block) => block.kind === 'table')?.table?.columnWidths ?? [];
  assert.deepEqual(widths, [120, 60]);
});

test('a table survives a whole round trip through .odt as well', async () => {
  const { documentToDocx, docxToDocument } = await import('../../app/engines/codec/docx-bridge');
  const { readOdt, writeOdt } = await import('../../app/engines/codec/odf');

  const original = documentWith([
    {
      id: 't',
      kind: 'table',
      runs: [],
      style: {},
      table: {
        rows: [
          { cells: [cell('Heading')], header: true },
          { cells: [cell('body')] },
        ],
        columnWidths: [200],
      },
    },
  ]);

  const back = docxToDocument(await readOdt(writeOdt(documentToDocx(original))));
  const table = back.blocks.find((block) => block.kind === 'table');
  assert.ok(table !== undefined, 'the table did not come back at all');
  assert.equal(table?.table?.rows.length, 2);
  // The header rows are their own element in ODF. A reader that only looks at
  // table:table-row misses them and the table arrives one row short.
  assert.equal(table?.table?.rows[0]?.header, true, 'the ODF header row was lost');
});

test('an empty cell survives the round trip rather than collapsing the row', async () => {
  const { documentToDocx, docxToDocument } = await import('../../app/engines/codec/docx-bridge');
  const { readDocx, writeDocx } = await import('../../app/engines/codec/docx');

  const original = documentWith([
    {
      id: 't',
      kind: 'table',
      runs: [],
      style: {},
      table: {
        rows: [{ cells: [cell('a'), { blocks: [] }, cell('c')] }],
        columnWidths: [1, 1, 1],
      },
    },
  ]);

  const back = docxToDocument(await readDocx(writeDocx(documentToDocx(original))));
  const row = back.blocks.find((block) => block.kind === 'table')?.table?.rows[0];
  assert.equal(row?.cells.length, 3, 'the empty cell was dropped and the row shifted left');
});

test('a document with no table and no image claims no loss for either', async () => {
  // A warning that is always there is a warning nobody reads.
  const { describeConversionLoss } = await import('../../app/engines/codec/docx-bridge');
  const losses = describeConversionLoss(documentWith([paragraph('p', 'plain')]));
  assert.ok(!losses.some((loss) => loss.includes('table')), JSON.stringify(losses));
  assert.ok(!losses.some((loss) => loss.includes('image')), JSON.stringify(losses));
});

test('an image is admitted too, and counted', async () => {
  const { describeConversionLoss } = await import('../../app/engines/codec/docx-bridge');
  const losses = describeConversionLoss(
    documentWith([
      {
        id: 'i',
        kind: 'image',
        runs: [],
        style: {},
        image: {
          source: 'x',
          width: 10,
          height: 10,
          naturalWidth: 10,
          naturalHeight: 10,
          alt: 'a',
        },
      },
    ]),
  );
  assert.ok(losses.some((loss) => loss.includes('1 image')), JSON.stringify(losses));
});
