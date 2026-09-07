/**
 * A table, written out in every format that can faithfully carry it.
 *
 * The contract this project works to says export must offer every format that
 * can represent the data, and must say what a format would DROP before it
 * runs rather than truncating quietly. So each format here declares its own
 * losses, and the caller shows them.
 *
 * The losses are real, not theoretical:
 *   - CSV and TSV carry text only. Formulas, types, formatting and errors all
 *     become their displayed text, so a sheet exported and reimported is a
 *     sheet of literals.
 *   - Markdown additionally cannot carry a newline inside a cell, and its
 *     pipes must be escaped or the table silently gains columns.
 *   - JSON is the only one here that carries types and formulas, so it is the
 *     only one that round-trips.
 */

import { type Delimiter, writeCsv } from './csv';

export type TableFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'html';

export interface TableCell {
  /** What the cell shows. */
  readonly text: string;
  /** The underlying value, when it is not simply the text. */
  readonly value?: string | number | boolean | null;
  /** The formula, including its leading equals sign, when there is one. */
  readonly formula?: string;
}

export interface TableExportOptions {
  readonly format: TableFormat;
  /** Used by the formats that can name a sheet. */
  readonly name?: string;
}

export interface FormatDescription {
  readonly id: TableFormat;
  readonly label: string;
  readonly extension: string;
  readonly mediaType: string;
  /**
   * What this format cannot carry. Empty means nothing is lost.
   *
   * Shown to the user BEFORE the export runs. An export that quietly drops
   * formulas is an export somebody discovers has dropped them a week later.
   */
  readonly losses: readonly string[];
}

export const FORMATS: readonly FormatDescription[] = [
  {
    id: 'csv',
    label: 'Comma-separated values',
    extension: '.csv',
    mediaType: 'text/csv',
    losses: ['formulas become their computed text', 'number and date types', 'formatting'],
  },
  {
    id: 'tsv',
    label: 'Tab-separated values',
    extension: '.tsv',
    mediaType: 'text/tab-separated-values',
    losses: ['formulas become their computed text', 'number and date types', 'formatting'],
  },
  {
    id: 'json',
    label: 'JSON',
    extension: '.json',
    mediaType: 'application/json',
    losses: [],
  },
  {
    id: 'markdown',
    label: 'Markdown table',
    extension: '.md',
    mediaType: 'text/markdown',
    losses: [
      'formulas become their computed text',
      'number and date types',
      'formatting',
      'a newline inside a cell becomes a space',
    ],
  },
  {
    id: 'html',
    label: 'HTML table',
    extension: '.html',
    mediaType: 'text/html',
    losses: ['formulas become their computed text', 'formatting'],
  },
];

export function describeFormat(format: TableFormat): FormatDescription {
  const found = FORMATS.find((entry) => entry.id === format);
  if (found === undefined) throw new RangeError('unknown format: ' + format);
  return found;
}

export function exportTable(
  rows: readonly (readonly TableCell[])[],
  options: TableExportOptions,
): string {
  switch (options.format) {
    case 'csv':
      return writeCsv(textRows(rows), { delimiter: ',' as Delimiter });
    case 'tsv':
      return writeCsv(textRows(rows), { delimiter: '\t' as Delimiter });
    case 'json':
      return exportJson(rows, options.name);
    case 'markdown':
      return exportMarkdown(rows);
    case 'html':
      return exportHtml(rows, options.name);
    default:
      throw new RangeError('unknown format: ' + String(options.format));
  }
}

function textRows(rows: readonly (readonly TableCell[])[]): string[][] {
  return rows.map((row) => row.map((cell) => cell.text));
}

/**
 * The only lossless format here.
 *
 * It carries the formula AND the computed value, so a reader can show the
 * cached result without evaluating and a writer can restore the sheet exactly.
 */
function exportJson(rows: readonly (readonly TableCell[])[], name?: string): string {
  return JSON.stringify(
    {
      format: 'material-workspace-table',
      version: 1,
      name: name ?? 'Sheet1',
      rows: rows.map((row) =>
        row.map((cell) => {
          const entry: Record<string, unknown> = { text: cell.text };
          if (cell.formula !== undefined) entry['formula'] = cell.formula;
          if (cell.value !== undefined) entry['value'] = cell.value;
          return entry;
        }),
      ),
    },
    null,
    2,
  );
}

/**
 * Markdown, with the two escapes that matter.
 *
 * An unescaped pipe silently splits a cell into two columns and shifts the
 * rest of the row — the table still renders, so nobody notices until the
 * numbers are in the wrong columns. A newline inside a cell ends the row
 * entirely, so it becomes a space and that loss is declared above.
 */
function exportMarkdown(rows: readonly (readonly TableCell[])[]): string {
  if (rows.length === 0) return '';

  const escape = (value: string): string =>
    value.split('\\').join('\\\\').split('|').join('\\|').replace(/[\r\n]+/g, ' ');

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: readonly TableCell[]): string[] => {
    const cells = row.map((cell) => escape(cell.text));
    while (cells.length < width) cells.push('');
    return cells;
  };

  const [header, ...body] = rows;
  const lines = [
    '| ' + pad(header as readonly TableCell[]).join(' | ') + ' |',
    '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |',
    ...body.map((row) => '| ' + pad(row).join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

/**
 * HTML, escaped.
 *
 * Every one of the five characters is escaped rather than the usual three.
 * Quotes matter because a cell value can end up inside an attribute in
 * whatever consumes this, and an unescaped quote there is an injection.
 */
function exportHtml(rows: readonly (readonly TableCell[])[], name?: string): string {
  const escape = (value: string): string =>
    value
      .split('&')
      .join('&amp;')
      .split('<')
      .join('&lt;')
      .split('>')
      .join('&gt;')
      .split(String.fromCharCode(34))
      .join('&quot;')
      .split(String.fromCharCode(39))
      .join('&#39;');

  const [header, ...body] = rows;
  const parts = ['<table>'];
  if (name !== undefined) parts.push('  <caption>' + escape(name) + '</caption>');
  if (header !== undefined) {
    parts.push('  <thead>');
    parts.push('    <tr>' + header.map((c) => '<th>' + escape(c.text) + '</th>').join('') + '</tr>');
    parts.push('  </thead>');
  }
  parts.push('  <tbody>');
  for (const row of body) {
    parts.push('    <tr>' + row.map((c) => '<td>' + escape(c.text) + '</td>').join('') + '</tr>');
  }
  parts.push('  </tbody>');
  parts.push('</table>');
  return parts.join('\n');
}
