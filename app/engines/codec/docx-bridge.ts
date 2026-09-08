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


/**
 * A data URL, split into its media type and its bytes.
 *
 * Returns null for anything that is not one. The alternative - guessing at the
 * bytes - writes a media part full of the URL's own text, which is a valid zip
 * entry, a valid relationship, and a picture that will not decode.
 */
function fromDataUrl(source: string): { extension: string; data: Uint8Array } | null {
  const match = /^data:image\/([a-z0-9+.-]+);base64,(.*)$/i.exec(source);
  if (match === null) return null;

  const declared = (match[1] ?? '').toLowerCase();
  const extension = declared === 'jpeg' ? 'jpg' : declared;

  try {
    const binary = atob(match[2] ?? '');
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    return { extension, data };
  } catch {
    return null;
  }
}

/** Bytes back to a data URL, for the model to hold and the renderer to show. */
function toDataUrl(data: Uint8Array, extension: string): string {
  let binary = '';
  // In chunks, because spreading a large array into String.fromCharCode blows
  // the call stack on anything above a megabyte or so - and a photograph is.
  const CHUNK = 0x8000;
  for (let index = 0; index < data.length; index += CHUNK) {
    binary += String.fromCharCode(...data.subarray(index, index + CHUNK));
  }
  const media = extension === 'jpg' ? 'jpeg' : extension;
  return 'data:image/' + media + ';base64,' + btoa(binary);
}

/** Points to English metric units: 12,700 to the point. */
const EMU_PER_POINT = 12700;

export function docxToDocument(source: DocxDocument): TextDocument {
  const blocks: Block[] = source.blocks.map((block) => {
    if (block.kind === 'table' && block.table !== undefined) {
      return {
        id: newBlockId(),
        kind: 'table' as const,
        runs: [],
        style: { spaceBefore: 6, spaceAfter: 10 },
        table: {
          rows: block.table.rows.map((row) => ({
            cells: row.cells.map((cell) => ({
              blocks: cell.blocks.map((inner) => ({
                id: newBlockId(),
                kind: TO_ENGINE.get(inner.kind) ?? ('paragraph' as const),
                runs: inner.runs.map(toEngineRun),
                style: { spaceAfter: 0 },
              })),
            })),
            ...(row.header === true ? { header: true } : {}),
          })),
          // Back from twentieths of a point. Keeping the raw numbers would
          // make every column twenty times too wide, which normalisation then
          // hides by scaling them - so the proportions survive and the sizes
          // are meaningless, which is the harder version to notice.
          columnWidths: block.table.gridWidths.map((width) => width / 20),
        },
      };
    }

    if (block.kind === 'image' && block.image !== undefined) {
      const width = block.image.widthEmu / EMU_PER_POINT;
      const height = block.image.heightEmu / EMU_PER_POINT;
      return {
        id: newBlockId(),
        kind: 'image' as const,
        runs: [],
        style: { spaceBefore: 6, spaceAfter: 10, align: 'center' as const },
        image: {
          source: toDataUrl(block.image.data, block.image.extension),
          width,
          height,
          naturalWidth: width,
          naturalHeight: height,
          alt: block.image.alt,
        },
      };
    }

    return {
      id: newBlockId(),
      kind: TO_ENGINE.get(block.kind) ?? ('paragraph' as const),
      runs: block.runs.map(toEngineRun),
      style: {},
    };
  });

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

    if (block.kind === 'image' && block.image !== undefined) {
      const parsed = fromDataUrl(block.image.source);
      // An image whose source is not a data URL is left out rather than written
      // as a broken part - and `describeConversionLoss` counts it, so the save
      // says how many did not go rather than quietly writing fewer.
      if (parsed !== null) {
        blocks.push({
          kind: 'image',
          runs: [],
          image: {
            data: parsed.data,
            extension: parsed.extension,
            widthEmu: Math.round(block.image.width * EMU_PER_POINT),
            heightEmu: Math.round(block.image.height * EMU_PER_POINT),
            alt: block.image.alt,
          },
        });
      }
      continue;
    }

    if (block.kind === 'table' && block.table !== undefined) {
      blocks.push({
        kind: 'table',
        runs: [],
        table: {
          rows: block.table.rows.map((row) => ({
            cells: row.cells.map((cell) => ({
              blocks: cell.blocks.map((inner) => ({
                kind: TO_FORMAT.get(inner.kind) ?? 'body',
                runs: inner.runs
                  .filter((run) => run.formatting.deleted === undefined)
                  .map((run) => ({
                    text: run.text,
                    ...(run.formatting.bold === true ? { bold: true } : {}),
                    ...(run.formatting.italic === true ? { italic: true } : {}),
                    ...(run.formatting.underline === true ? { underline: true } : {}),
                    ...(run.formatting.strikethrough === true ? { strikethrough: true } : {}),
                  })),
              })),
            })),
            ...(row.header === true ? { header: true } : {}),
          })),
          // Twentieths of a point, which is what `w:w` carries. Writing points
          // gives a table a twentieth of its width, and Word does not complain
          // - it draws the thing a fifth of an inch across.
          gridWidths: block.table.columnWidths.map((width) => Math.round(width * 20)),
        },
      });
      continue;
    }

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
  // Tables ARE carried now, so the line that said they were not is gone. A
  // warning that is no longer true is worse than none: it tells somebody to
  // avoid a thing that works.

  // Images ARE carried now. What is still counted is the ones that cannot be:
  // a source that is not a data URL has no bytes to write, and writing the URL
  // as though it were the picture produces a valid part that will not decode.
  const unreadable = source.blocks.filter(
    (block) =>
      block.kind === 'image' &&
      block.image !== undefined &&
      fromDataUrl(block.image.source) === null,
  ).length;
  if (unreadable > 0) {
    losses.push(
      unreadable +
        (unreadable === 1 ? ' image whose data could not be read' : ' images whose data could not be read') +
        ' (they will not be in the file)',
    );
  }

  // And the ones with no alternative text, because the file will carry them
  // and a reader who cannot see them will get nothing.
  const undescribed = source.blocks.filter(
    (block) => block.kind === 'image' && (block.image?.alt ?? '') === '',
  ).length;
  if (undescribed > 0) {
    losses.push(
      undescribed +
        (undescribed === 1 ? ' image with no alternative text' : ' images with no alternative text') +
        ' (they will be in the file, and invisible to a screen reader)',
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
