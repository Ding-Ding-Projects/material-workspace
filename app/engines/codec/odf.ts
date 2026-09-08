/**
 * OpenDocument: `.ods` and `.odt`.
 *
 * Also a ZIP of XML, but it is NOT a dialect of the OOXML formats — it is a
 * different design with different traps:
 *
 *   - THE MIMETYPE ENTRY MUST BE FIRST AND STORED. It is how a reader
 *     identifies the file without unpacking it. Compressing it, or writing it
 *     anywhere but first, produces an archive that some readers open and
 *     others reject as an unknown type.
 *
 *   - EMPTY CELLS ARE RUN-LENGTH ENCODED. A row of one value followed by
 *     nothing is written as one cell plus a repeat count, and a reader that
 *     ignores the count collapses every gap. A sheet with a value in A1 and
 *     another in Z1 reads as two adjacent cells — which looks like a tidy
 *     little table and is wrong.
 *
 *   - THE FORMULA SYNTAX IS DIFFERENT. Not slightly: `of:=SUM([.A1:.A9])`
 *     rather than `SUM(A1:A9)`. References are bracketed and dot-prefixed, the
 *     range separator is a colon inside one bracket pair, and the whole thing
 *     carries a namespace prefix. Storing an A1 formula unchanged produces a
 *     file that opens with every formula broken.
 *
 *   - A CELL CARRIES ITS VALUE AND ITS DISPLAY TEXT SEPARATELY. The typed
 *     value is an attribute; the text inside is what was on screen. Reading
 *     the text gives you a locale-formatted string where a number belongs.
 */

import {
  type XmlElement,
  type XmlWriteNode,
  childElements,
  firstChild,
  parseXml,
  textOf,
  writeXml,
} from './xml';
import { type ZipEntry, readZip, writeZip } from './zip';
import { columnName } from '../sheet/reference';
import type {
  DocxBlock,
  DocxBlockKind,
  DocxCell,
  DocxDocument,
  DocxRun,
  DocxTableRow,
} from './docx';
import type { XlsxCell, XlsxSheet, XlsxWorkbook } from './xlsx';

export class OdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdfError';
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
};

const SPREADSHEET_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const TEXT_MIME = 'application/vnd.oasis.opendocument.text';

/**
 * A repeat count past this is treated as "to the end of the used area".
 *
 * Writers routinely pad a row out to the sheet's full width with a single
 * repeated empty cell, so a naive reader that honours the count allocates a
 * million cells for a row containing three values.
 */
const MAX_MEANINGFUL_REPEAT = 4096;

// -------------------------------------------------------- formula syntax --

/**
 * An OpenDocument formula to A1.
 *
 * `of:=SUM([.A1:.A9])` becomes `SUM(A1:A9)`. The sheet-qualified form
 * `[Sheet2.A1]` becomes `Sheet2!A1`.
 */
export function odfFormulaToA1(formula: string): string {
  let body = formula;
  // The namespace prefix is optional in practice; both forms occur.
  body = body.replace(/^of:/, '');
  body = body.replace(/^=/, '');

  return body.replace(/\[([^\]]*)\]/g, (_whole, inner: string) => {
    // A range inside one bracket pair: [.A1:.B2]
    return inner
      .split(':')
      .map((part) => {
        const trimmed = part.trim();
        if (trimmed.startsWith('.')) return trimmed.slice(1);
        const dot = trimmed.indexOf('.');
        if (dot > 0) {
          const sheet = trimmed.slice(0, dot).replace(/^'|'$/g, '');
          return sheet + '!' + trimmed.slice(dot + 1);
        }
        return trimmed;
      })
      .join(':');
  });
}

/** A1 to an OpenDocument formula. The inverse of the above. */
export function a1FormulaToOdf(formula: string): string {
  const body = formula.replace(/^=/, '');

  // Bracket every reference and range. Ranges must land inside ONE bracket
  // pair, so they are matched before single references.
  const withRanges = body.replace(
    /(?:([A-Za-z0-9_]+|'[^']*')!)?(\$?[A-Za-z]{1,3}\$?\d{1,7}):(\$?[A-Za-z]{1,3}\$?\d{1,7})/g,
    (_whole, sheet: string | undefined, start: string, end: string) => {
      const prefix = sheet === undefined ? '.' : sheet + '.';
      return '[' + prefix + start + ':' + prefix + end + ']';
    },
  );

  const withReferences = withRanges.replace(
    /(?<![[.\w$])(?:([A-Za-z0-9_]+|'[^']*')!)?(\$?[A-Za-z]{1,3}\$?\d{1,7})(?![\w\]])/g,
    (whole, sheet: string | undefined, reference: string) => {
      // Anything already inside brackets was handled above.
      if (whole.includes('[')) return whole;
      return '[' + (sheet === undefined ? '.' : sheet + '.') + reference + ']';
    },
  );

  return 'of:=' + withReferences;
}

// ---------------------------------------------------------------- reading --

async function readOdfContent(bytes: Uint8Array, expected: string): Promise<XmlElement> {
  const parts = await readZip(bytes);

  const mimetype = parts.get('mimetype');
  if (mimetype !== undefined) {
    const declared = decoder.decode(mimetype).trim();
    if (declared !== expected) {
      throw new OdfError('this file declares itself as ' + declared);
    }
  }

  const content = parts.get('content.xml');
  if (content === undefined) {
    throw new OdfError('content.xml is missing; this is not an OpenDocument file');
  }
  return parseXml(decoder.decode(content));
}

export async function readOds(bytes: Uint8Array): Promise<XlsxWorkbook> {
  const root = await readOdfContent(bytes, SPREADSHEET_MIME);
  const body = firstChild(root, 'office:body');
  const spreadsheet = body === undefined ? undefined : firstChild(body, 'office:spreadsheet');
  if (spreadsheet === undefined) throw new OdfError('the file contains no spreadsheet');

  const sheets: XlsxSheet[] = [];
  for (const table of childElements(spreadsheet, 'table:table')) {
    const name = table.attributes.get('table:name') ?? 'Sheet' + (sheets.length + 1);
    sheets.push({ name, cells: readTable(table) });
  }
  return { sheets };
}

function readTable(table: XmlElement): XlsxCell[] {
  const cells: XlsxCell[] = [];
  let row = 0;

  for (const rowElement of childElements(table, 'table:table-row')) {
    const rowRepeat = repeatCount(rowElement, 'table:number-rows-repeated');
    let column = 0;
    const rowCells: XlsxCell[] = [];

    for (const cellElement of childElements(rowElement, 'table:table-cell')) {
      const repeat = repeatCount(cellElement, 'table:number-columns-repeated');
      const cell = readCell(cellElement, column, row);

      if (cell !== undefined) {
        // A repeated cell that actually holds a value is repeated in full.
        // Writers use this for a run of identical values, not only for gaps.
        for (let index = 0; index < repeat; index += 1) {
          rowCells.push({ ...cell, column: column + index });
        }
      }
      column += repeat;
    }

    // A repeated ROW of empty cells is a gap, not content. Only rows that
    // actually hold something are repeated.
    if (rowCells.length > 0) {
      for (let index = 0; index < rowRepeat; index += 1) {
        for (const cell of rowCells) cells.push({ ...cell, row: cell.row + index });
      }
    }
    row += rowRepeat;
  }

  return cells;
}

/**
 * A repeat count, bounded.
 *
 * Writers pad rows out to the sheet's full width with one repeated empty cell,
 * so honouring a count of a million allocates a million cells for a row of
 * three values. Past the bound the run is treated as padding.
 */
function repeatCount(element: XmlElement, attribute: string): number {
  const raw = element.attributes.get(attribute);
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return value > MAX_MEANINGFUL_REPEAT ? 1 : Math.floor(value);
}

function readCell(cell: XmlElement, column: number, row: number): XlsxCell | undefined {
  const type = cell.attributes.get('office:value-type');
  const formula = cell.attributes.get('table:formula');

  // The value is an ATTRIBUTE; the text inside is the formatted display
  // string. Reading the text gives a locale-formatted number, which is a
  // string where a number belongs.
  let value: string | number | boolean | undefined;
  let isText = false;

  if (type === 'float' || type === 'percentage' || type === 'currency') {
    const raw = cell.attributes.get('office:value');
    if (raw !== undefined) value = Number(raw);
  } else if (type === 'boolean') {
    value = cell.attributes.get('office:boolean-value') === 'true';
  } else if (type === 'date') {
    value = cell.attributes.get('office:date-value');
    isText = true;
  } else if (type === 'string') {
    const explicit = cell.attributes.get('office:string-value');
    value = explicit ?? paragraphText(cell);
    isText = true;
  } else if (formula === undefined) {
    const text = paragraphText(cell);
    if (text === '') return undefined;
    value = text;
    isText = true;
  }

  if (formula === undefined && value === undefined) return undefined;

  return {
    column,
    row,
    ...(formula !== undefined ? { formula: odfFormulaToA1(formula) } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(isText ? { isText: true } : {}),
  };
}

/** A cell's paragraphs joined, since a cell may hold several. */
function paragraphText(cell: XmlElement): string {
  return childElements(cell, 'text:p')
    .map((paragraph) => textOf(paragraph))
    .join('\n');
}

export async function readOdt(bytes: Uint8Array): Promise<DocxDocument> {
  const root = await readOdfContent(bytes, TEXT_MIME);
  const body = firstChild(root, 'office:body');
  const text = body === undefined ? undefined : firstChild(body, 'office:text');
  if (text === undefined) throw new OdfError('the file contains no text body');

  // The archive is opened a second time for the media parts. Cheap, and it
  // keeps readOdfContent's one job to itself rather than threading an unpacked
  // archive through every caller that has no pictures.
  const parts = await readZip(bytes);
  const pictures = new Map<string, Uint8Array>();
  for (const [name, data] of parts) {
    if (name.startsWith('Pictures/')) pictures.set(name, data);
  }

  const blocks: DocxBlock[] = [];
  collectBlocks(text, blocks, undefined, pictures);
  return { blocks };
}

/**
 * Walk the body, descending into lists.
 *
 * A list is a container of items, each of which contains paragraphs. A reader
 * that only looks at top-level paragraphs sees an empty document for anything
 * that is mostly a list.
 */
function collectBlocks(
  container: XmlElement,
  blocks: DocxBlock[],
  listKind: DocxBlockKind | undefined,
  pictureParts: ReadonlyMap<string, Uint8Array> = new Map(),
): void {
  for (const child of container.children) {
    if ((child as XmlElement).name === undefined) continue;
    const element = child as XmlElement;

    if (element.name === 'text:h') {
      const level = Number(element.attributes.get('text:outline-level') ?? '1');
      const kind: DocxBlockKind =
        level <= 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      blocks.push({ kind, runs: readSpans(element) });
      continue;
    }

    if (element.name === 'text:p') {
      // A picture lives INSIDE a paragraph in ODF, so the check has to happen
      // here rather than beside the table one - a reader that looks for
      // draw:frame among the body's own children never finds one.
      const picture = readOdfImage(element, pictureParts);
      blocks.push(picture ?? { kind: listKind ?? 'body', runs: readSpans(element) });
      continue;
    }

    if (element.name === 'text:list') {
      // An ordered list carries a style whose name conventionally records it.
      // Absent that, unordered is the safer default: mislabelling a bullet as
      // a number is the more visible of the two errors.
      const styleName = element.attributes.get('text:style-name') ?? '';
      const kind: DocxBlockKind = /number|ordered|L2/i.test(styleName) ? 'numbered' : 'bullet';
      for (const item of childElements(element, 'text:list-item')) {
        collectBlocks(item, blocks, kind, pictureParts);
      }
      continue;
    }

    if (element.name === 'text:list-item') {
      collectBlocks(element, blocks, listKind, pictureParts);
      continue;
    }

    if (element.name === 'table:table') {
      blocks.push(readOdfTable(element));
      continue;
    }

    if (element.name === 'text:p') {
      // Handled above unless it holds a frame; a paragraph carrying a picture
      // reaches here only when the text branch did not claim it.
      continue;
    }
  }
}

/**
 * A picture inside a paragraph, if there is one.
 *
 * Returns null for an ordinary paragraph so the caller falls through to the
 * text reader. The bytes come from the archive by the href the frame carries -
 * a reader that keeps only the href hands back a reference to a file nobody
 * else has.
 */
function readOdfImage(
  paragraph: XmlElement,
  pictureParts: ReadonlyMap<string, Uint8Array>,
): DocxBlock | null {
  const frame = childElements(paragraph, 'draw:frame')[0];
  if (frame === undefined) return null;

  const picture = childElements(frame, 'draw:image')[0];
  if (picture === undefined) return null;

  const href = picture.attributes.get('xlink:href');
  if (href === undefined) return null;
  const data = pictureParts.get(href.startsWith('./') ? href.slice(2) : href);
  if (data === undefined) return null;

  // ODF sizes carry their unit in the string, so the number has to be taken
  // WITH it: reading "5.292cm" as a number gives 5, and the picture comes back
  // five ten-thousandths of its size.
  const toEmu = (value: string | undefined): number => {
    if (value === undefined) return 0;
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount)) return 0;
    if (value.endsWith('cm')) return Math.round(amount * 360000);
    if (value.endsWith('mm')) return Math.round(amount * 36000);
    if (value.endsWith('in')) return Math.round(amount * 914400);
    if (value.endsWith('pt')) return Math.round(amount * 12700);
    return 0;
  };

  const description = childElements(frame, 'svg:desc')[0];
  const alt = description === undefined ? '' : textOf(description);

  const extension = href.slice(href.lastIndexOf('.') + 1).toLowerCase();

  return {
    kind: 'image',
    runs: [],
    image: {
      data,
      extension,
      widthEmu: toEmu(frame.attributes.get('svg:width')),
      heightEmu: toEmu(frame.attributes.get('svg:height')),
      alt,
    },
  };
}

/**
 * An ODF table.
 *
 * `table:number-columns-repeated` on a column is how ODF says "three of these"
 * - a reader that counts elements gets one column where the file declares
 * three, and every row after the first lands in the wrong place. The same
 * attribute appears on cells, and it means the same thing there.
 */
function readOdfTable(element: XmlElement): DocxBlock {
  const gridWidths: number[] = [];
  for (const column of childElements(element, 'table:table-column')) {
    const repeat = Number(column.attributes.get('table:number-columns-repeated') ?? '1');
    for (let index = 0; index < Math.max(1, repeat); index += 1) gridWidths.push(2000);
  }

  const rows: DocxTableRow[] = [];

  const collectRows = (container: XmlElement, header: boolean): void => {
    for (const row of childElements(container, 'table:table-row')) {
      const cells: DocxCell[] = [];
      for (const cell of childElements(row, 'table:table-cell')) {
        const blocks: DocxBlock[] = [];
        for (const paragraph of childElements(cell, 'text:p')) {
          blocks.push({ kind: 'body', runs: readSpans(paragraph) });
        }
        const repeat = Number(cell.attributes.get('table:number-columns-repeated') ?? '1');
        for (let index = 0; index < Math.max(1, repeat); index += 1) cells.push({ blocks });
      }
      rows.push(header ? { cells, header: true } : { cells });
    }
  };

  // The header rows come first in the file and are their own element. A reader
  // that only looks at table:table-row misses them entirely, so the table
  // arrives with its headings gone and one row short.
  for (const group of childElements(element, 'table:table-header-rows')) {
    collectRows(group, true);
  }
  collectRows(element, false);

  while (gridWidths.length < Math.max(...rows.map((row) => row.cells.length), 1)) {
    gridWidths.push(2000);
  }

  return { kind: 'table', runs: [], table: { rows, gridWidths } };
}

/**
 * Runs inside a paragraph.
 *
 * Formatting lives in a named style defined elsewhere, so this reads the
 * conventional style names this writer emits and treats anything else as
 * plain. Resolving arbitrary automatic styles is a larger piece of work and
 * its absence is declared rather than approximated.
 */
function readSpans(paragraph: XmlElement): DocxRun[] {
  const runs: DocxRun[] = [];

  const walk = (element: XmlElement, inherited: Partial<DocxRun>): void => {
    for (const child of element.children) {
      if ((child as XmlElement).name === undefined) {
        const text = (child as { text: string }).text;
        if (text.length > 0) runs.push({ text, ...inherited });
        continue;
      }
      const node = child as XmlElement;

      if (node.name === 'text:s') {
        // An explicit run of spaces. Leading and repeated spaces are encoded
        // this way, so ignoring it silently collapses indentation.
        const count = Number(node.attributes.get('text:c') ?? '1');
        runs.push({ text: ' '.repeat(Math.min(Math.max(count, 1), 1000)), ...inherited });
        continue;
      }
      if (node.name === 'text:tab') {
        runs.push({ text: '\t', ...inherited });
        continue;
      }
      if (node.name === 'text:line-break') {
        runs.push({ text: '\n', ...inherited });
        continue;
      }
      if (node.name === 'text:span') {
        const style = node.attributes.get('text:style-name') ?? '';
        walk(node, {
          ...inherited,
          ...(/bold/i.test(style) ? { bold: true } : {}),
          ...(/italic/i.test(style) ? { italic: true } : {}),
          ...(/underline/i.test(style) ? { underline: true } : {}),
          ...(/strike/i.test(style) ? { strikethrough: true } : {}),
        });
        continue;
      }
      walk(node, inherited);
    }
  };

  walk(paragraph, {});
  return runs;
}

// ---------------------------------------------------------------- writing --

/**
 * The archive, with the mimetype entry FIRST.
 *
 * A reader identifies an OpenDocument file by reading that entry at a fixed
 * offset without unpacking the archive, so its position is part of the format
 * rather than a convention. Every entry here is stored, which satisfies the
 * other half of the rule for free.
 */
function writeOdfArchive(mimetype: string, contentXml: string, extra: ZipEntry[] = []): Uint8Array {
  return writeZip([
    { name: 'mimetype', data: encoder.encode(mimetype) },
    {
      name: 'META-INF/manifest.xml',
      // Every media part is declared. A picture in the package with no manifest
      // entry is a picture a strict reader refuses to load, and the document
      // opens with a grey box where the image was.
      data: encoder.encode(
        manifestXml(
          mimetype,
          extra
            .filter((entry) => entry.name.startsWith('Pictures/'))
            .map((entry) => entry.name),
        ),
      ),
    },
    { name: 'content.xml', data: encoder.encode(contentXml) },
    { name: 'styles.xml', data: encoder.encode(stylesXml()) },
    ...extra,
  ]);
}

function manifestXml(mimetype: string, pictures: readonly string[] = []): string {
  return writeXml({
    name: 'manifest:manifest',
    attributes: { 'xmlns:manifest': NS.manifest, 'manifest:version': '1.3' },
    children: [
      {
        name: 'manifest:file-entry',
        attributes: {
          'manifest:full-path': '/',
          'manifest:version': '1.3',
          'manifest:media-type': mimetype,
        },
      },
      {
        name: 'manifest:file-entry',
        attributes: { 'manifest:full-path': 'content.xml', 'manifest:media-type': 'text/xml' },
      },
      {
        name: 'manifest:file-entry',
        attributes: { 'manifest:full-path': 'styles.xml', 'manifest:media-type': 'text/xml' },
      },
      ...pictures.map((name) => {
        const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        return {
          name: 'manifest:file-entry',
          attributes: {
            'manifest:full-path': name,
            'manifest:media-type': 'image/' + (extension === 'jpg' ? 'jpeg' : extension),
          },
        };
      }),
    ],
  });
}

/** The named styles this writer's spans and lists refer to. */
function stylesXml(): string {
  const style = (name: string, properties: Record<string, string>): XmlWriteNode => ({
    name: 'style:style',
    attributes: { 'style:name': name, 'style:family': 'text' },
    children: [{ name: 'style:text-properties', attributes: properties }],
  });

  return writeXml({
    name: 'office:document-styles',
    attributes: {
      'xmlns:office': NS.office,
      'xmlns:table': NS.table,
      'xmlns:draw': NS.draw,
      'xmlns:svg': NS.svg,
      'xmlns:xlink': NS.xlink,
      'xmlns:style': NS.style,
      'xmlns:fo': NS.fo,
      'office:version': '1.3',
    },
    children: [
      {
        name: 'office:styles',
        children: [
          style('Bold', { 'fo:font-weight': 'bold' }),
          style('Italic', { 'fo:font-style': 'italic' }),
          style('Underline', { 'style:text-underline-style': 'solid' }),
          style('Strikethrough', { 'style:text-line-through-style': 'solid' }),
        ],
      },
    ],
  });
}

export function writeOds(workbook: XlsxWorkbook): Uint8Array {
  if (workbook.sheets.length === 0) {
    throw new OdfError('a workbook must have at least one sheet');
  }

  const content = writeXml({
    name: 'office:document-content',
    attributes: {
      'xmlns:office': NS.office,
      'xmlns:table': NS.table,
      'xmlns:text': NS.text,
      'office:version': '1.3',
    },
    children: [
      {
        name: 'office:body',
        children: [
          {
            name: 'office:spreadsheet',
            children: workbook.sheets.map((sheet) => tableXml(sheet)),
          },
        ],
      },
    ],
  });

  return writeOdfArchive(SPREADSHEET_MIME, content);
}

function tableXml(sheet: XlsxSheet): XmlWriteNode {
  const byRow = new Map<number, XlsxCell[]>();
  let lastRow = -1;
  for (const cell of sheet.cells) {
    const list = byRow.get(cell.row);
    if (list === undefined) byRow.set(cell.row, [cell]);
    else list.push(cell);
    if (cell.row > lastRow) lastRow = cell.row;
  }

  const rows: XmlWriteNode[] = [];
  for (let row = 0; row <= lastRow; row += 1) {
    const cells = (byRow.get(row) ?? []).slice().sort((a, b) => a.column - b.column);
    const children: XmlWriteNode[] = [];
    let column = 0;

    for (const cell of cells) {
      // Gaps are written as ONE repeated empty cell rather than as a run of
      // them, which is both what the format expects and what keeps a sparse
      // sheet from producing an enormous file.
      if (cell.column > column) {
        children.push(emptyCells(cell.column - column));
        column = cell.column;
      }
      children.push(cellXml(cell));
      column += 1;
    }

    rows.push({ name: 'table:table-row', children });
  }

  return {
    name: 'table:table',
    attributes: { 'table:name': sheet.name },
    children: rows,
  };
}

function emptyCells(count: number): XmlWriteNode {
  return {
    name: 'table:table-cell',
    attributes: count > 1 ? { 'table:number-columns-repeated': count } : {},
  };
}

function cellXml(cell: XlsxCell): XmlWriteNode {
  const attributes: Record<string, string | number> = {};
  const children: XmlWriteNode[] = [];

  if (cell.formula !== undefined) {
    // Translated, not copied. Storing an A1 formula unchanged produces a file
    // that opens with every formula broken.
    attributes['table:formula'] = a1FormulaToOdf(cell.formula);
  }

  if (typeof cell.value === 'number') {
    attributes['office:value-type'] = 'float';
    attributes['office:value'] = cell.value;
    children.push({ name: 'text:p', children: [String(cell.value)] });
  } else if (typeof cell.value === 'boolean') {
    attributes['office:value-type'] = 'boolean';
    attributes['office:boolean-value'] = cell.value ? 'true' : 'false';
    children.push({ name: 'text:p', children: [cell.value ? 'TRUE' : 'FALSE'] });
  } else if (typeof cell.value === 'string') {
    attributes['office:value-type'] = 'string';
    // Both the attribute and the paragraph. The attribute is authoritative;
    // the paragraph is what a reader without attribute support displays.
    attributes['office:string-value'] = cell.value;
    children.push({ name: 'text:p', children: [cell.value] });
  }

  return { name: 'table:table-cell', attributes, children };
}

export function writeOdt(document: DocxDocument): Uint8Array {
  const body: XmlWriteNode[] = [];
  // Numbered once, so the part name in the archive, the manifest entry and the
  // xlink:href in the body all agree. Numbering them separately is how a
  // document ends up showing the wrong picture, or none.
  const pictures: ZipEntry[] = [];
  let currentList: XmlWriteNode | undefined;
  let currentListKind: DocxBlockKind | undefined;

  for (const block of document.blocks) {
    if (block.kind === 'bullet' || block.kind === 'numbered') {
      // Consecutive list blocks of the same kind belong to ONE list element.
      // Emitting one list per item produces a document where every bullet is
      // its own list, which restarts numbering at each item.
      if (currentList === undefined || currentListKind !== block.kind) {
        currentList = {
          name: 'text:list',
          attributes: {
            'text:style-name': block.kind === 'numbered' ? 'NumberedList' : 'BulletList',
          },
          children: [],
        };
        currentListKind = block.kind;
        body.push(currentList);
      }
      (currentList.children as XmlWriteNode[]).push({
        name: 'text:list-item',
        children: [{ name: 'text:p', children: spansXml(block.runs) }],
      });
      continue;
    }

    currentList = undefined;
    currentListKind = undefined;

    if (block.kind.startsWith('heading')) {
      body.push({
        name: 'text:h',
        attributes: { 'text:outline-level': block.kind.slice(-1) },
        children: spansXml(block.runs),
      });
      continue;
    }

    if (block.kind === 'table' && block.table !== undefined) {
      const table = block.table;
      const columns = Math.max(
        ...table.rows.map((row) => row.cells.length),
        table.gridWidths.length,
        1,
      );

      const rowXml = (row: (typeof table.rows)[number]): XmlWriteNode => ({
        name: 'table:table-row',
        children: Array.from({ length: columns }, (_, index) => {
          const cell = row.cells[index];
          return {
            name: 'table:table-cell',
            attributes: { 'office:value-type': 'string' },
            // A cell always holds at least one paragraph: an empty
            // table:table-cell is legal but renders as a gap, and a reader
            // cannot tell it from a cell that was lost.
            children:
              cell === undefined || cell.blocks.length === 0
                ? [{ name: 'text:p', children: [] }]
                : cell.blocks.map((inner) => ({
                    name: 'text:p',
                    children: spansXml(inner.runs),
                  })),
          };
        }),
      });

      const headers = table.rows.filter((row) => row.header === true);
      const ordinary = table.rows.filter((row) => row.header !== true);

      body.push({
        name: 'table:table',
        attributes: { 'table:name': 'Table' + body.length },
        children: [
          {
            name: 'table:table-column',
            // The repeat attribute rather than one element per column, which
            // is what real producers write and what the reader above expects.
            attributes: { 'table:number-columns-repeated': columns },
          },
          // Header rows go in their own element, or they do not repeat when
          // the table runs onto a second page.
          ...(headers.length > 0
            ? [{ name: 'table:table-header-rows', children: headers.map(rowXml) }]
            : []),
          ...ordinary.map(rowXml),
        ],
      });
      continue;
    }

    if (block.kind === 'image' && block.image !== undefined) {
      const name = 'Pictures/image' + (pictures.length + 1) + '.' + block.image.extension;
      pictures.push({ name, data: block.image.data });

      // Centimetres, converted from EMU. ODF sizes carry their unit in the
      // string, and a bare number is not a size - the frame collapses and the
      // picture renders at nothing.
      const cm = (emu: number): string => (emu / 360000).toFixed(3) + 'cm';

      body.push({
        name: 'text:p',
        children: [
          {
            name: 'draw:frame',
            attributes: {
              'draw:name': 'Image' + pictures.length,
              'text:anchor-type': 'as-char',
              'svg:width': cm(block.image.widthEmu),
              'svg:height': cm(block.image.heightEmu),
            },
            children: [
              {
                name: 'draw:image',
                attributes: {
                  'xlink:href': name,
                  'xlink:type': 'simple',
                  'xlink:show': 'embed',
                  'xlink:actuate': 'onLoad',
                },
              },
              // The description is its own element in ODF, not an attribute.
              // Left out, the picture is invisible to anybody using a screen
              // reader and nothing in the file says so.
              ...(block.image.alt === ''
                ? []
                : [{ name: 'svg:desc', children: [block.image.alt] }]),
            ],
          },
        ],
      });
      continue;
    }

    body.push({ name: 'text:p', children: spansXml(block.runs) });
  }

  const content = writeXml({
    name: 'office:document-content',
    attributes: {
      'xmlns:office': NS.office,
      'xmlns:text': NS.text,
      'xmlns:style': NS.style,
      'office:version': '1.3',
    },
    children: [{ name: 'office:body', children: [{ name: 'office:text', children: body }] }],
  });

  return writeOdfArchive(TEXT_MIME, content, pictures);
}

function spansXml(runs: readonly DocxRun[]): XmlWriteNode[] {
  const children: XmlWriteNode[] = [];

  for (const run of runs) {
    const styles: string[] = [];
    if (run.bold === true) styles.push('Bold');
    if (run.italic === true) styles.push('Italic');
    if (run.underline === true) styles.push('Underline');
    if (run.strikethrough === true) styles.push('Strikethrough');

    // A newline inside a run is a line-break ELEMENT. Left as a raw newline it
    // is legal XML and renders as a space, so the break disappears.
    const pieces = run.text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) children.push({ name: 'text:line-break' });
      if (piece.length === 0) return;
      const node: XmlWriteNode =
        styles.length === 0
          ? { name: 'text:span', children: [piece] }
          : { name: 'text:span', attributes: { 'text:style-name': styles.join('') }, children: [piece] };
      children.push(node);
    });
  }

  return children;
}
