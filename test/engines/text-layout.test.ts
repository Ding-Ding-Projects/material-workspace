/**
 * The text engine: model operations, line breaking and pagination.
 *
 * Measurement is injected with a deterministic measurer, so these assertions
 * pin EXACT break positions rather than "it produced some lines". A layout test
 * that only counts lines passes on an engine that breaks in all the wrong
 * places.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  A4,
  applyFormatting,
  blockText,
  deleteRange,
  emptyDocument,
  formattingAcross,
  insertText,
  newBlockId,
  normaliseRuns,
  splitRunsAt,
  type Block,
  type TextDocument,
} from '../../app/engines/text/model.js';
import { breakOpportunities, layout, type TextMeasurer } from '../../app/engines/text/layout.js';

/**
 * Every character is exactly half the point size wide, and a line is exactly
 * the point size tall. Arbitrary, but FIXED — which is what makes an exact
 * assertion about where a line broke meaningful.
 */
const measurer: TextMeasurer = {
  width: (text, style) => text.length * style.size * 0.5,
  height: (style) => style.size,
};

function paragraph(text: string, kind: Block['kind'] = 'paragraph'): Block {
  return { id: newBlockId(), kind, runs: [{ text, formatting: {} }], style: {} };
}

function documentWith(blocks: Block[]): TextDocument {
  const document = emptyDocument(A4);
  document.blocks = blocks;
  return document;
}

describe('run operations', () => {
  it('splits runs at an offset without changing the text', () => {
    const block = paragraph('hello world');
    const index = splitRunsAt(block, 5);
    assert.equal(index, 1);
    assert.equal(block.runs.length, 2);
    assert.equal(block.runs[0]?.text, 'hello');
    assert.equal(block.runs[1]?.text, ' world');
    assert.equal(blockText(block), 'hello world');
  });

  it('applies formatting to exactly the selected range', () => {
    const block = paragraph('hello world');
    applyFormatting(block, 6, 11, { bold: true });

    assert.equal(blockText(block), 'hello world', 'the text must not change');
    const bold = block.runs.filter((run) => run.formatting.bold);
    assert.equal(bold.length, 1);
    assert.equal(bold[0]?.text, 'world', 'only the selection may be bold');
  });

  it('merges neighbouring runs with identical formatting', () => {
    const block: Block = {
      id: newBlockId(),
      kind: 'paragraph',
      runs: [
        { text: 'a', formatting: { bold: true } },
        { text: 'b', formatting: { bold: true } },
        { text: 'c', formatting: {} },
        { text: '', formatting: {} },
      ],
      style: {},
    };
    normaliseRuns(block);
    assert.equal(block.runs.length, 2, 'identical neighbours merge and empties are dropped');
    assert.equal(block.runs[0]?.text, 'ab');
    assert.equal(block.runs[1]?.text, 'c');
  });

  it('always leaves at least one run, so the caret has somewhere to live', () => {
    const block = paragraph('abc');
    deleteRange(block, 0, 3);
    assert.equal(block.runs.length, 1);
    assert.equal(blockText(block), '');
  });

  it('inherits formatting when inserting inside a formatted run', () => {
    const block = paragraph('hello');
    applyFormatting(block, 0, 5, { italic: true });
    insertText(block, 3, 'XYZ');

    assert.equal(blockText(block), 'helXYZlo');
    assert.ok(
      block.runs.every((run) => run.formatting.italic === true),
      'inserted text takes the surrounding formatting',
    );
  });

  it('reports formatting across a range only when every run agrees', () => {
    const block = paragraph('hello world');
    applyFormatting(block, 0, 5, { bold: true });

    assert.equal(formattingAcross(block, 0, 5).bold, true, 'a uniform range reports its format');
    assert.equal(
      formattingAcross(block, 0, 11).bold,
      undefined,
      'a mixed range must report nothing rather than the first run answer',
    );
  });

  it('keeps a deleted run in the model but out of the text', () => {
    const block: Block = {
      id: newBlockId(),
      kind: 'paragraph',
      runs: [
        { text: 'kept ', formatting: {} },
        { text: 'removed ', formatting: { deleted: { author: 'a', at: 'now' } } },
        { text: 'also kept', formatting: {} },
      ],
      style: {},
    };
    // Retained so the change can be REJECTED; excluded from the rendered text.
    assert.equal(blockText(block), 'kept also kept');
    assert.equal(block.runs.length, 3);
  });
});

describe('break opportunities', () => {
  it('breaks after spaces', () => {
    assert.deepEqual(breakOpportunities('ab cd'), [3, 5]);
  });

  it('breaks after a hyphen and a dash', () => {
    assert.ok(breakOpportunities('well-known').includes(5));
    assert.ok(breakOpportunities('a—b').includes(2));
  });

  it('breaks between CJK characters, which have no spaces at all', () => {
    // Without this a Chinese paragraph is one unbreakable token and overflows
    // the page entirely.
    const points = breakOpportunities('香港茶樓');
    assert.ok(points.length > 1, 'a CJK run must have interior break points');
    assert.ok(points.includes(1) && points.includes(2) && points.includes(3));
  });

  it('never breaks before closing punctuation', () => {
    const points = breakOpportunities('好。');
    assert.ok(!points.includes(1), 'a full stop must not start a line');
  });
});

describe('line breaking', () => {
  it('breaks at the last opportunity that fits, not the first that does not', () => {
    // Content width is 595.28 - 144 = 451.28pt. At 11pt and half-width
    // characters, that is 5.5pt per character, so 82 characters fit.
    const text = 'x'.repeat(60) + ' ' + 'y'.repeat(60);
    const result = layout(documentWith([paragraph(text)]), measurer);
    const lines = result.pages[0]?.lines ?? [];

    assert.equal(lines.length, 2, 'it must break exactly once');
    assert.equal(
      lines[0]?.runs.map((r) => r.text).join(''),
      'x'.repeat(60),
      'the first line takes everything that fits and no more',
    );
  });

  it('puts a token wider than the line on its own line rather than overflowing', () => {
    const enormous = 'z'.repeat(400);
    const result = layout(documentWith([paragraph('short ' + enormous)]), measurer);
    const lines = result.pages[0]?.lines ?? [];

    assert.ok(lines.length >= 2);
    const text = lines.map((line) => line.runs.map((r) => r.text).join('')).join('');
    assert.ok(text.includes(enormous), 'the token must not vanish');
  });

  it('gives an empty paragraph one line, so the caret has somewhere to sit', () => {
    const result = layout(documentWith([paragraph('')]), measurer);
    assert.equal(result.pages[0]?.lines.length, 1);
  });

  it('marks the last line of a block, which must never be justified', () => {
    // 82 characters fit on a line here, so this must exceed that to wrap at
    // all. An earlier version used 81 and asserted a wrap that never happened.
    const text = 'w'.repeat(60) + ' ' + 'v'.repeat(60);
    const result = layout(documentWith([paragraph(text)]), measurer);
    const lines = result.pages[0]?.lines ?? [];
    assert.equal(lines[0]?.lastOfBlock, false);
    assert.equal(lines.at(-1)?.lastOfBlock, true);
  });

  it('trims the trailing space off a wrapped line', () => {
    // The break was measured against the TRIMMED candidate, so leaving the
    // space in makes the rendered line wider than the measurement that chose
    // the break. Visible immediately with centred or justified text.
    const text = 'x'.repeat(60) + ' ' + 'y'.repeat(60);
    const line = layout(documentWith([paragraph(text)]), measurer).pages[0]?.lines[0];
    const rendered = line?.runs.map((r) => r.text).join('') ?? '';

    assert.ok(!rendered.endsWith(' '), 'no trailing space may survive onto the page');
    assert.equal(rendered.length, 60);
    // The RANGE still covers the space, so the caret can sit after it.
    assert.equal(line?.end, 61);
  });

  it('does not trim any other character', () => {
    // The first attempt at the trim above used a mangled pattern that matched
    // the letter "s" instead of whitespace, and quietly ate it from the end
    // of every line. This is the case that would have caught it.
    const result = layout(documentWith([paragraph('gas')]), measurer);
    const rendered = result.pages[0]?.lines[0]?.runs.map((r) => r.text).join('');
    assert.equal(rendered, 'gas');
  });

  it('reports the character range each line covers', () => {
    const result = layout(documentWith([paragraph('alpha beta')]), measurer);
    const line = result.pages[0]?.lines[0];
    assert.equal(line?.start, 0);
    assert.equal(line?.end, 10);
  });
});

describe('pagination', () => {
  it('starts a new page when the content height is exhausted', () => {
    // Content height is 841.89 - 144 = 697.89pt. A line is 11 * 1.45 = 15.95pt,
    // so roughly 43 lines fit.
    const blocks = Array.from({ length: 80 }, (_, index) => paragraph('line ' + index));
    const result = layout(documentWith(blocks), measurer);

    assert.ok(result.pages.length > 1, 'eighty paragraphs must not fit on one page');
    for (const page of result.pages) {
      const lowest = page.lines.at(-1);
      if (!lowest) continue;
      assert.ok(
        lowest.y + lowest.height <= page.contentHeight + 0.01,
        'no line may be placed past the bottom margin',
      );
    }
  });

  it('honours an explicit page break', () => {
    const result = layout(
      documentWith([
        paragraph('before'),
        { id: newBlockId(), kind: 'pageBreak', runs: [], style: {} },
        paragraph('after'),
      ]),
      measurer,
    );

    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0]?.lines[0]?.runs[0]?.text, 'before');
    assert.equal(result.pages[1]?.lines[0]?.runs[0]?.text, 'after');
  });

  it('keeps a heading with the block that follows it', () => {
    // Fill the page so that a heading would land right at the bottom.
    const filler = Array.from({ length: 42 }, (_, index) => paragraph('filler ' + index));
    const result = layout(
      documentWith([...filler, paragraph('A heading', 'heading2'), paragraph('Its body')]),
      measurer,
    );

    // Find which page the heading and the body landed on.
    const pageOf = (text: string): number =>
      result.pages.findIndex((page) =>
        page.lines.some((line) => line.runs.map((r) => r.text).join('').includes(text)),
      );

    const headingPage = pageOf('A heading');
    const bodyPage = pageOf('Its body');
    assert.notEqual(headingPage, -1);
    assert.notEqual(bodyPage, -1);
    assert.equal(headingPage, bodyPage, 'a heading must never be stranded from its body');
  });

  it('counts every line it laid out', () => {
    const blocks = Array.from({ length: 10 }, () => paragraph('one line'));
    const result = layout(documentWith(blocks), measurer);
    const actual = result.pages.reduce((sum, page) => sum + page.lines.length, 0);
    assert.equal(result.lineCount, actual);
    assert.equal(result.lineCount, 10);
  });
});
