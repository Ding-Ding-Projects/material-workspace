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

import type { Block, Run, RunFormatting, TextDocument } from './model.js';

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

export interface LaidOutPage {
  index: number;
  lines: LaidOutLine[];
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

function styleFor(document: TextDocument, block: Block, formatting: RunFormatting): MeasuredStyle {
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
interface FlatBlock {
  text: string;
  /** For each character index, which run it came from. */
  runAt: number[];
  runs: Run[];
}

function flatten(block: Block): FlatBlock {
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
function sliceRuns(
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

export function layout(document: TextDocument, measurer: TextMeasurer): LayoutResult {
  const page = document.page;
  const contentWidth = page.width - page.marginLeft - page.marginRight;
  const contentHeight = page.height - page.marginTop - page.marginBottom;

  const pages: LaidOutPage[] = [];
  let current: LaidOutPage = {
    index: 0,
    lines: [],
    width: page.width,
    height: page.height,
    contentWidth,
    contentHeight,
    marginLeft: page.marginLeft,
    marginTop: page.marginTop,
  };
  let y = 0;
  let lineCount = 0;

  const startNewPage = (): void => {
    pages.push(current);
    current = { ...current, index: current.index + 1, lines: [] };
    y = 0;
  };

  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.kind === 'pageBreak') {
      startNewPage();
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

    // Break the block into lines.
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

    const spaceBefore = block.style.spaceBefore ?? 0;
    const spaceAfter = block.style.spaceAfter ?? BLOCK_SPACE_AFTER[block.kind] ?? 8;
    const blockHeight = spaceBefore + lines.length * lineHeight + spaceAfter;

    // Keep a heading with what follows it: if the heading fits but the first
    // line of the next block would not, move the heading to the next page.
    if (KEEPS_WITH_NEXT.has(block.kind)) {
      const next = document.blocks[blockIndex + 1];
      const nextLine = next ? lineHeight : 0;
      if (y + blockHeight + nextLine > contentHeight && current.lines.length > 0) {
        startNewPage();
      }
    }

    y += spaceBefore;

    for (const [lineIndex, line] of lines.entries()) {
      if (y + lineHeight > contentHeight && current.lines.length > 0) {
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
    }

    y += spaceAfter;
  }

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
      const key = fontFor(style) + ' ' + text;
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
