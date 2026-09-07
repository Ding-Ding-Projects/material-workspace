/**
 * Between the docx codec's shape and the text engine's own.
 *
 * They are deliberately separate types even though they look alike. The codec
 * describes what the FILE FORMAT can express; the engine describes what the
 * editor can express. They overlap heavily today and will not always: the
 * engine already carries change-tracking marks and footnote references that
 * this format layer has no representation for yet.
 *
 * Keeping the conversion in one named place means the loss is visible and
 * countable — `describeConversionLoss` below reports it — rather than being
 * spread across a codec that quietly drops fields.
 */

import type { DocxBlock, DocxBlockKind, DocxDocument, DocxRun } from './docx';
import {
  type Block,
  type BlockKind,
  type Run,
  type TextDocument,
  emptyDocument,
  newBlockId,
} from '../text/model';

const TO_ENGINE: ReadonlyMap<DocxBlockKind, BlockKind> = new Map([
  ['body', 'paragraph'],
  ['heading1', 'heading1'],
  ['heading2', 'heading2'],
  ['heading3', 'heading3'],
  ['bullet', 'bulleted'],
  ['numbered', 'numbered'],
  ['quote', 'quote'],
  ['code', 'code'],
]);

const TO_FORMAT: ReadonlyMap<BlockKind, DocxBlockKind> = new Map([
  ['paragraph', 'body'],
  ['heading1', 'heading1'],
  ['heading2', 'heading2'],
  ['heading3', 'heading3'],
  ['bulleted', 'bullet'],
  ['numbered', 'numbered'],
  ['quote', 'quote'],
  ['code', 'code'],
]);

export function docxToDocument(source: DocxDocument): TextDocument {
  const blocks: Block[] = source.blocks.map((block) => ({
    id: newBlockId(),
    kind: TO_ENGINE.get(block.kind) ?? 'paragraph',
    runs: block.runs.map(toEngineRun),
    style: {},
  }));

  // A document with no blocks would give the editor nothing to put a caret in,
  // so an empty file opens as one empty paragraph rather than as a broken
  // editor with no place to type.
  if (blocks.length === 0) {
    blocks.push({ id: newBlockId(), kind: 'paragraph', runs: [], style: {} });
  }

  // Built from an empty document rather than assembled field by field, so
  // page geometry and the default style come from ONE place. Constructing
  // the object literally here means every new field added to the model has
  // to be remembered in a second location, and the one that gets forgotten
  // is the one nobody notices until a document opens with the wrong margins.
  return { ...emptyDocument(), blocks, footnotes: [] };
}

function toEngineRun(run: DocxRun): Run {
  return {
    text: run.text,
    formatting: {
      ...(run.bold === true ? { bold: true } : {}),
      ...(run.italic === true ? { italic: true } : {}),
      ...(run.underline === true ? { underline: true } : {}),
      ...(run.strikethrough === true ? { strikethrough: true } : {}),
    },
  };
}

export function documentToDocx(source: TextDocument): DocxDocument {
  const blocks: DocxBlock[] = [];
  for (const block of source.blocks) {
    // A page break has no paragraph of its own in this mapping. Emitting an
    // empty paragraph for it would add a blank line to the document every
    // time it round-tripped, which compounds.
    if (block.kind === 'pageBreak') continue;

    blocks.push({
      kind: TO_FORMAT.get(block.kind) ?? 'body',
      runs: block.runs
        // A run marked deleted is retained in the model so the change can be
        // rejected, and takes no space on the page. Writing it out would
        // resurrect deleted text in the exported file.
        .filter((run) => run.formatting.deleted === undefined)
        .map((run) => ({
          text: run.text,
          ...(run.formatting.bold === true ? { bold: true } : {}),
          ...(run.formatting.italic === true ? { italic: true } : {}),
          ...(run.formatting.underline === true ? { underline: true } : {}),
          ...(run.formatting.strikethrough === true ? { strikethrough: true } : {}),
        })),
    });
  }
  return { blocks };
}

/**
 * What converting this document to the format would drop.
 *
 * Counted from the document itself rather than listed generically, so the
 * warning says "3 page breaks and 12 formatted runs" instead of a paragraph of
 * things that might apply. A caller shows this BEFORE writing the file.
 */
export function describeConversionLoss(source: TextDocument): string[] {
  const losses: string[] = [];

  // Tables and images are not carried yet, and a block with no runs writes an
  // EMPTY PARAGRAPH - so without this the file saves cleanly, opens cleanly,
  // and the table is simply gone. A loss that is stated is a decision; a loss
  // that is silent is somebody's afternoon.
  const tables = source.blocks.filter((block) => block.kind === 'table').length;
  if (tables > 0) {
    losses.push(
      tables +
        (tables === 1 ? ' table' : ' tables') +
        ' (this format is not written yet, so they will not be in the file at all)',
    );
  }

  const images = source.blocks.filter((block) => block.kind === 'image').length;
  if (images > 0) {
    losses.push(
      images +
        (images === 1 ? ' image' : ' images') +
        ' (this format is not written yet, so they will not be in the file at all)',
    );
  }

  const pageBreaks = source.blocks.filter((block) => block.kind === 'pageBreak').length;
  if (pageBreaks > 0) {
    losses.push(pageBreaks + ' explicit page break' + (pageBreaks === 1 ? '' : 's'));
  }

  const deleted = source.blocks.reduce(
    (total, block) => total + block.runs.filter((run) => run.formatting.deleted !== undefined).length,
    0,
  );
  if (deleted > 0) {
    losses.push(
      deleted + ' tracked deletion' + (deleted === 1 ? '' : 's') + ' (removed, not exported)',
    );
  }

  const richFormatting = source.blocks.reduce(
    (total, block) =>
      total +
      block.runs.filter(
        (run) =>
          run.formatting.size !== undefined ||
          run.formatting.family !== undefined ||
          run.formatting.colour !== undefined ||
          run.formatting.highlight !== undefined ||
          run.formatting.vertical !== undefined,
      ).length,
    0,
  );
  if (richFormatting > 0) {
    losses.push(
      richFormatting +
        ' run' +
        (richFormatting === 1 ? '' : 's') +
        ' with size, font, colour, highlight or super/subscript',
    );
  }

  if (source.footnotes.length > 0) {
    losses.push(
      source.footnotes.length +
        ' footnote' +
        (source.footnotes.length === 1 ? '' : 's'),
    );
  }

  return losses;
}
