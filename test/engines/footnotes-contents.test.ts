/**
 * Footnotes in the layout, and a table of contents with real page numbers.
 *
 * The two things worth testing hardest are the ones that look right and are
 * wrong: a note that lands on a different page from its own reference, and a
 * contents whose numbers are all short by however many pages the contents
 * itself takes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { build, insert, remove } from '../../app/engines/text/contents';
import { type LayoutResult, layout } from '../../app/engines/text/layout';
import {
  type Block,
  type Footnote,
  type TextDocument,
  A4,
  emptyDocument,
} from '../../app/engines/text/model';

/**
 * A measurer with no canvas.
 *
 * Every character is the same width and every line the same height, so the
 * arithmetic in a test is arithmetic rather than a guess about a font.
 */
const measurer = {
  width: (text: string, style: { size: number }) => text.length * style.size * 0.5,
  height: (style: { size: number }) => style.size * 1.2,
};

function block(id: string, kind: Block['kind'], text: string): Block {
  return { id, kind, runs: [{ text, formatting: {} }], style: {} };
}

function documentWith(blocks: Block[], footnotes: Footnote[] = []): TextDocument {
  return { ...emptyDocument(A4), blocks, footnotes };
}

const relayout = (document: TextDocument): LayoutResult => layout(document, measurer);

// ------------------------------------------------------------- footnotes --

test('a note lands on the same page as its own reference', () => {
  // THE ONE THAT MATTERS. A reader who meets a marker and has to turn the page
  // to find the note has been given a worse document than one with no notes.
  const document = documentWith(
    [block('a', 'paragraph', 'The claim.'), block('b', 'paragraph', 'More text.')],
    [{ id: 'n1', blockId: 'a', offset: 3, runs: [{ text: 'The source.', formatting: {} }] }],
  );

  const result = layout(document, measurer);
  const page = result.pages.find((candidate) =>
    candidate.lines.some((line) => line.blockId === 'a'),
  );
  assert.ok(page !== undefined, 'the referencing block was not laid out');
  assert.equal(page?.footnotes.length, 1);
  assert.equal(page?.footnotes[0]?.id, 'n1');
});

test('a note is numbered by DOCUMENT order, not by its position on a page', () => {
  // Numbering per page makes a note change its number when a paragraph above it
  // grows, so a cross-reference written yesterday points at the wrong note.
  const blocks = [block('a', 'paragraph', 'One.'), block('b', 'paragraph', 'Two.')];
  const document = documentWith(blocks, [
    { id: 'n1', blockId: 'a', offset: 0, runs: [{ text: 'First note.', formatting: {} }] },
    { id: 'n2', blockId: 'b', offset: 0, runs: [{ text: 'Second note.', formatting: {} }] },
  ]);

  const result = layout(document, measurer);
  const all = result.pages.flatMap((page) => page.footnotes);
  assert.deepEqual(all.map((note) => note.number), [1, 2]);
  assert.ok(all[0]?.runs[0]?.text.startsWith('1. '), 'the marker is not numbered');
});

test('the notes area is RESERVED, so the last line is not pushed off the page', () => {
  // The classic footnote bug: reserving after the lines are placed overfills
  // the page, and the last line sits below the paper.
  const many: Block[] = [];
  for (let index = 0; index < 60; index += 1) {
    many.push(block('b' + index, 'paragraph', 'Line ' + index));
  }
  const withNote = documentWith(many, [
    { id: 'n1', blockId: 'b30', offset: 0, runs: [{ text: 'A note.', formatting: {} }] },
  ]);

  const result = layout(withNote, measurer);
  for (const page of result.pages) {
    const last = page.lines[page.lines.length - 1];
    if (last === undefined) continue;
    assert.ok(
      last.y + last.height + page.footnoteHeight <= page.contentHeight + 0.01,
      'page ' + page.index + ' overflows: ' +
        (last.y + last.height + page.footnoteHeight) + ' in ' + page.contentHeight,
    );
  }
});

test('a page with no references reserves nothing', () => {
  // A blank strip at the foot of every page is what reserving unconditionally
  // looks like, and it wastes a line on every page of a long document.
  const document = documentWith([block('a', 'paragraph', 'No notes here.')]);
  const result = layout(document, measurer);
  assert.equal(result.pages[0]?.footnoteHeight, 0);
  assert.deepEqual(result.pages[0]?.footnotes, []);
});

test('a note whose block never appears is not placed anywhere', () => {
  // Placing it on page one would show a reader a note with no marker.
  const document = documentWith(
    [block('a', 'paragraph', 'Text.')],
    [{ id: 'ghost', blockId: 'missing', offset: 0, runs: [{ text: 'Orphan.', formatting: {} }] }],
  );
  const result = layout(document, measurer);
  const all = result.pages.flatMap((page) => page.footnotes);
  assert.deepEqual(all, []);
});

// -------------------------------------------------------------- contents --

test('the contents lists headings with the page they are on', () => {
  const document = documentWith([
    block('h1', 'heading1', 'First'),
    block('p1', 'paragraph', 'Body.'),
    block('h2', 'heading2', 'Second'),
  ]);

  const entries = build(document, layout(document, measurer));
  assert.deepEqual(entries.map((entry) => entry.text), ['First', 'Second']);
  assert.deepEqual(entries.map((entry) => entry.level), [1, 2]);
  assert.equal(entries[0]?.page, 1);
});

test('inserting the contents CHANGES the numbers, and the second pass catches it', () => {
  // THE ORDERING TRAP. The contents takes pages, so numbers built before it was
  // inserted are short by however many - and they look plausible, which is
  // worse than looking broken.
  const blocks: Block[] = [];
  for (let index = 0; index < 40; index += 1) {
    blocks.push(block('h' + index, 'heading1', 'Heading ' + index));
    blocks.push(block('p' + index, 'paragraph', 'Body text for section ' + index));
  }
  const document = documentWith(blocks);

  const before = build(document, layout(document, measurer));
  const withContents = insert(document, relayout);

  // Read the numbers out of the generated blocks.
  const generated = withContents.blocks
    .filter((entry) => entry.id.startsWith('contents-') && /\d$/.test(entry.id))
    .map((entry) => entry.runs[0]?.text ?? '');
  const lastNumber = Number((generated[generated.length - 1] ?? '').split('\t')[1]);
  const lastBefore = before[before.length - 1]?.page ?? 0;

  assert.ok(generated.length > 0, 'nothing was generated');
  assert.ok(
    lastNumber > lastBefore,
    'the numbers did not move: ' + lastNumber + ' against ' + lastBefore,
  );
});

test('refreshing replaces the contents rather than stacking a second one', () => {
  const document = documentWith([
    block('h1', 'heading1', 'First'),
    block('p1', 'paragraph', 'Body.'),
  ]);

  let current = insert(document, relayout);
  const first = current.blocks.filter((entry) => entry.id.startsWith('contents')).length;

  current = insert(current, relayout);
  current = insert(current, relayout);
  const third = current.blocks.filter((entry) => entry.id.startsWith('contents')).length;

  assert.equal(third, first, 'refreshing three times left three contents');
});

test('the contents does not list ITSELF', () => {
  // Its own title is a heading1. Listing it grows the contents every refresh.
  const document = documentWith([block('h1', 'heading1', 'Only heading')]);
  const withContents = insert(document, relayout);
  const listed = withContents.blocks
    .filter((entry) => /contents-\d+$/.test(entry.id))
    .map((entry) => entry.runs[0]?.text ?? '');
  assert.equal(listed.length, 1);
  assert.ok(listed[0]?.startsWith('Only heading'));
});

test('a document with no headings says so rather than showing a blank page', () => {
  const document = documentWith([block('p1', 'paragraph', 'Just text.')]);
  const withContents = insert(document, relayout);
  const empty = withContents.blocks.find((entry) => entry.id === 'contents-empty');
  assert.ok(empty !== undefined, 'no empty state was generated');
  assert.match(empty?.runs[0]?.text ?? '', /no headings/);
});

test('a heading that produced no line gets no page number, rather than page 1', () => {
  // A wrong page number is worse than an absent one, because it will be
  // followed.
  const document = documentWith([{ ...block('h1', 'heading1', ''), runs: [] }]);
  const entries = build(document, layout(document, measurer));
  assert.deepEqual(entries, []);
});

test('depth is honoured, so a deep heading can be left out', () => {
  const document = documentWith([
    block('h1', 'heading1', 'Top'),
    block('h3', 'heading3', 'Deep'),
  ]);
  const shallow = insert(document, relayout, { depth: 1 });
  const listed = shallow.blocks
    .filter((entry) => /contents-\d+$/.test(entry.id))
    .map((entry) => entry.runs[0]?.text ?? '');
  assert.equal(listed.length, 1);
  assert.ok(listed[0]?.startsWith('Top'));
});

test('removing takes the contents out and leaves everything else', () => {
  const document = documentWith([
    block('h1', 'heading1', 'First'),
    block('p1', 'paragraph', 'Body.'),
  ]);
  const stripped = remove(insert(document, relayout));
  assert.deepEqual(
    stripped.blocks.map((entry) => entry.id),
    ['h1', 'p1'],
  );
});
