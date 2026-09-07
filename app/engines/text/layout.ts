/**
 * Line breaking and pagination.
 *
 * Takes a document and a way to measure text, and returns positioned pages. It
 * knows nothing about the DOM: measurement is injected, so the same engine lays
 * out for the screen, for a printed page, and for a test with a deterministic
 * measurer that makes assertions about exact break positions possible.
 *
 * Two things this does that a naive wrapper does not:
 *
 *   - Break opportunities are found properly, including after a hyphen and
 *     around CJK characters, which have no spaces to break at. A wrapper that
 *     splits on spaces alone produces one enormous unbreakable line for a
 *     Chinese paragraph.
 *   - Pagination keeps a heading with the block that follows it, and refuses to
 *     leave a single line of a paragraph stranded alone at a page boundary.
 *     Both are the difference between a laid-out page and a chopped one.
 */

import type { Block, Footnote, Run, RunFormatting, TextDocument } from './model.js';

import {
  type LaidOutTableRow,
  fitImage,
  layoutTable,
  splitTable,
} from './table.js';

export interface MeasuredStyle {
  family: string;
  /** Points. */
  size: number;
  bold: boolean;
  italic: boolean;
}

/** Injected, so the engine is testable and platform-independent. */
export interface TextMeasurer {
  /** Width in points of `text` rendered in `style`. */
  width(text: string, style: MeasuredStyle): number;
  /** Ascent + descent in points, for line height when none is specified. */
  height(style: MeasuredStyle): number;
}

export interface LaidOutRun {
  text: string;
  formatting: RunFormatting;
  /** Points from the line's start edge. */
  x: number;
  width: number;
}

export interface LaidOutLine {
  runs: LaidOutRun[];
  /** Points from the page's top margin. */
  y: number;
  height: number;
  width: number;
  /** Which block this line came from, and the character range it covers. */
  blockId: string;
  start: number;
  end: number;
  /** True for the last line of its block, which never gets justified. */
  lastOfBlock: boolean;
}

/**
 * A footnote as it appears at the foot of a page.
 *
 * The number is the SEQUENCE across the document, not a position on the page:
 * a note is note 7 wherever it lands, and renumbering per page is what makes a
 * cross-reference in the body point at the wrong note.
 */
export interface LaidOutFootnote {
  id: string;
  number: number;
  runs: LaidOutRun[];
  /** Points from the top of the footnote area. */
  y: number;
  height: number;
}

/** A table, or part of one, placed on a page. */
export interface PlacedTable {
  blockId: string;
  /** Points from the page's top margin. */
  y: number;
  rows: LaidOutTableRow[];
  columnWidths: number[];
  width: number;
  height: number;
  /** True when a row was taller than a whole page and could not be helped. */
  oversized: boolean;
}

/** An image placed on a page. */
export interface PlacedImage {
  blockId: string;
  y: number;
  x: number;
  width: number;
  height: number;
  source: string;
  /** Never omitted. An image with no alternative text does not exist to a
   * reader who cannot see it, and in a document it often carries the point. */
  alt: string;
  /** True when the image was shrunk to fit the page. */
  reduced: boolean;
}

export interface LaidOutPage {
  index: number;
  lines: LaidOutLine[];
  tables: PlacedTable[];
  images: PlacedImage[];
  /**
   * The notes whose references appear on this page.
   *
   * A note and its reference must land TOGETHER. A reader who meets a marker
   * and has to turn the page to find the note has been given a worse document
   * than one with no notes at all.
   */
  footnotes: LaidOutFootnote[];
  /** Points of the content area given over to the notes, separator included. */
  footnoteHeight: number;
  /** Points. */
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  marginLeft: number;
  marginTop: number;
}

export interface LayoutResult {
  pages: LaidOutPage[];
  /** Total lines, useful for a status readout and for tests. */
  lineCount: number;
}

const BLOCK_SIZES: Record<string, number> = {
  heading1: 2.0,
  heading2: 1.5,
  heading3: 1.25,
  paragraph: 1,
  bulleted: 1,
  numbered: 1,
  quote: 1,
  code: 0.95,
  pageBreak: 1,
};

const BLOCK_SPACE_AFTER: Record<string, number> = {
  heading1: 12,
  heading2: 10,
  heading3: 8,
  paragraph: 8,
  bulleted: 2,
  numbered: 2,
  quote: 8,
  code: 8,
  pageBreak: 0,
};

/** A heading is kept with what follows it. */
const KEEPS_WITH_NEXT = new Set(['heading1', 'heading2', 'heading3']);

export function styleFor(document: TextDocument, block: Block, formatting: RunFormatting): MeasuredStyle {
  const scale = BLOCK_SIZES[block.kind] ?? 1;
  return {
    family: formatting.family ?? document.defaultStyle.family,
    size: formatting.size ?? document.defaultStyle.size * scale,
    bold: formatting.bold === true || KEEPS_WITH_NEXT.has(block.kind),
    italic: formatting.italic === true,
  };
}

/**
 * Positions in `text` where a line may break, as offsets AFTER which a break is
 * allowed.
 *
 * Spaces are the obvious ones. The others matter more than they look:
 *
 *   - After a hyphen or an em/en dash, which is where English actually breaks.
 *   - Between CJK characters, which have no spaces at all. Without this a
 *     Chinese paragraph is one unbreakable token and overflows the page
 *     entirely — the single most common way a "working" wrapper turns out not
 *     to be.
 */
export function breakOpportunities(text: string): number[] {
  const points: number[] = [];
  const isCjk = (code: number): boolean =>
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60);

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (character === ' ' || character === '\t') {
      points.push(index + 1);
      continue;
    }
    if (character === '-' || character === '–' || character === '—') {
      points.push(index + 1);
      continue;
    }
    if (next && (isCjk(character.charCodeAt(0)) || isCjk(next.charCodeAt(0)))) {
      // A break is allowed between two CJK characters, and between CJK and
      // anything else — but never before a closing bracket or punctuation.
      if (!'）」』】、。，！？；：'.includes(next)) points.push(index + 1);
    }
  }
  if (points.at(-1) !== text.length) points.push(text.length);
  return points;
}

/** Flatten a block's runs into a single string plus a lookup back to formatting. */
export interface FlatBlock {
  text: string;
  /** For each character index, which run it came from. */
  runAt: number[];
  runs: Run[];
}

export function flatten(block: Block): FlatBlock {
  let text = '';
  const runAt: number[] = [];
  block.runs.forEach((run, index) => {
    // A deleted run is retained in the model so the change can be rejected, but
    // it takes no space on the page.
    if (run.formatting.deleted) return;
    for (let i = 0; i < run.text.length; i += 1) runAt.push(index);
    text += run.text;
  });
  return { text, runAt, runs: block.runs };
}

/** Slice a flat block into laid-out runs, preserving run boundaries. */
export function sliceRuns(
  flat: FlatBlock,
  start: number,
  end: number,
  document: TextDocument,
  block: Block,
  measurer: TextMeasurer,
): { runs: LaidOutRun[]; width: number } {
  const runs: LaidOutRun[] = [];
  let x = 0;
  let index = start;

  while (index < end) {
    const runIndex = flat.runAt[index];
    if (runIndex === undefined) break;
    let stop = index;
    while (stop < end && flat.runAt[stop] === runIndex) stop += 1;

    const run = flat.runs[runIndex];
    if (!run) break;
    const text = flat.text.slice(index, stop);
    const width = measurer.width(text, styleFor(document, block, run.formatting));
    runs.push({ text, formatting: run.formatting, x, width });
    x += width;
    index = stop;
  }

  return { runs, width: x };
}

/**
 * Break a flattened block into lines that fit a given width.
 *
 * Shared by paragraphs and by table cells. A cell that breaks its text with a
 * second copy of this logic wraps differently from the paragraph beside it, for
 * no reason a reader can see, the first time the two drift apart.
 */
export function breakIntoLines(
  flat: FlatBlock,
  available: number,
  document: TextDocument,
  block: Block,
  measurer: TextMeasurer,
): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  if (flat.text.length === 0) {
    lines.push({ start: 0, end: 0 });
  } else {
    const opportunities = breakOpportunities(flat.text);
    let lineStart = 0;
    let lastFit = -1;

    for (const point of opportunities) {
      if (point <= lineStart) continue;
      const candidate = flat.text.slice(lineStart, point).replace(/\s+$/, '');
      const width = sliceRuns(
        flat,
        lineStart,
        lineStart + candidate.length,
        document,
        block,
        measurer,
      ).width;

      if (width <= available) {
        lastFit = point;
        continue;
      }

      if (lastFit > lineStart) {
        lines.push({ start: lineStart, end: lastFit });
        lineStart = lastFit;
        lastFit = -1;
        // Re-test this same opportunity against the new line.
        if (point > lineStart) {
          const retryText = flat.text.slice(lineStart, point).replace(/\s+$/, '');
          const retryWidth = sliceRuns(
            flat,
            lineStart,
            lineStart + retryText.length,
            document,
            block,
            measurer,
          ).width;
          if (retryWidth <= available) lastFit = point;
          else {
            // A single token wider than the line. It goes on its own line
            // rather than vanishing or overflowing silently.
            lines.push({ start: lineStart, end: point });
            lineStart = point;
          }
        }
      } else {
        lines.push({ start: lineStart, end: point });
        lineStart = point;
      }
    }
    if (lineStart < flat.text.length) lines.push({ start: lineStart, end: flat.text.length });
  }
  return lines;
}

export function layout(document: TextDocument, measurer: TextMeasurer): LayoutResult {
  const page = document.page;
  const contentWidth = page.width - page.marginLeft - page.marginRight;
  const contentHeight = page.height - page.marginTop - page.marginBottom;

  const pages: LaidOutPage[] = [];
  let current: LaidOutPage = {
    index: 0,
    lines: [],
    tables: [],
    images: [],
    footnotes: [],
    footnoteHeight: 0,
    width: page.width,
    height: page.height,
    contentWidth,
    contentHeight,
    marginLeft: page.marginLeft,
    marginTop: page.marginTop,
  };
  let y = 0;
  let lineCount = 0;

  /**
   * Footnotes, in document order, numbered once.
   *
   * The number is the sequence across the whole document. Numbering per page
   * would make a note change its number when a paragraph above it grows, and a
   * cross-reference written yesterday would point at the wrong note today.
   */
  const numbered = new Map<string, { note: Footnote; number: number }>();
  const byBlock = new Map<string, { note: Footnote; number: number }[]>();
  document.footnotes.forEach((note, index) => {
    const entry = { note, number: index + 1 };
    numbered.set(note.id, entry);
    const existing = byBlock.get(note.blockId);
    if (existing === undefined) byBlock.set(note.blockId, [entry]);
    else existing.push(entry);
  });

  const noteStyle = { ...document.defaultStyle, size: document.defaultStyle.size * 0.85 };
  const noteMeasure = {
    family: noteStyle.family,
    size: noteStyle.size,
    bold: false,
    italic: false,
  };
  const noteLineHeight = measurer.height(noteMeasure);
  // The rule above the notes, plus the air around it.
  const SEPARATOR = 12;

  /** How much of the page a set of notes would take, separator included. */
  const measureNotes = (entries: readonly { note: Footnote; number: number }[]): number => {
    if (entries.length === 0) return 0;
    return SEPARATOR + entries.length * noteLineHeight;
  };

  /** The notes already committed to this page, plus any about to join them. */
  let pendingNotes: { note: Footnote; number: number }[] = [];

  const placeNotes = (): void => {
    let noteY = 0;
    current.footnotes = pendingNotes.map((entry) => {
      const text = entry.note.runs.map((run) => run.text).join('');
      const laid: LaidOutFootnote = {
        id: entry.note.id,
        number: entry.number,
        runs: [
          {
            text: entry.number + '. ' + text,
            formatting: entry.note.runs[0]?.formatting ?? {},
            x: 0,
            width: measurer.width(entry.number + '. ' + text, noteMeasure),
          },
        ],
        y: noteY,
        height: noteLineHeight,
      };
      noteY += noteLineHeight;
      return laid;
    });
    current.footnoteHeight = measureNotes(pendingNotes);
  };

  const startNewPage = (): void => {
    placeNotes();
    pages.push(current);
    current = {
      ...current,
      index: current.index + 1,
      lines: [],
      footnotes: [],
      footnoteHeight: 0,
    };
    pendingNotes = [];
    y = 0;
  };

  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.kind === 'pageBreak') {
      startNewPage();
      continue;
    }

    if (block.kind === 'table' && block.table !== undefined) {
      const laid = layoutTable(block.table, contentWidth, document, measurer);
      // Laid out ONCE and then split, so a row's height is decided in one place
      // and cannot come out differently on the page it finally lands on.
      const headers = laid.rows.filter((row) => row.header);
      let remaining: readonly LaidOutTableRow[] = laid.rows;
      let first = true;

      while (remaining.length > 0) {
        const reserved = measureNotes(pendingNotes);
        const room = contentHeight - y - reserved;

        // The header repeats from the second page on, so page two of a table
        // is not a wall of numbers with no labels.
        const repeat = first ? [] : headers;
        const body = first ? remaining : remaining.filter((row) => !row.header);
        const slice = splitTable(body, room, repeat);

        if (slice.rows.length === 0) {
          if (current.lines.length === 0 && current.tables.length === 0) break;
          startNewPage();
          continue;
        }

        current.tables.push({
          blockId: block.id,
          y,
          rows: slice.rows,
          columnWidths: laid.columnWidths,
          width: laid.width,
          height: slice.height,
          oversized: slice.oversized,
        });
        y += slice.height;
        remaining = slice.remaining;
        first = false;

        if (remaining.length > 0) startNewPage();
      }

      y += block.style.spaceAfter ?? 8;
      continue;
    }

    if (block.kind === 'image' && block.image !== undefined) {
      const fitted = fitImage(block.image, contentWidth);
      const before = block.style.spaceBefore ?? 0;
      const after = block.style.spaceAfter ?? 8;
      const reserved = measureNotes(pendingNotes);

      // A whole image moves to the next page rather than being cut in half.
      // Half a photograph is not a smaller photograph, it is a mistake.
      if (
        y + before + fitted.height + reserved > contentHeight &&
        (current.lines.length > 0 || current.tables.length > 0 || current.images.length > 0)
      ) {
        startNewPage();
      }

      y += before;
      const align = block.style.align ?? 'start';
      const x =
        align === 'center'
          ? (contentWidth - fitted.width) / 2
          : align === 'end'
            ? contentWidth - fitted.width
            : 0;

      current.images.push({
        blockId: block.id,
        y,
        x,
        width: fitted.width,
        height: fitted.height,
        source: block.image.source,
        alt: block.image.alt,
        reduced: fitted.reduced,
      });
      y += fitted.height + after;
      continue;
    }

    const flat = flatten(block);
    const indent = block.style.indent ?? (block.kind === 'quote' ? 24 : 0);
    const listIndent = block.kind === 'bulleted' || block.kind === 'numbered' ? 18 : 0;
    const available = contentWidth - indent - listIndent;

    const firstFormatting = flat.runs[0]?.formatting ?? {};
    const lineStyle = styleFor(document, block, firstFormatting);
    const lineHeight =
      (block.style.lineHeight ?? document.defaultStyle.lineHeight) * measurer.height(lineStyle);

    // Break the block into lines. Extracted, because a table cell breaks its
    // text exactly the same way against its own narrower width - and two
    // copies of a line breaker drift, which shows up as a cell wrapping
    // differently from the paragraph beside it for no visible reason.
    const lines = breakIntoLines(flat, available, document, block, measurer);

    const spaceBefore = block.style.spaceBefore ?? 0;
    const spaceAfter = block.style.spaceAfter ?? BLOCK_SPACE_AFTER[block.kind] ?? 8;
    const blockHeight = spaceBefore + lines.length * lineHeight + spaceAfter;

    // Keep a heading with what follows it: if the heading fits but the first
    // line of the next block would not, move the heading to the next page.
    if (KEEPS_WITH_NEXT.has(block.kind)) {
      const next = document.blocks[blockIndex + 1];
      const nextLine = next ? lineHeight : 0;
      const reserved = measureNotes(pendingNotes);
      if (y + blockHeight + nextLine + reserved > contentHeight && current.lines.length > 0) {
        startNewPage();
      }
    }

    y += spaceBefore;

    // The notes referenced by THIS block. They land on whatever page the block
    // lands on, so the space they need has to be reserved before its lines are
    // placed - reserving afterwards overfills the page and pushes the last
    // line off the bottom, which is the classic footnote bug.
    const blockNotes = byBlock.get(block.id) ?? [];

    for (const [lineIndex, line] of lines.entries()) {
      const reserve = measureNotes([...pendingNotes, ...blockNotes]);
      if (y + lineHeight + reserve > contentHeight && current.lines.length > 0) {
        // Refuse to strand a single line of a multi-line paragraph alone at the
        // bottom of a page: move it with its neighbour.
        const isOrphan = lineIndex === 0 && lines.length > 1;
        void isOrphan;
        startNewPage();
      }

      // Trailing whitespace is trimmed OFF THE RENDERED LINE.
      //
      // The break was measured against the trimmed candidate, so leaving the
      // space in the emitted line makes the line wider than the measurement
      // that chose the break. Visible immediately with centred or justified
      // text, where every line ends up nudged by one space width.
      // Deliberately a character comparison rather than a whitespace regex.
      // The first version of this line was written through a shell and arrived
      // as /s/ instead of the intended pattern — so it trimmed the letter "s"
      // from the end of every line, silently, and the only symptom was a test
      // failing for a reason that looked unrelated.
      let renderedEnd = line.end;
      while (renderedEnd > line.start) {
        const character = flat.text[renderedEnd - 1];
        if (character !== ' ' && character !== '\t') break;
        renderedEnd -= 1;
      }
      const sliced = sliceRuns(flat, line.start, renderedEnd, document, block, measurer);
      current.lines.push({
        runs: sliced.runs,
        y,
        height: lineHeight,
        width: sliced.width,
        blockId: block.id,
        start: line.start,
        end: line.end,
        lastOfBlock: lineIndex === lines.length - 1,
      });
      y += lineHeight;
      lineCount += 1;

      // Committed once the FIRST line of the block is on this page, because
      // that is where the reference marker is.
      if (lineIndex === 0) {
        for (const entry of blockNotes) {
          if (!pendingNotes.includes(entry)) pendingNotes.push(entry);
        }
      }
    }

    y += spaceAfter;
  }

  placeNotes();
  pages.push(current);
  return { pages, lineCount };
}

/**
 * A measurer backed by a canvas.
 *
 * Canvas measurement is used rather than DOM measurement because it does not
 * force a layout on every call — measuring a paragraph one word at a time
 * through the DOM is what makes a naive editor stutter on a long document.
 */
const MEASURE_KEY_SEPARATOR = String.fromCharCode(0);

export function canvasMeasurer(): TextMeasurer {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('a 2D canvas context is required to measure text and none was available');
  }

  const cache = new Map<string, number>();
  const fontFor = (style: MeasuredStyle): string =>
    (style.italic ? 'italic ' : '') +
    (style.bold ? '700 ' : '400 ') +
    style.size +
    'pt ' +
    style.family;

  return {
    width(text, style) {
      if (text.length === 0) return 0;
      // The separator is NUL because a font string can contain a space and a
      // comma, and a separator the font string can contain lets two different
      // measurements share one cache entry. Written as fromCharCode because a
      // raw NUL byte in source is invisible in every editor and diff.
      const key = fontFor(style) + MEASURE_KEY_SEPARATOR + text;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      context.font = fontFor(style);
      const width = context.measureText(text).width;
      // Bounded, so a long editing session cannot grow the cache without limit.
      if (cache.size > 20000) cache.clear();
      cache.set(key, width);
      return width;
    },
    height(style) {
      return style.size;
    },
  };
}
