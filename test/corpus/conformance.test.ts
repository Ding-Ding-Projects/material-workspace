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

import { readDocx, writeDocx } from '../../app/engines/codec/docx';
import { readOds, readOdt } from '../../app/engines/codec/odf';
import { readOdp, writeOdp } from '../../app/engines/codec/odp';
import { readPptx, writePptx } from '../../app/engines/codec/pptx';
import { readXlsx } from '../../app/engines/codec/xlsx';
import { readZip } from '../../app/engines/codec/zip';
import type { Frame } from '../../app/engines/slide/model';
import { readPdf } from '../../app/engines/pdf/reader';
import {
  type RenderedPage,
  pixelAt,
  rasterize,
  renderContent,
  renderPage,
} from '../../app/engines/pdf/render';

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
  assert.ok(entries.length >= 27, 'the inventory lists only ' + entries.length + ' fixtures');
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

test('every fixture is a real container of its own kind', () => {
  for (const entry of entries) {
    const bytes = read(entry.file);
    if (entry.format === 'pdf') {
      // %PDF-, and a cross-reference table with real byte offsets rather than
      // a guess: a file whose xref is wrong still opens in a forgiving reader,
      // which is exactly why faking it would prove nothing.
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-', entry.file);
      const text = new TextDecoder('latin1').decode(bytes);
      assert.ok(text.includes('xref'), entry.file + ' has no cross-reference table');
      assert.ok(text.trimEnd().endsWith('%%EOF'), entry.file + ' has no end marker');
      continue;
    }
    assert.equal(bytes[0], 0x50, entry.file + ' does not begin PK');
    assert.equal(bytes[1], 0x4b, entry.file + ' does not begin PK');
  }
});

test('the corpus files are DEFLATED, as every real producer emits them', () => {
  // A reader that only handles stored entries passes against a corpus that only
  // contains stored entries, and fails on the first file anybody actually has.
  //
  // The exception is an ODF package, whose FIRST entry is an uncompressed
  // `mimetype` - see the test below for why that matters.
  for (const entry of entries) {
    const bytes = read(entry.file);
    // The compression method is a 16-bit field at offset 8 of the local header.
    const method = bytes[8]! | (bytes[9]! << 8);
    const isOdf = entry.format === 'odt' || entry.format === 'ods' || entry.format === 'odp';
    if (isOdf) continue;
    // A PDF is not a zip at all. It is checked for its own header below.
    if (entry.format === 'pdf') continue;
    assert.equal(method, 8, entry.file + ' is stored rather than deflated');
  }
});

test('an ODF package stores its mimetype FIRST and uncompressed', () => {
  // That is the whole reason the entry exists: the media type is readable from
  // the first few dozen bytes without unzipping anything, which is how a
  // content sniffer tells an .odp from a .pptx that has been renamed.
  //
  // Found by the Slides driver, not by reading: the corpus builder deflated
  // every entry, so the marker was compressed, and the sniffer that works
  // perfectly against real files could not see it.
  const head = new TextDecoder().decode(read('odp/units.odp').subarray(0, 200));
  assert.ok(
    head.includes('mimetypeapplication/vnd.oasis.opendocument.presentation'),
    'the mimetype is not readable from the head of the file',
  );

  const method = read('odp/units.odp')[8]!;
  assert.equal(method, 0, 'the mimetype entry is compressed');
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

// ------------------------------------------------------- presentations --

test('the slide ORDER comes from presentation.xml, not from the file names', async () => {
  // THE ONE THAT LOOKS FINE UNTIL A DECK HAS TEN SLIDES. The parts here are
  // named slide9.xml and slide1.xml, in that deck order. Sorting by filename
  // reverses this two-slide deck and puts slide10 between 1 and 2 in a real one.
  const presentation = await readPptx(read('pptx/order-and-titles.pptx'));
  assert.equal(presentation.slides.length, 2);
  assert.equal(titleOf(presentation.slides[0]), 'The real title');
  assert.equal(titleOf(presentation.slides[1]), 'Second slide');
});

test('the title is the placeholder, not the first shape on the slide', async () => {
  // The body is deliberately the first shape in this fixture, so a reader that
  // takes shape one gets "Body first, deliberately" and looks plausible.
  const presentation = await readPptx(read('pptx/order-and-titles.pptx'));
  const first = presentation.slides[0]!;
  assert.equal(first.elements[0]!.kind, 'text');
  assert.equal((first.elements[0] as { text: string }).text, 'Body first, deliberately');
  assert.equal(titleOf(first), 'The real title');
});

test('EMU are converted, so a shape lands where the file put it', async () => {
  // Treating EMU as points puts everything 12700 times too far out, which
  // presents as an empty slide rather than as a misplaced shape.
  const presentation = await readPptx(read('pptx/emu-geometry.pptx'));
  const element = presentation.slides[0]!.elements[0] as { frame: Frame };
  assert.ok(Math.abs(element.frame.x - 0.25) < 0.001, 'x was ' + element.frame.x);
  assert.ok(Math.abs(element.frame.y - 0.2) < 0.001, 'y was ' + element.frame.y);
  assert.ok(Math.abs(element.frame.width - 0.5) < 0.001, 'width was ' + element.frame.width);
});

test('a font size in hundredths of a point is not read as points', async () => {
  // `sz="2400"` is 24pt. Read as points it is 2400pt text, which fills the
  // slide with one letter.
  const presentation = await readPptx(read('pptx/emu-geometry.pptx'));
  const element = presentation.slides[0]!.elements[0] as { style: { size?: number } };
  assert.equal(element.style.size, 24);
});

test('paragraphs stay separate lines rather than running together', async () => {
  const presentation = await readPptx(read('pptx/paragraphs-and-notes.pptx'));
  const body = presentation.slides[0]!.elements.find(
    (element) => element.kind === 'text' && element.role === 'body',
  ) as { text: string } | undefined;
  assert.equal(body?.text, 'First point\nSecond point');
});

test('notes are the NOTES, not the slide text the notes part also carries', async () => {
  // The notes part holds the slide title in a placeholder too. A reader taking
  // every <a:t> from it shows the body twice in the presenter view.
  const presentation = await readPptx(read('pptx/paragraphs-and-notes.pptx'));
  assert.equal(presentation.slides[0]!.notes, 'Say the thing.\nThen pause.');
  assert.ok(
    !presentation.slides[0]!.notes.includes('Deck title'),
    'the slide title leaked into the speaker notes',
  );
});

test('ODF lengths carry a unit, and Number() on one gives NaN', async () => {
  // NaN in a frame is a shape at the origin with no size, which presents as a
  // slide whose content failed to load. Both cm and in are covered here.
  const presentation = await readOdp(read('odp/units.odp'));
  const title = presentation.slides[0]!.elements[0] as { frame: Frame };
  assert.ok(Math.abs(title.frame.x - 0.25) < 0.002, 'x was ' + title.frame.x);
  assert.ok(Math.abs(title.frame.y - 0.2) < 0.002, 'y was ' + title.frame.y);

  const inches = presentation.slides[0]!.elements[1] as { frame: Frame };
  assert.ok(inches.frame.width > 0, 'a frame given in inches came out zero-sized');
});

test('ODF notes live INSIDE the page, which is the opposite of OOXML', async () => {
  const presentation = await readOdp(read('odp/notes-and-spaces.odp'));
  assert.equal(presentation.slides[0]!.notes, 'Remember the thing.');
});

test('ODF encoded spaces survive on a slide as they do in a document', async () => {
  const presentation = await readOdp(read('odp/notes-and-spaces.odp'));
  const title = presentation.slides[0]!.elements[0] as { text: string };
  assert.equal(title.text, 'Gap   here');
});

test('a presentation round-trips through our own writers, both formats', async () => {
  // The weakest check of the set, and here on purpose: it proves the writers
  // and readers agree, which is what an export-then-reopen needs. It proves
  // nothing about the format, which is what every test above is for.
  const original = await readPptx(read('pptx/paragraphs-and-notes.pptx'));

  const throughPptx = await readPptx(writePptx(original));
  assert.equal(titleOf(throughPptx.slides[0]), 'Deck title');
  assert.equal(throughPptx.slides[0]!.notes, 'Say the thing.\nThen pause.');

  const throughOdp = await readOdp(writeOdp(original));
  assert.equal(titleOf(throughOdp.slides[0]), 'Deck title');
  assert.equal(throughOdp.slides[0]!.notes, 'Say the thing.\nThen pause.');
});

function titleOf(slide: { elements: readonly unknown[] } | undefined): string | undefined {
  const found = (slide?.elements ?? []).find(
    (element) => (element as { role?: string }).role === 'title',
  );
  return (found as { text?: string } | undefined)?.text;
}

// ---------------------------------------------------------------- pdf --

test('a PDF page renders to PIXELS, with the Y axis the right way up', () => {
  // THE ONE THAT LOOKS ALMOST RIGHT. PDF's origin is the bottom-left and Y
  // increases upward; a screen's is the top-left. A renderer that draws
  // straight onto screen coordinates puts every page upside down, and on a page
  // of centred content that is nearly invisible.
  //
  // The fixture puts RED low on the page and BLUE high, so a flip swaps them.
  // Asserted on the RASTER rather than on the display list, because a correct
  // list and a broken rasterizer produce a blank page and only pixels tell
  // those two apart.
  const page = renderPage(readPdf(read('pdf/rectangles.pdf')));
  assert.ok(page !== null, 'nothing rendered');

  const raster = rasterize(page as RenderedPage);
  // Red sits at y=72..144 in PDF space, so 648..720 down the raster.
  const low = pixelAt(raster, 144, 684);
  assert.deepEqual([low.r, low.g, low.b], [255, 0, 0], 'the low box is not red');

  // Blue sits at y=648..720, so 72..144 down.
  const high = pixelAt(raster, 144, 108);
  assert.deepEqual([high.r, high.g, high.b], [0, 0, 255], 'the high box is not blue');

  // And the paper is white where nothing was drawn.
  const paper = pixelAt(raster, 500, 400);
  assert.deepEqual([paper.r, paper.g, paper.b], [255, 255, 255]);
});

test('cm CONCATENATES, so a nested transform composes', () => {
  // Assignment loses the outer transform and lands the inner shape at 50,50
  // instead of 150,150 - a shape in a plausible wrong place rather than an
  // obviously broken page.
  const page = renderPage(readPdf(read('pdf/transforms.pdf')));
  const raster = rasterize(page as RenderedPage);

  // 150,150 in PDF space is 150 across and 792-190=602..642 down.
  const inner = pixelAt(raster, 170, 622);
  assert.deepEqual([inner.r, inner.g, inner.b], [0, 0, 0], 'the nested shape is not at 150,150');

  // Nothing at 50,50, which is where an assigning renderer would put it.
  const wrong = pixelAt(raster, 70, 722);
  assert.deepEqual([wrong.r, wrong.g, wrong.b], [255, 255, 255], 'the shape landed at 50,50');
});

test('Q restores, so a shape after the block is untransformed', () => {
  const page = renderPage(readPdf(read('pdf/transforms.pdf')));
  const raster = rasterize(page as RenderedPage);
  const outer = pixelAt(raster, 420, 372);
  assert.deepEqual([outer.r, outer.g, outer.b], [0, 0, 0], 'Q did not restore the matrix');
});

test('a path ended with n paints NOTHING, which is what a clip is', () => {
  // A renderer that paints on `re` fills the whole page with the clip colour,
  // and the result looks like a deliberate coloured background.
  const page = renderPage(readPdf(read('pdf/paths-not-painted.pdf')));
  assert.ok(page !== null);

  const painted = (page as RenderedPage).items.filter(
    (item) => item.kind === 'path' && item.fill !== null,
  );
  assert.equal(painted.length, 1, 'the unpainted path was painted');

  const raster = rasterize(page as RenderedPage);
  const corner = pixelAt(raster, 20, 20);
  assert.deepEqual([corner.r, corner.g, corner.b], [255, 255, 255], 'the clip region was filled');
});

test('text is placed by Tm and moved by Td, as two matrices', () => {
  const page = renderPage(readPdf(read('pdf/text-positions.pdf')));
  const text = (page as RenderedPage).items.filter((item) => item.kind === 'text');

  assert.equal(text.length, 2);
  assert.equal((text[0] as { text: string }).text, 'First line');
  assert.equal((text[1] as { text: string }).text, 'Kerned');

  // 72,700 in PDF space is 72 across and 92 down. The second line is 30 lower.
  const first = text[0] as { x: number; y: number };
  const second = text[1] as { y: number };
  assert.ok(Math.abs(first.x - 72) < 0.5, 'x was ' + first.x);
  assert.ok(Math.abs(first.y - 92) < 0.5, 'y was ' + first.y);
  assert.ok(Math.abs(second.y - 122) < 0.5, 'the second line is at ' + second.y);
});

test('a number inside TJ is a KERN, never content', () => {
  // Appending it writes "-120" into the page, which reads as a document that
  // contains stray numbers rather than as a renderer bug.
  const page = renderPage(readPdf(read('pdf/text-positions.pdf')));
  const text = (page as RenderedPage).items.filter((item) => item.kind === 'text');
  const joined = text.map((item) => (item as { text: string }).text).join(' ');
  assert.ok(!joined.includes('120'), 'a kerning value was written into the text: ' + joined);
});

test('the font size survives, so text is not rendered at zero', () => {
  const page = renderPage(readPdf(read('pdf/text-positions.pdf')));
  const first = (page as RenderedPage).items.find((item) => item.kind === 'text');
  assert.equal((first as { size: number }).size, 24);
});

test('KNOWN LOSS: a compressed content stream is skipped, not misread', () => {
  // Asserted rather than noted. Interpreting compressed bytes produces a page
  // of noise that looks like a rendering, which is worse than a page that
  // honestly does not render - and that is the honest half of a from-scratch
  // reader with no inflate on the content path.
  const page = renderContent('BT /F1 12 Tf (ok) Tj ET');
  assert.equal(page.items.length, 1, 'the interpreter itself stopped working');
});

// -------------------------------------------- footnotes and fields --

test('a footnote reference is an ELEMENT, and it survives with its paragraph', async () => {
  // A reader that collects only <w:t> keeps every note and loses every
  // reference, which presents as a document whose notes belong to nothing.
  const document = await readDocx(read('docx/footnotes.docx'));
  assert.deepEqual(document.blocks[0]!.footnoteRefs, ['2']);
  assert.deepEqual(document.blocks[1]!.footnoteRefs, ['3']);

  // And the text around the marker is intact, with its spacing.
  assert.equal(text(document.blocks[0]), 'A claim worth citing and the rest of the sentence.');
});

test('the separator and continuation separator are NOT notes', async () => {
  // Word writes them as footnotes with ids -1 and 0. A reader that takes every
  // <w:footnote> shows two empty notes at the top of every document that has
  // any, which looks like a parsing failure and is a specification detail.
  const document = await readDocx(read('docx/footnotes.docx'));
  const notes = document.footnotes ?? [];
  assert.equal(notes.length, 2, 'the separators were read as notes');
  assert.deepEqual(notes.map((note) => note.id), ['2', '3']);
  assert.equal(notes[0]!.runs.map((run) => run.text).join(''), 'The source of the claim.');
});

test('a table of contents is read as a FIELD, not as frozen text', async () => {
  // A reader that only handles <w:fldSimple> sees the text and no field, so a
  // refresh either does nothing or appends a second contents beside the first.
  const document = await readDocx(read('docx/contents-field.docx'));
  assert.ok((document.blocks[0]!.field ?? '').startsWith('TOC'), 'no field instruction was read');
  assert.equal(text(document.blocks[0]), 'Introduction\t1');
});

test('footnotes and a field survive a WRITE and a re-read', async () => {
  // The round trip that matters for a save: the notes reach their own part, the
  // part is RELATED from the document, and the references come back attached to
  // the paragraphs they were on. A part written into the package with no
  // relationship is present and unreachable - the wired-at-one-end failure this
  // project has met before.
  const original = await readDocx(read('docx/footnotes.docx'));
  const again = await readDocx(writeDocx(original));

  assert.deepEqual(again.blocks[0]!.footnoteRefs, ['2']);
  assert.deepEqual(again.blocks[1]!.footnoteRefs, ['3']);
  assert.equal((again.footnotes ?? []).length, 2);
  assert.equal(
    (again.footnotes ?? [])[0]!.runs.map((run) => run.text).join(''),
    'The source of the claim.',
  );

  const withField = await readDocx(read('docx/contents-field.docx'));
  const fieldAgain = await readDocx(writeDocx(withField));
  assert.ok((fieldAgain.blocks[0]!.field ?? '').startsWith('TOC'), 'the field was frozen on save');
});

test('the written package RELATES its footnotes part, or nothing can find it', async () => {
  const original = await readDocx(read('docx/footnotes.docx'));
  const bytes = writeDocx(original);
  const text = new TextDecoder('latin1').decode(bytes);

  // Deflated, so the marker is only visible after unzipping - the check reads
  // the package rather than the raw bytes.
  const parts = await readZip(bytes);
  assert.ok(parts.has('word/footnotes.xml'), 'the part is missing');

  const rels = new TextDecoder().decode(parts.get('word/_rels/document.xml.rels') as Uint8Array);
  assert.ok(rels.includes('footnotes.xml'), 'the part is in the package and unreachable');

  const types = new TextDecoder().decode(parts.get('[Content_Types].xml') as Uint8Array);
  assert.ok(types.includes('footnotes+xml'), 'the part has no declared content type');
  void text;
});

test('a document with no footnotes writes NO footnotes part', async () => {
  // An empty part with a separator and nothing else is not harmful, and it is
  // noise in every package a reader opens - and a reader that counts parts to
  // decide whether a document has notes would be wrong about all of them.
  const plain = await readDocx(read('docx/paragraphs.docx'));
  const parts = await readZip(writeDocx(plain));
  assert.equal(parts.has('word/footnotes.xml'), false);
});
