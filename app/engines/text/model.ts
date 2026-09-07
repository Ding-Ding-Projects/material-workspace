/**
 * The text document model.
 *
 * A document is a list of BLOCKS; each block is a list of RUNS; a run is a span
 * of text with uniform formatting. That split is not arbitrary — it is what
 * makes every later operation tractable:
 *
 *   - Layout works block by block, so a change in paragraph nine cannot force
 *     paragraph one to be measured again.
 *   - Formatting splits and merges runs, which keeps "bold these three words"
 *     an operation on a list rather than a rewrite of the paragraph.
 *   - Change tracking attaches to runs, so an insertion and a deletion in the
 *     same paragraph stay distinguishable.
 *
 * The model is plain data. It serialises to JSON with no custom logic, which is
 * what lets the document store, the autosave history and the file codecs all
 * work on it without knowing anything about layout.
 */

export interface RunFormatting {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Points. Absent means the block style decides. */
  size?: number;
  family?: string;
  colour?: string;
  highlight?: string;
  /** Superscript or subscript; absent is baseline. */
  vertical?: 'super' | 'sub';
  /** Change tracking. A run marked deleted is retained, not removed, so the
   *  change can be rejected. */
  inserted?: { author: string; at: string };
  deleted?: { author: string; at: string };
}

export interface Run {
  text: string;
  formatting: RunFormatting;
}

export type BlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulleted'
  | 'numbered'
  | 'quote'
  | 'code'
  | 'pageBreak'
  | 'table'
  | 'image';

export interface BlockStyle {
  align?: 'start' | 'center' | 'end' | 'justify';
  /** Points. */
  spaceBefore?: number;
  spaceAfter?: number;
  lineHeight?: number;
  indent?: number;
  /** Nesting level for list blocks. */
  level?: number;
}

/**
 * One cell of a table.
 *
 * Holds BLOCKS, not runs, because a cell with two paragraphs in it is ordinary
 * and a cell that can only hold one line quietly loses the second.
 */
export interface TableCell {
  blocks: Block[];
}

export interface TableRow {
  cells: TableCell[];
  /**
   * A header row repeats at the top of every page the table runs onto.
   *
   * Without it, page two of a table is a wall of numbers with no labels, and
   * the reader has to flip back to learn what any column means.
   */
  header?: boolean;
}

export interface TableContent {
  rows: TableRow[];
  /**
   * Column widths in points.
   *
   * Normalised against the content width when the table is laid out: widths
   * that do not sum to it leave a gap down the side or push the last column
   * off the page, and both look like a rendering fault.
   */
  columnWidths: number[];
}

export interface ImageContent {
  /** A data URL. Bundled with the document rather than linked to a file. */
  source: string;
  /** Points, as drawn. */
  width: number;
  height: number;
  /** The intrinsic size, so a resize can keep the proportions. */
  naturalWidth: number;
  naturalHeight: number;
  /**
   * MANDATORY, and empty only when the image is genuinely decorative.
   *
   * An image with no alternative text is an image that does not exist for
   * anybody who cannot see it, and in a document it is frequently the part
   * carrying the point.
   */
  alt: string;
}

export interface Block {
  id: string;
  kind: BlockKind;
  runs: Run[];
  style: BlockStyle;
  /** Set on a table block, and on no other kind. */
  table?: TableContent;
  /** Set on an image block, and on no other kind. */
  image?: ImageContent;
}

export interface Footnote {
  id: string;
  /** The block and offset the reference sits at. */
  blockId: string;
  offset: number;
  runs: Run[];
}

export interface PageGeometry {
  /** Points. A4 by default; 1pt = 1/72in. */
  width: number;
  height: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
}

export interface TextDocument {
  schema: 'material-workspace/text@1';
  blocks: Block[];
  footnotes: Footnote[];
  page: PageGeometry;
  defaultStyle: {
    family: string;
    size: number;
    lineHeight: number;
  };
}

export const A4: PageGeometry = {
  width: 595.28,
  height: 841.89,
  marginTop: 72,
  marginRight: 72,
  marginBottom: 72,
  marginLeft: 72,
};

export const LETTER: PageGeometry = {
  width: 612,
  height: 792,
  marginTop: 72,
  marginRight: 72,
  marginBottom: 72,
  marginLeft: 72,
};

let idCounter = 0;

/** Ids are unique within a session and stable within a document once assigned. */
export function newBlockId(): string {
  idCounter += 1;
  return 'b' + idCounter.toString(36) + '-' + Math.floor(performance.now()).toString(36);
}

export function emptyDocument(page: PageGeometry = A4): TextDocument {
  return {
    schema: 'material-workspace/text@1',
    blocks: [
      {
        id: newBlockId(),
        kind: 'paragraph',
        runs: [{ text: '', formatting: {} }],
        style: {},
      },
    ],
    footnotes: [],
    page,
    defaultStyle: { family: 'Georgia, serif', size: 11, lineHeight: 1.45 },
  };
}

/** The plain text of a block, ignoring formatting. */
export function blockText(block: Block): string {
  return block.runs
    .filter((run) => !run.formatting.deleted)
    .map((run) => run.text)
    .join('');
}

export function documentText(document: TextDocument): string {
  return document.blocks.map(blockText).join('\n');
}

/**
 * Split a block's runs at a character offset, returning the index of the run
 * that begins at that offset.
 *
 * Splitting rather than searching is what keeps formatting operations simple:
 * once the boundaries exist as run boundaries, applying a format is a loop over
 * a slice rather than an interval calculation.
 */
export function splitRunsAt(block: Block, offset: number): number {
  let consumed = 0;
  for (let index = 0; index < block.runs.length; index += 1) {
    const run = block.runs[index];
    if (!run) break;
    const length = run.text.length;

    if (consumed === offset) return index;
    if (consumed + length > offset) {
      const cut = offset - consumed;
      const left: Run = { text: run.text.slice(0, cut), formatting: { ...run.formatting } };
      const right: Run = { text: run.text.slice(cut), formatting: { ...run.formatting } };
      block.runs.splice(index, 1, left, right);
      return index + 1;
    }
    consumed += length;
  }
  return block.runs.length;
}

/** Merge neighbouring runs whose formatting is identical, and drop empty ones.
 *  Without this every edit fragments the paragraph a little more. */
export function normaliseRuns(block: Block): void {
  const merged: Run[] = [];
  for (const run of block.runs) {
    if (run.text.length === 0) continue;
    const previous = merged.at(-1);
    if (previous && sameFormatting(previous.formatting, run.formatting)) {
      previous.text += run.text;
      continue;
    }
    merged.push({ text: run.text, formatting: { ...run.formatting } });
  }
  // A block always has at least one run, so the caret has somewhere to live.
  block.runs = merged.length > 0 ? merged : [{ text: '', formatting: {} }];
}

export function sameFormatting(a: RunFormatting, b: RunFormatting): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = (a as Record<string, unknown>)[key];
    const right = (b as Record<string, unknown>)[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

/** Apply a formatting change across a range within one block. */
export function applyFormatting(
  block: Block,
  start: number,
  end: number,
  change: RunFormatting,
): void {
  if (end <= start) return;
  const from = splitRunsAt(block, start);
  const to = splitRunsAt(block, end);
  for (let index = from; index < to; index += 1) {
    const run = block.runs[index];
    if (!run) continue;
    run.formatting = { ...run.formatting, ...change };
  }
  normaliseRuns(block);
}

/** Insert text at an offset, inheriting the formatting of the run before it. */
export function insertText(block: Block, offset: number, text: string): void {
  if (text.length === 0) return;
  const index = splitRunsAt(block, offset);
  const inherited = block.runs[Math.max(0, index - 1)]?.formatting ?? {};
  block.runs.splice(index, 0, { text, formatting: { ...inherited } });
  normaliseRuns(block);
}

/** Delete a range within one block. */
export function deleteRange(block: Block, start: number, end: number): void {
  if (end <= start) return;
  const from = splitRunsAt(block, start);
  const to = splitRunsAt(block, end);
  block.runs.splice(from, to - from);
  normaliseRuns(block);
}

/** The formatting in effect across a range: a property is reported only when
 *  EVERY run in the range agrees, so a mixed selection reports nothing rather
 *  than the first run's answer. */
export function formattingAcross(block: Block, start: number, end: number): RunFormatting {
  if (end <= start) return {};
  let consumed = 0;
  const covered: RunFormatting[] = [];
  for (const run of block.runs) {
    const runStart = consumed;
    const runEnd = consumed + run.text.length;
    consumed = runEnd;
    if (runEnd <= start || runStart >= end) continue;
    covered.push(run.formatting);
  }
  if (covered.length === 0) return {};

  const result: RunFormatting = {};
  const first = covered[0] as Record<string, unknown>;
  for (const key of Object.keys(first)) {
    const value = first[key];
    if (covered.every((f) => JSON.stringify((f as Record<string, unknown>)[key]) === JSON.stringify(value))) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
