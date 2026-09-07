/**
 * Laying out a table, and an image, inside a paginated document.
 *
 * SIX THINGS THAT MAKE A TABLE LOOK RIGHT AND BE WRONG.
 *
 *   - A CELL WRAPS AGAINST ITS OWN WIDTH, not the page's. Measuring against
 *     the page gives cells that never wrap, so text runs straight over the
 *     column beside it and the table appears to have no columns at all.
 *
 *   - EVERY CELL IN A ROW GETS THE ROW'S HEIGHT. Sizing each cell to its own
 *     content leaves the borders not lining up, which reads as a broken table
 *     rather than as one cell having more text than another.
 *
 *   - COLUMN WIDTHS MUST SUM TO THE AVAILABLE WIDTH. Widths that fall short
 *     leave a gap down the side; widths that overshoot push the last column
 *     off the page. Both look like a rendering fault, so they are normalised.
 *
 *   - A ROW BREAKS AT A ROW BOUNDARY. Splitting a row across a page leaves
 *     half its cells on one page and half on the next with nothing lining up.
 *     A row taller than a whole page cannot be helped and is reported rather
 *     than silently clipped.
 *
 *   - A HEADER ROW REPEATS. Page two of a table without its headings is a
 *     wall of numbers, and the reader has to turn back to learn what any
 *     column means.
 *
 *   - AN EMPTY CELL STILL OCCUPIES ITS COLUMN. Dropping it shifts every later
 *     cell one column left, and the result is a plausible table that is not
 *     the one anybody wrote.
 *
 * AND ONE FOR IMAGES: A RESIZE KEEPS THE PROPORTIONS unless it is asked not
 * to. Fitting an image to a width by changing only its width stretches it, and
 * a stretched photograph is a defect nobody reports because it looks like a
 * bad photograph.
 */

import {
  type Block,
  type ImageContent,
  type TableContent,
  type TextDocument,
} from './model.js';
import {
  type LaidOutRun,
  type TextMeasurer,
  breakIntoLines,
  flatten,
  sliceRuns,
  styleFor,
} from './layout.js';

/** One cell, laid out. */
export interface LaidOutCell {
  /** Points from the table's start edge. */
  x: number;
  width: number;
  lines: { runs: LaidOutRun[]; y: number; height: number }[];
  /** What the cell needs on its own, before the row height is applied. */
  naturalHeight: number;
}

export interface LaidOutTableRow {
  cells: LaidOutCell[];
  /** Points from the table's top. */
  y: number;
  /** Every cell in the row gets this, or the borders do not line up. */
  height: number;
  header: boolean;
}

export interface LaidOutTable {
  rows: LaidOutTableRow[];
  width: number;
  height: number;
  columnWidths: number[];
}

/** Padding inside every cell, so text does not touch the rules. */
export const CELL_PADDING = 4;

/**
 * Share the available width out among the columns.
 *
 * Proportional to what was asked for, so a table whose author made one column
 * twice as wide keeps that relationship. A column asking for nothing, or for a
 * negative width, gets an equal share instead of vanishing.
 */
export function normaliseWidths(asked: readonly number[], available: number): number[] {
  const count = asked.length;
  if (count === 0) return [];

  const clean = asked.map((width) => (Number.isFinite(width) && width > 0 ? width : 0));
  const total = clean.reduce((sum, width) => sum + width, 0);

  if (total <= 0) return Array.from({ length: count }, () => available / count);

  const scaled = clean.map((width) =>
    width > 0 ? (width / total) * available : available / count / count,
  );

  // Whatever rounding lost goes to the last column, so the row is exactly the
  // width it was given rather than a fraction short of it.
  const scaledTotal = scaled.reduce((sum, width) => sum + width, 0);
  const last = scaled.length - 1;
  scaled[last] = (scaled[last] as number) + (available - scaledTotal);
  return scaled;
}

/**
 * Lay a table out at a given width.
 *
 * The whole table, unpaginated. Splitting it across pages is `splitTable`
 * below, which works on the rows this produced - so a row's height is decided
 * once and cannot differ between the two.
 */
export function layoutTable(
  table: TableContent,
  available: number,
  document: TextDocument,
  measurer: TextMeasurer,
): LaidOutTable {
  // The DECLARED widths count too, not only the cells present. A table saying
  // it has three columns whose first row holds one cell still has three: taking
  // the count from the cells alone silently discards the author's own widths
  // and draws a narrower table than the one they made.
  const columns = Math.max(
    ...table.rows.map((row) => row.cells.length),
    table.columnWidths.length,
    1,
  );
  const asked =
    table.columnWidths.length === columns
      ? table.columnWidths
      : Array.from({ length: columns }, () => available / columns);
  const widths = normaliseWidths(asked, available);

  const rows: LaidOutTableRow[] = [];
  let y = 0;

  for (const row of table.rows) {
    const cells: LaidOutCell[] = [];
    let x = 0;

    for (let index = 0; index < columns; index += 1) {
      const width = widths[index] as number;
      // An empty cell still occupies its column. Skipping it shifts every
      // later cell one column left.
      const cell = row.cells[index] ?? { blocks: [] };
      const inner = Math.max(1, width - CELL_PADDING * 2);

      const lines: { runs: LaidOutRun[]; y: number; height: number }[] = [];
      let cellY = CELL_PADDING;

      for (const block of cell.blocks) {
        const flat = flatten(block);
        const style = styleFor(document, block, flat.runs[0]?.formatting ?? {});
        const lineHeight =
          (block.style.lineHeight ?? document.defaultStyle.lineHeight) * measurer.height(style);

        // Against the CELL's width, not the page's. Measuring against the page
        // gives cells that never wrap and text that runs over its neighbour.
        for (const span of breakIntoLines(flat, inner, document, block, measurer)) {
          const sliced = sliceRuns(flat, span.start, span.end, document, block, measurer);
          lines.push({ runs: sliced.runs, y: cellY, height: lineHeight });
          cellY += lineHeight;
        }
      }

      cells.push({
        x,
        width,
        lines,
        naturalHeight: cellY + CELL_PADDING,
      });
      x += width;
    }

    // The tallest cell decides, and every cell in the row takes it.
    const height = Math.max(
      ...cells.map((cell) => cell.naturalHeight),
      measurer.height({
        family: document.defaultStyle.family,
        size: document.defaultStyle.size,
        bold: false,
        italic: false,
      }) + CELL_PADDING * 2,
    );

    rows.push({ cells, y, height, header: row.header === true });
    y += height;
  }

  return { rows, width: available, height: y, columnWidths: widths };
}

export interface TableSlice {
  /** Rows for this page, already positioned from the slice's own top. */
  readonly rows: LaidOutTableRow[];
  readonly height: number;
  /** Rows still waiting, if any. */
  readonly remaining: LaidOutTableRow[];
  /**
   * True when a single row is taller than a whole page.
   *
   * Reported rather than clipped: a row that cannot fit anywhere is a document
   * problem the author has to know about, and silently cutting it off loses
   * whatever was in the bottom of it.
   */
  readonly oversized: boolean;
}

/**
 * Take as many whole rows as fit.
 *
 * At a ROW boundary. Splitting a row leaves half its cells on one page and half
 * on the next with nothing lining up, which is worse than a shorter page.
 */
export function splitTable(
  rows: readonly LaidOutTableRow[],
  available: number,
  headers: readonly LaidOutTableRow[] = [],
): TableSlice {
  const headerHeight = headers.reduce((sum, row) => sum + row.height, 0);
  const taken: LaidOutTableRow[] = [];
  let used = headerHeight;
  let y = 0;

  // The header repeats at the top of the slice, so page two is not a wall of
  // numbers with no labels.
  for (const header of headers) {
    taken.push({ ...header, y });
    y += header.height;
  }

  let index = 0;
  for (; index < rows.length; index += 1) {
    const row = rows[index] as LaidOutTableRow;
    if (used + row.height > available) break;
    taken.push({ ...row, y });
    y += row.height;
    used += row.height;
  }

  const first = rows[0];
  const oversized =
    index === 0 && first !== undefined && headerHeight + first.height > available;

  if (oversized) {
    // It cannot be made to fit, so it is placed and reported rather than left
    // to loop for ever between pages.
    taken.push({ ...first, y });
    y += first.height;
    index = 1;
  }

  return {
    rows: taken,
    height: y,
    remaining: rows.slice(index),
    oversized,
  };
}

// ------------------------------------------------------------------ images --

export interface ScaledImage {
  readonly width: number;
  readonly height: number;
  /** True when the image had to be shrunk to fit. */
  readonly reduced: boolean;
}

/**
 * Fit an image to a width, keeping its proportions.
 *
 * Changing only the width stretches it, and a stretched photograph is a defect
 * nobody reports because it looks like a bad photograph rather than a bug.
 */
export function fitImage(image: ImageContent, available: number): ScaledImage {
  const width = image.width > 0 ? image.width : image.naturalWidth;
  const height = image.height > 0 ? image.height : image.naturalHeight;

  if (width <= available || width <= 0) {
    return { width, height, reduced: false };
  }

  const scale = available / width;
  return { width: available, height: height * scale, reduced: true };
}

/** The height an image block occupies, its spacing included. */
export function imageHeight(block: Block, available: number): number {
  if (block.image === undefined) return 0;
  const fitted = fitImage(block.image, available);
  return (block.style.spaceBefore ?? 0) + fitted.height + (block.style.spaceAfter ?? 8);
}
