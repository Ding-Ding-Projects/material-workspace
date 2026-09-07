/**
 * `.xlsx`, read and written.
 *
 * The format is a ZIP of XML with several parts that reference each other, and
 * the details below are the ones that make a reader either work on real files
 * or fail on them:
 *
 *   - MOST TEXT IS NOT IN THE WORKSHEET. Strings live in a shared table and
 *     the cell holds an INDEX into it, marked `t="s"`. A reader that takes the
 *     cell's own value for a string cell gets the number 0, 1, 2 — which look
 *     entirely plausible in a spreadsheet and are completely wrong.
 *   - A CELL MAY OMIT ITS REFERENCE. `r="B3"` is optional; when absent, the
 *     cell is the next column along the row. Ignoring that shifts everything
 *     after the first omission.
 *   - A FORMULA CELL CARRIES BOTH. The formula in `<f>` and its last computed
 *     value in `<v>`. Reading only the formula means an unopened file shows
 *     nothing until recalculated; reading only the value silently discards
 *     every formula in the workbook.
 *   - DATES ARE NUMBERS WITH A FORMAT. There is no date type. A date is a
 *     number whose style points at a date format, so a reader without style
 *     handling shows 45000 where a date belongs.
 *   - THE 1900 LEAP-YEAR BUG IS PART OF THE FORMAT. Day 60 is 29 February
 *     1900, which did not exist. Correcting it silently shifts every date
 *     before March 1900 by one day.
 *
 * Written files are stored rather than deflated, which the ZIP layer explains.
 * They open in Excel, LibreOffice and Numbers; they are simply larger.
 */

import { type XmlWriteNode, childElements, parseXml, textOf, writeXml } from './xml';
import { type ZipEntry, readZip, writeZip } from './zip';
import { columnIndex, columnName } from '../sheet/reference';

export interface XlsxCell {
  readonly column: number;
  readonly row: number;
  /** The formula WITHOUT its leading equals sign, as the format stores it. */
  readonly formula?: string;
  readonly value?: string | number | boolean;
  /** True when the value came from the shared-string table. */
  readonly isText?: boolean;
}

export interface XlsxSheet {
  readonly name: string;
  readonly cells: readonly XlsxCell[];
}

export interface XlsxWorkbook {
  readonly sheets: readonly XlsxSheet[];
}

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ------------------------------------------------------------------ reading --

export async function readXlsx(bytes: Uint8Array): Promise<XlsxWorkbook> {
  const parts = await readZip(bytes);

  const workbookPart = parts.get('xl/workbook.xml');
  if (workbookPart === undefined) {
    throw new XlsxError('xl/workbook.xml is missing; this is not an xlsx file');
  }

  const sharedStrings = readSharedStrings(parts.get('xl/sharedStrings.xml'));
  const relationships = readRelationships(parts.get('xl/_rels/workbook.xml.rels'));

  const workbookXml = parseXml(decoder.decode(workbookPart));
  const sheetsElement = childElements(workbookXml, 'sheets')[0];
  if (sheetsElement === undefined) throw new XlsxError('the workbook declares no sheets');

  const sheets: XlsxSheet[] = [];
  let positional = 0;

  for (const sheetElement of childElements(sheetsElement, 'sheet')) {
    const name = sheetElement.attributes.get('name') ?? 'Sheet' + (sheets.length + 1);
    const relationshipId = sheetElement.attributes.get('r:id');

    // Resolve through the relationship when there is one, and fall back to
    // positional order when there is not. Some writers omit the relationship
    // id, and refusing those files would be refusing real spreadsheets.
    positional += 1;
    const target =
      (relationshipId !== undefined ? relationships.get(relationshipId) : undefined) ??
      'worksheets/sheet' + positional + '.xml';

    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const sheetPart = parts.get(path) ?? parts.get(path.replace('xl/', ''));
    if (sheetPart === undefined) {
      throw new XlsxError('worksheet part not found: ' + path);
    }

    sheets.push({ name, cells: readWorksheet(decoder.decode(sheetPart), sharedStrings) });
  }

  return { sheets };
}

function readRelationships(part: Uint8Array | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (part === undefined) return map;
  const root = parseXml(decoder.decode(part));
  for (const relationship of childElements(root, 'Relationship')) {
    const id = relationship.attributes.get('Id');
    const target = relationship.attributes.get('Target');
    if (id !== undefined && target !== undefined) map.set(id, target);
  }
  return map;
}

/**
 * The shared-string table.
 *
 * An entry may be a plain `<t>`, or a run-formatted string split across
 * several `<r><t>` pieces. Reading only the first `<t>` truncates every
 * formatted string to its first run, which is a silent data loss that looks
 * like the user typed less than they did.
 */
function readSharedStrings(part: Uint8Array | undefined): string[] {
  if (part === undefined) return [];
  const root = parseXml(decoder.decode(part));
  return childElements(root, 'si').map((si) => textOf(si));
}

function readWorksheet(xml: string, sharedStrings: readonly string[]): XlsxCell[] {
  const root = parseXml(xml);
  const sheetData = childElements(root, 'sheetData')[0];
  if (sheetData === undefined) return [];

  const cells: XlsxCell[] = [];
  let rowFallback = 0;

  for (const rowElement of childElements(sheetData, 'row')) {
    const declaredRow = rowElement.attributes.get('r');
    rowFallback = declaredRow !== undefined ? Number(declaredRow) : rowFallback + 1;
    const row = rowFallback - 1;
    let columnFallback = -1;

    for (const cellElement of childElements(rowElement, 'c')) {
      const reference = cellElement.attributes.get('r');
      let column: number;
      if (reference !== undefined) {
        const letters = /^([A-Za-z]+)/.exec(reference)?.[1];
        column = letters === undefined ? columnFallback + 1 : columnIndex(letters);
        if (column < 0) column = columnFallback + 1;
      } else {
        // The omitted-reference case. Without this every cell after the first
        // omission lands one column too far left.
        column = columnFallback + 1;
      }
      columnFallback = column;

      const type = cellElement.attributes.get('t') ?? 'n';
      const formulaElement = childElements(cellElement, 'f')[0];
      const valueElement = childElements(cellElement, 'v')[0];
      const inlineElement = childElements(cellElement, 'is')[0];

      const formula = formulaElement === undefined ? undefined : textOf(formulaElement);
      const rawValue = valueElement === undefined ? undefined : textOf(valueElement);

      let value: string | number | boolean | undefined;
      let isText = false;

      if (type === 's' && rawValue !== undefined) {
        // The shared-string indirection. Taking rawValue here would give the
        // index, which reads as a perfectly plausible number.
        const index = Number(rawValue);
        value = sharedStrings[index] ?? '';
        isText = true;
      } else if (type === 'inlineStr' && inlineElement !== undefined) {
        value = textOf(inlineElement);
        isText = true;
      } else if (type === 'str' && rawValue !== undefined) {
        value = rawValue;
        isText = true;
      } else if (type === 'b' && rawValue !== undefined) {
        value = rawValue === '1';
      } else if (type === 'e' && rawValue !== undefined) {
        value = rawValue;
        isText = true;
      } else if (rawValue !== undefined) {
        const asNumber = Number(rawValue);
        value = Number.isFinite(asNumber) ? asNumber : rawValue;
      }

      if (formula === undefined && value === undefined) continue;

      cells.push({
        column,
        row,
        ...(formula !== undefined ? { formula } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(isText ? { isText: true } : {}),
      });
    }
  }

  return cells;
}

// ------------------------------------------------------------------ writing --

export function writeXlsx(workbook: XlsxWorkbook): Uint8Array {
  if (workbook.sheets.length === 0) {
    throw new XlsxError('a workbook must have at least one sheet');
  }

  // Build the shared-string table first. Deduplicated, because a column of
  // repeated categories is the normal case and writing each occurrence
  // separately makes the file several times larger for no benefit.
  const stringIndex = new Map<string, number>();
  const strings: string[] = [];
  for (const sheet of workbook.sheets) {
    for (const cell of sheet.cells) {
      if (cell.isText === true && typeof cell.value === 'string') {
        if (!stringIndex.has(cell.value)) {
          stringIndex.set(cell.value, strings.length);
          strings.push(cell.value);
        }
      }
    }
  }

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes(workbook.sheets.length)) },
    { name: '_rels/.rels', data: encoder.encode(rootRelationships()) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbookXml(workbook.sheets)) },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(workbookRelationships(workbook.sheets.length)),
    },
    { name: 'xl/sharedStrings.xml', data: encoder.encode(sharedStringsXml(strings)) },
  ];

  workbook.sheets.forEach((sheet, index) => {
    entries.push({
      name: 'xl/worksheets/sheet' + (index + 1) + '.xml',
      data: encoder.encode(worksheetXml(sheet, stringIndex)),
    });
  });

  return writeZip(entries);
}

function contentTypes(sheetCount: number): string {
  const children: XmlWriteNode[] = [
    {
      name: 'Default',
      attributes: { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' },
    },
    { name: 'Default', attributes: { Extension: 'xml', ContentType: 'application/xml' } },
    {
      name: 'Override',
      attributes: {
        PartName: '/xl/workbook.xml',
        ContentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      },
    },
    {
      name: 'Override',
      attributes: {
        PartName: '/xl/sharedStrings.xml',
        ContentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
      },
    },
  ];

  for (let index = 1; index <= sheetCount; index += 1) {
    children.push({
      name: 'Override',
      attributes: {
        PartName: '/xl/worksheets/sheet' + index + '.xml',
        ContentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
      },
    });
  }

  return writeXml({
    name: 'Types',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types' },
    children,
  });
}

function rootRelationships(): string {
  return writeXml({
    name: 'Relationships',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
    children: [
      {
        name: 'Relationship',
        attributes: {
          Id: 'rId1',
          Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
          Target: 'xl/workbook.xml',
        },
      },
    ],
  });
}

function workbookXml(sheets: readonly XlsxSheet[]): string {
  return writeXml({
    name: 'workbook',
    attributes: {
      xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    },
    children: [
      {
        name: 'sheets',
        children: sheets.map((sheet, index) => ({
          name: 'sheet',
          attributes: {
            name: sheet.name,
            sheetId: index + 1,
            'r:id': 'rId' + (index + 1),
          },
        })),
      },
    ],
  });
}

function workbookRelationships(sheetCount: number): string {
  const children: XmlWriteNode[] = [];
  for (let index = 1; index <= sheetCount; index += 1) {
    children.push({
      name: 'Relationship',
      attributes: {
        Id: 'rId' + index,
        Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
        Target: 'worksheets/sheet' + index + '.xml',
      },
    });
  }
  children.push({
    name: 'Relationship',
    attributes: {
      Id: 'rId' + (sheetCount + 1),
      Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
      Target: 'sharedStrings.xml',
    },
  });
  return writeXml({
    name: 'Relationships',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
    children,
  });
}

function sharedStringsXml(strings: readonly string[]): string {
  return writeXml({
    name: 'sst',
    attributes: {
      xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      count: strings.length,
      uniqueCount: strings.length,
    },
    children: strings.map((value) => ({
      name: 'si',
      // xml:space is required, or a leading or trailing space in a cell is
      // silently trimmed by the reading application.
      children: [{ name: 't', attributes: { 'xml:space': 'preserve' }, children: [value] }],
    })),
  });
}

function worksheetXml(sheet: XlsxSheet, stringIndex: ReadonlyMap<string, number>): string {
  // Group by row, because the format nests cells inside rows and an
  // out-of-order row makes some readers reject the file.
  const byRow = new Map<number, XlsxCell[]>();
  for (const cell of sheet.cells) {
    const list = byRow.get(cell.row);
    if (list === undefined) byRow.set(cell.row, [cell]);
    else list.push(cell);
  }

  const rows: XmlWriteNode[] = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([row, cells]) => ({
      name: 'row',
      attributes: { r: row + 1 },
      children: cells
        .slice()
        .sort((a, b) => a.column - b.column)
        .map((cell) => cellXml(cell, stringIndex)),
    }));

  return writeXml({
    name: 'worksheet',
    attributes: { xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' },
    children: [{ name: 'sheetData', children: rows }],
  });
}

function cellXml(cell: XlsxCell, stringIndex: ReadonlyMap<string, number>): XmlWriteNode {
  const reference = columnName(cell.column) + (cell.row + 1);
  const children: XmlWriteNode[] = [];
  let type: string | undefined;

  if (cell.formula !== undefined) {
    children.push({ name: 'f', children: [cell.formula] });
  }

  if (cell.isText === true && typeof cell.value === 'string') {
    const index = stringIndex.get(cell.value);
    if (index === undefined) {
      // Should not happen, and if it does, an inline string is correct rather
      // than writing an index into a table that does not contain the value.
      type = 'inlineStr';
      children.push({ name: 'is', children: [{ name: 't', children: [cell.value] }] });
    } else {
      type = 's';
      children.push({ name: 'v', children: [String(index)] });
    }
  } else if (typeof cell.value === 'boolean') {
    type = 'b';
    children.push({ name: 'v', children: [cell.value ? '1' : '0'] });
  } else if (typeof cell.value === 'number') {
    children.push({ name: 'v', children: [String(cell.value)] });
  } else if (typeof cell.value === 'string') {
    type = 'str';
    children.push({ name: 'v', children: [cell.value] });
  }

  return {
    name: 'c',
    attributes: { r: reference, ...(type !== undefined ? { t: type } : {}) },
    children,
  };
}

// ------------------------------------------------------------------- dates --

/**
 * The serial-number epoch, and the leap-year bug that is part of the format.
 *
 * 1900 was not a leap year, but the format says day 60 is 29 February 1900.
 * Correcting it shifts every date before March 1900 by a day relative to every
 * other application, so the bug is REPRODUCED deliberately.
 */
export function serialToDate(serial: number): Date {
  const adjusted = serial < 61 ? serial : serial - 1;
  const epoch = Date.UTC(1899, 11, 31);
  return new Date(epoch + Math.round(adjusted * 86400000));
}

export function dateToSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 31);
  const days = (date.getTime() - epoch) / 86400000;
  return days >= 60 ? days + 1 : days;
}
