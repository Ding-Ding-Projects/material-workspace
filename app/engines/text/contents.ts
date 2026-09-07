/**
 * A table of contents, built from the headings and the layout.
 *
 * WHY IT NEEDS THE LAYOUT AND NOT JUST THE DOCUMENT. A contents page without
 * page numbers is a list of headings, and a list of headings is not what
 * anybody wants a contents page for. The number is the whole point, and it
 * cannot be known until the document has been laid out - which is why this
 * lives beside the layout rather than inside the model.
 *
 * THE ORDERING TRAP THAT MAKES IT WRONG. Inserting the contents page CHANGES
 * the page numbers, because the contents itself takes pages. Building it once
 * from the layout of a document that did not contain it produces numbers that
 * are all short by however many pages it occupies - and they look plausible,
 * which is worse than looking broken.
 *
 * So this is a TWO PASS operation, and `build` returns the entries while
 * `insert` does the second pass. A caller that only runs the first gets a
 * contents that is quietly wrong, so `insert` is the exported route and the
 * single-pass version is not offered at all.
 */

import type { LayoutResult } from './layout.js';
import { type Block, type TextDocument, blockText, newBlockId } from './model.js';

export interface ContentsEntry {
  readonly blockId: string;
  readonly text: string;
  /** 1, 2 or 3, from the heading level. */
  readonly level: number;
  /** One-based, as a reader counts them. Null when the heading was not laid out. */
  readonly page: number | null;
}

const HEADING_LEVEL: Record<string, number> = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
};

/** The id of the block that holds a generated contents, so it can be replaced. */
export const CONTENTS_BLOCK_ID = 'contents';

/**
 * The headings, with the page each one landed on.
 *
 * A heading that produced no line - an empty one - gets a null page rather than
 * page 1. Defaulting to 1 puts a wrong number in front of a reader, and a wrong
 * page number is worse than an absent one because it will be followed.
 */
export function build(document: TextDocument, layout: LayoutResult): ContentsEntry[] {
  const pageOf = new Map<string, number>();
  for (const page of layout.pages) {
    for (const line of page.lines) {
      // The FIRST page a block appears on. A heading that wraps across a page
      // boundary is found where a reader would start reading it.
      if (!pageOf.has(line.blockId)) pageOf.set(line.blockId, page.index + 1);
    }
  }

  const entries: ContentsEntry[] = [];
  for (const block of document.blocks) {
    const level = HEADING_LEVEL[block.kind];
    if (level === undefined) continue;
    // The generated contents is itself made of blocks; listing its own entries
    // would grow it every time it was refreshed.
    if (block.id.startsWith(CONTENTS_BLOCK_ID)) continue;

    const text = blockText(block).trim();
    if (text === '') continue;

    entries.push({
      blockId: block.id,
      text,
      level,
      page: pageOf.get(block.id) ?? null,
    });
  }
  return entries;
}

export interface ContentsOptions {
  readonly title?: string;
  /** Deepest heading level to list. 3 by default. */
  readonly depth?: number;
}

/**
 * Insert or refresh the contents, and re-lay out so the numbers are right.
 *
 * The caller supplies the layout function, so this module does not depend on a
 * measurer and stays testable without one.
 *
 * TWO PASSES, and the second is not optional. The first tells us how many pages
 * the contents takes; the second gives the numbers a reader will actually find
 * the headings on. Skipping it produces numbers short by the length of the
 * contents - plausible, followed, and wrong.
 */
export function insert(
  document: TextDocument,
  relayout: (document: TextDocument) => LayoutResult,
  options: ContentsOptions = {},
): TextDocument {
  const depth = options.depth ?? 3;
  const title = options.title ?? 'Contents';

  // Start from a document with no contents in it, so a refresh replaces rather
  // than stacks. Refreshing five times must not leave five contents pages.
  const withoutContents: TextDocument = {
    ...document,
    blocks: document.blocks.filter((block) => !block.id.startsWith(CONTENTS_BLOCK_ID)),
  };

  const firstPass = build(withoutContents, relayout(withoutContents));
  const listed = firstPass.filter((entry) => entry.level <= depth);

  const withContents: TextDocument = {
    ...withoutContents,
    blocks: [...contentsBlocks(listed, title), ...withoutContents.blocks],
  };

  // The second pass. The contents is in the document now, so every page number
  // includes the pages it occupies.
  const secondPass = build(withoutContents, relayout(withContents));
  const finalEntries = secondPass.filter((entry) => entry.level <= depth);

  return {
    ...withoutContents,
    blocks: [...contentsBlocks(finalEntries, title), ...withoutContents.blocks],
  };
}

function contentsBlocks(entries: readonly ContentsEntry[], title: string): Block[] {
  const blocks: Block[] = [
    {
      id: CONTENTS_BLOCK_ID + '-title',
      kind: 'heading1',
      runs: [{ text: title, formatting: {} }],
      style: {},
    },
  ];

  if (entries.length === 0) {
    blocks.push({
      id: CONTENTS_BLOCK_ID + '-empty',
      kind: 'paragraph',
      // An honest empty state rather than a blank page, which reads as a
      // contents that failed to generate.
      runs: [{ text: 'This document has no headings yet.', formatting: {} }],
      style: {},
    });
  }

  entries.forEach((entry, index) => {
    blocks.push({
      id: CONTENTS_BLOCK_ID + '-' + index,
      kind: 'paragraph',
      runs: [
        {
          // A tab between the heading and its number, so a reader and an
          // exporter both get a leader rather than a run of spaces that
          // collapses in every format this can be saved as.
          text: entry.text + '\t' + (entry.page === null ? '-' : String(entry.page)),
          formatting: {},
        },
      ],
      // Indented by level, so the shape of the document is visible in the list.
      style: { indent: (entry.level - 1) * 18, spaceAfter: 2 },
    });
  });

  blocks.push({
    id: CONTENTS_BLOCK_ID + '-break',
    kind: 'pageBreak',
    runs: [],
    style: {},
  });

  return blocks;
}

/** Whether a document already carries a generated contents. */
export function hasContents(document: TextDocument): boolean {
  return document.blocks.some((block) => block.id.startsWith(CONTENTS_BLOCK_ID));
}

/** Remove a generated contents, leaving the document otherwise untouched. */
export function remove(document: TextDocument): TextDocument {
  return {
    ...document,
    blocks: document.blocks.filter((block) => !block.id.startsWith(CONTENTS_BLOCK_ID)),
  };
}

/** A fresh block id, re-exported so a caller need not import the model too. */
export { newBlockId };
