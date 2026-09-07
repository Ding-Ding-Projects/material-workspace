/**
 * Format conformance, against a committed corpus of real files.
 *
 * These tests read BINARIES OFF DISK. They do not build a file, read it back,
 * and declare the format handled - a round trip through one module's own output
 * proves only that the module agrees with itself, which is true of a module
 * that is wrong about the format in a self-consistent way.
 *
 * Each fixture exercises one named feature and carries, beside it, the shape a
 * real producer emits and why a naive reader gets it wrong. Those notes are the
 * point: they are what turns a red test into a fix rather than into a
 * five-minute argument about what the file "should" contain.
 *
 * The inventory is HAND-WRITTEN in build-corpus.mjs. A rule that only checks
 * the fixtures it can find passes cleanly on an empty directory, which is the
 * exact failure this whole file exists to prevent - so the count is asserted
 * too.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { readDocx } from '../../app/engines/codec/docx';
import { readOds, readOdt } from '../../app/engines/codec/odf';
import { readXlsx } from '../../app/engines/codec/xlsx';

// @ts-expect-error - a build script, plain JavaScript by design.
import { CORPUS } from './build-corpus.mjs';

/**
 * The repository root, found by walking up for package.json.
 *
 * Not `import.meta.dirname` plus '..': tests are bundled into `.tmp/test/...`,
 * so at run time this file's directory is inside `.tmp` and every relative path
 * from it points at a directory that does not hold the corpus.
 */
function repositoryRoot(): string {
  let at = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(at, 'package.json'))) return at;
    at = path.dirname(at);
  }
  throw new Error('could not find the repository root from ' + import.meta.dirname);
}

const ROOT = repositoryRoot();
const FILES = path.join(ROOT, 'test', 'corpus', 'files');

interface Entry {
  file: string;
  format: string;
  feature: string;
  shape: string;
  expects: Record<string, unknown>;
}

const entries = CORPUS as Entry[];

function read(file: string): Uint8Array {
  const target = path.join(FILES, file);
  if (!fs.existsSync(target)) {
    throw new Error(
      'the corpus file ' + file + ' is missing. Run: node test/corpus/build-corpus.mjs',
    );
  }
  return new Uint8Array(fs.readFileSync(target));
}

// --------------------------------------------------------------- the set --

test('the corpus is on disk, so nothing below passes over an empty directory', () => {
  assert.ok(entries.length >= 16, 'the inventory lists only ' + entries.length + ' fixtures');
  for (const entry of entries) {
    const target = path.join(FILES, entry.file);
    assert.ok(fs.existsSync(target), entry.file + ' is inventoried and not on disk');
    assert.ok(fs.statSync(target).size > 200, entry.file + ' is too small to be a real container');
  }
});

test('every fixture says what it covers and where its shape came from', () => {
  // A fixture with no note is a fixture nobody can fix when it goes red: the
  // reader disagrees with the file and there is nothing to say which is right.
  for (const entry of entries) {
    assert.ok(entry.feature.length > 10, entry.file + ' has no feature description');
    assert.ok(entry.shape.length > 40, entry.file + ' does not record where its shape came from');
  }
});

test('every fixture is a real zip container, not XML with an extension', () => {
  for (const entry of entries) {
    const bytes = read(entry.file);
    assert.equal(bytes[0], 0x50, entry.file + ' does not begin PK');
    assert.equal(bytes[1], 0x4b, entry.file + ' does not begin PK');
  }
});

test('the corpus files are DEFLATED, as every real producer emits them', () => {
  // A reader that only handles stored entries passes against a corpus that only
  // contains stored entries, and fails on the first file anybody actually has.
  for (const entry of entries) {
    const bytes = read(entry.file);
    // The compression method is a 16-bit field at offset 8 of the local header.
    const method = bytes[8]! | (bytes[9]! << 8);
    assert.equal(method, 8, entry.file + ' is stored rather than deflated');
  }
});

// -------------------------------------------------------------- word --

test('paragraphs are paragraphs, and a break inside one is not a paragraph', async () => {
  const document = await readDocx(read('docx/paragraphs.docx'));
  assert.equal(document.blocks.length, 2);
  assert.equal(text(document.blocks[0]), 'First paragraph.');
  assert.equal(text(document.blocks[1]), 'Second\nafter a break');
});

test('an explicit bold OFF is off, not on', async () => {
  // THE ONE THAT LOOKS RIGHT AND IS WRONG. `<w:b w:val="0"/>` is present, so a
  // reader testing for presence marks it bold - and the document renders with a
  // word emphasised that the author deliberately un-emphasised.
  const document = await readDocx(read('docx/formatting.docx'));
  const runs = document.blocks[0]!.runs;
  assert.equal(runs[0]!.bold, true);
  assert.notEqual(runs[1]!.bold, true, 'an explicit off was read as on');
  assert.equal(runs[2]!.italic, true);
  assert.equal(runs[2]!.underline, true);
});

test('a Heading1 style becomes a heading, and an unstyled paragraph does not', async () => {
  const document = await readDocx(read('docx/styles.docx'));
  assert.equal(document.blocks[0]!.kind, 'heading1');
  assert.equal(document.blocks[1]!.kind, 'body');
});

test('numPr ALONE makes a list item, with no style beside it', async () => {
  // THE DEFECT THE CORPUS FOUND ON ITS FIRST RUN. The reader required a
  // ListParagraph style as well, so a list from Google Docs export or pandoc -
  // neither of which writes one - imported as flat body text with the numbering
  // silently gone.
  const document = await readDocx(read('docx/lists.docx'));
  assert.equal(document.blocks[0]!.kind, 'numbered');
  assert.equal(document.blocks[1]!.kind, 'numbered');
});

test('a list whose numbering cannot be resolved falls back to BULLET', async () => {
  // Guessing ordered would invent numbers the author never wrote. Bullet is the
  // safe default, and this fixture pins it so a later "improvement" cannot
  // quietly start guessing.
  const document = await readDocx(read('docx/lists-unknown-numbering.docx'));
  assert.equal(document.blocks[0]!.kind, 'bullet');
});

test('KNOWN LOSS: list nesting depth is not carried', async () => {
  // Asserted rather than left as a note, so the day the model grows a depth
  // this test goes red and somebody updates the documentation instead of
  // leaving a stale "not supported" behind. A loss that quietly stops being a
  // loss is how a caveat becomes a lie.
  const document = await readDocx(read('docx/lists.docx'));
  const blocks = document.blocks as unknown as readonly Record<string, unknown>[];
  assert.equal(
    blocks[1]!['listLevel'],
    undefined,
    'nesting depth now survives; update the documented losses',
  );
});

test('a tab is a tab and an entity is decoded exactly once', async () => {
  // Decoding twice turns `&amp;lt;` into `<`, which is how a document that
  // legitimately contains markup gets mangled.
  const document = await readDocx(read('docx/tabs-and-entities.docx'));
  assert.equal(text(document.blocks[0]), 'Before\tAfter');
  assert.equal(text(document.blocks[1]), 'Tom & Jerry <here>');
});

test('a preserved space is preserved, so words do not run together', async () => {
  const document = await readDocx(read('docx/preserved-space.docx'));
  assert.equal(text(document.blocks[0]), 'one two');
});

function text(block: { runs: readonly { text: string }[] } | undefined): string {
  return (block?.runs ?? []).map((run) => run.text).join('');
}

// ------------------------------------------------------------- excel --

test('a shared string is resolved through the table, not read as its index', async () => {
  const workbook = await readXlsx(read('xlsx/shared-strings.xlsx'));
  const sheet = workbook.sheets[0]!;
  assert.equal(cell(sheet, 'A1'), 'Alpha');
  assert.equal(cell(sheet, 'B1'), 'Beta');
});

test('numbers stay numbers and booleans stay booleans', async () => {
  const sheet = (await readXlsx(read('xlsx/numbers-and-booleans.xlsx'))).sheets[0]!;
  assert.equal(cell(sheet, 'A1'), 42);
  assert.equal(cell(sheet, 'B1'), -3.5);
  assert.equal(cell(sheet, 'C1'), true);
  assert.equal(cell(sheet, 'D1'), false);
});

test('a formula cell keeps the formula AND the value it was last computed as', async () => {
  const sheet = (await readXlsx(read('xlsx/formulas.xlsx'))).sheets[0]!;
  const target = at(sheet, 'C1');
  assert.ok(target !== undefined, 'C1 is missing');
  assert.equal(target?.formula, 'A1+B1');
  assert.equal(target?.value, 5);
});

test('an inline string is read, which streaming exporters emit instead of a shared one', async () => {
  const sheet = (await readXlsx(read('xlsx/inline-strings.xlsx'))).sheets[0]!;
  assert.equal(cell(sheet, 'A1'), 'Inline');
});

test('gaps stay gaps: a skipped cell is empty, not the next value shifted over', async () => {
  // Real sheets omit empty cells and jump row numbers. A reader that assumes
  // cells arrive contiguously puts every value one place to the left.
  const sheet = (await readXlsx(read('xlsx/sparse-rows.xlsx'))).sheets[0]!;
  assert.equal(cell(sheet, 'A1'), 1);
  assert.equal(cell(sheet, 'D1'), 4);
  assert.equal(cell(sheet, 'B5'), 25);
  assert.equal(cell(sheet, 'B1'), undefined, 'a gap was filled with a value');
  assert.equal(cell(sheet, 'A5'), undefined, 'a gap was filled with a value');
});

/** One cell by its A1 reference, since the model stores column and row. */
function at(
  sheet: { cells: readonly { column: number; row: number; value?: unknown; formula?: string }[] },
  reference: string,
): { column: number; row: number; value?: unknown; formula?: string } | undefined {
  const match = /^([A-Z]+)(\d+)$/.exec(reference);
  if (match === null) throw new Error('not an A1 reference: ' + reference);
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + (letter.charCodeAt(0) - 64);
  const row = Number(match[2]);
  return sheet.cells.find((entry) => entry.column === column - 1 && entry.row === row - 1)
    ?? sheet.cells.find((entry) => entry.column === column && entry.row === row);
}

function cell(
  sheet: { cells: readonly { column: number; row: number; value?: unknown }[] },
  reference: string,
): unknown {
  return at(sheet, reference)?.value;
}

// --------------------------------------------------------------- odf --

test('an ODF heading is a heading, not a paragraph that got missed', async () => {
  const document = await readOdt(read('odt/paragraphs.odt'));
  assert.equal(document.blocks.length, 2);
  assert.equal(document.blocks[0]!.kind, 'heading1');
  assert.equal(document.blocks[1]!.kind, 'body');
});

test('an ODF repeated space is expanded, so words keep their spacing', async () => {
  const document = await readOdt(read('odt/spaces.odt'));
  assert.equal(text(document.blocks[0]), 'one   two');
});

test('an ODF cell is read from its TYPED value, not from the text beside it', async () => {
  // The <text:p> inside a cell is a rendering of the value, in the producing
  // application's locale. Reading it gives a string where the sheet holds a
  // number, and "1.234,50" where it holds 1234.5.
  const sheet = (await readOds(read('ods/values.ods'))).sheets[0]!;
  assert.equal(cell(sheet, 'A1'), 42);
  assert.equal(cell(sheet, 'B1'), 'Alpha');
  assert.equal(cell(sheet, 'C1'), true);
});

test('a repeated cell is expanded, and a thousand-column empty repeat is not', async () => {
  // A trailing repeat of a thousand empty columns is normal in a real file.
  // Expanding it blindly allocates a million cells for an empty sheet.
  const sheet = (await readOds(read('ods/repeated-cells.ods'))).sheets[0]!;
  assert.equal(cell(sheet, 'A1'), 7);
  assert.equal(cell(sheet, 'B1'), 7);
  assert.equal(cell(sheet, 'C1'), 7);
  assert.equal(cell(sheet, 'D1'), undefined, 'an empty repeat was expanded into real cells');
  assert.ok(sheet.cells.length < 50, 'the sheet expanded to ' + sheet.cells.length + ' cells');
});
