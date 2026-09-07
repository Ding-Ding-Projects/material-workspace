/**
 * Export: every format that can faithfully carry the data.
 *
 * Not one favourite. If a surface can show it, somebody can take it away, and
 * which format suits depends on what they are going to do with it - a
 * spreadsheet wants CSV, a script wants JSON, a note wants Markdown, and a
 * person reading it wants HTML.
 *
 * THE RULE THAT MATTERS: a format that cannot carry something SAYS SO BEFORE
 * the export runs, rather than truncating quietly. An export that silently
 * dropped a column is worse than one that refused, because the file looks
 * complete and the loss is discovered by somebody relying on it later.
 */

export type Format =
  | 'json'
  | 'jsonl'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'csv'
  | 'tsv'
  | 'markdown'
  | 'html'
  | 'sql';

export const FORMATS: readonly Format[] = [
  'json',
  'jsonl',
  'yaml',
  'toml',
  'xml',
  'csv',
  'tsv',
  'markdown',
  'html',
  'sql',
];

/** A value a cell can hold. Deliberately narrow. */
export type Value = string | number | boolean | null;

export interface Table {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, Value>>[];
}

export interface FormatInfo {
  readonly format: Format;
  readonly extension: string;
  readonly mediaType: string;
  /** Whether it keeps the difference between 4 and "4". */
  readonly keepsTypes: boolean;
  /** Whether it can carry more than one table in one file. */
  readonly manyTables: boolean;
  /** Whether it can carry a null distinctly from an empty string. */
  readonly keepsNull: boolean;
}

export const INFO: Record<Format, FormatInfo> = {
  json: { format: 'json', extension: '.json', mediaType: 'application/json', keepsTypes: true, manyTables: true, keepsNull: true },
  jsonl: { format: 'jsonl', extension: '.jsonl', mediaType: 'application/x-ndjson', keepsTypes: true, manyTables: false, keepsNull: true },
  yaml: { format: 'yaml', extension: '.yaml', mediaType: 'application/yaml', keepsTypes: true, manyTables: true, keepsNull: true },
  toml: { format: 'toml', extension: '.toml', mediaType: 'application/toml', keepsTypes: true, manyTables: true, keepsNull: false },
  xml: { format: 'xml', extension: '.xml', mediaType: 'application/xml', keepsTypes: false, manyTables: true, keepsNull: true },
  csv: { format: 'csv', extension: '.csv', mediaType: 'text/csv', keepsTypes: false, manyTables: false, keepsNull: false },
  tsv: { format: 'tsv', extension: '.tsv', mediaType: 'text/tab-separated-values', keepsTypes: false, manyTables: false, keepsNull: false },
  markdown: { format: 'markdown', extension: '.md', mediaType: 'text/markdown', keepsTypes: false, manyTables: true, keepsNull: false },
  html: { format: 'html', extension: '.html', mediaType: 'text/html', keepsTypes: false, manyTables: true, keepsNull: false },
  sql: { format: 'sql', extension: '.sql', mediaType: 'application/sql', keepsTypes: true, manyTables: true, keepsNull: true },
};

export interface Warning {
  readonly what: string;
  readonly why: string;
}

/**
 * What this format would lose, given this data.
 *
 * Computed against the ACTUAL data rather than listed as a general property.
 * "CSV cannot carry types" is true and useless; "these three columns hold
 * numbers and will come back as text" is something somebody can act on.
 */
export function warningsFor(format: Format, tables: readonly Table[]): Warning[] {
  const info = INFO[format];
  const warnings: Warning[] = [];

  if (!info.manyTables && tables.length > 1) {
    warnings.push({
      what: 'Only the first of ' + tables.length + ' tables will be written',
      why: info.extension + ' holds one table per file. Export them separately to keep them all.',
    });
  }

  const scanned = info.manyTables ? tables : tables.slice(0, 1);

  if (!info.keepsTypes) {
    const typed = new Set<string>();
    for (const table of scanned) {
      for (const row of table.rows) {
        for (const column of table.columns) {
          const value = row[column];
          if (typeof value === 'number' || typeof value === 'boolean') typed.add(column);
        }
      }
    }
    if (typed.size > 0) {
      warnings.push({
        what: [...typed].sort().join(', ') + ' will come back as text',
        why: info.extension + ' has no types. 4 and "4" are the same thing in it.',
      });
    }
  }

  if (!info.keepsNull) {
    const nulled = new Set<string>();
    for (const table of scanned) {
      for (const row of table.rows) {
        for (const column of table.columns) {
          if (row[column] === null) nulled.add(column);
        }
      }
    }
    if (nulled.size > 0) {
      warnings.push({
        // The distinction that goes: "we do not know" and "it is empty" are
        // different facts, and a format with one blank cannot keep them apart.
        what: 'Unknown values in ' + [...nulled].sort().join(', ') + ' become empty',
        why:
          info.extension +
          ' cannot tell an unknown value from an empty one, so both arrive as blank.',
      });
    }
  }

  return warnings;
}

// ------------------------------------------------------------------ writing --

function csvCell(value: Value, separator: string): string {
  if (value === null) return '';
  const text = String(value);
  // Quoted when it contains the separator, a quote or a newline - the three
  // things that would otherwise make the row unparseable. Quotes are doubled,
  // which is the escaping every CSV reader expects.
  if (text.includes(separator) || text.includes('"') || /[\r\n]/.test(text)) {
    return '"' + text.replaceAll('"', '""') + '"';
  }
  return text;
}

function delimited(table: Table, separator: string): string {
  const lines = [table.columns.map((column) => csvCell(column, separator)).join(separator)];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => csvCell(row[column] ?? null, separator)).join(separator));
  }
  // A trailing newline, because a file without one makes the last row
  // disappear in several readers that split on it.
  return lines.join('\n') + '\n';
}

function yamlScalar(value: Value): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Always quoted. An unquoted YAML scalar can silently become a boolean
  // ("no" becomes false), a number ("0755" becomes 493), or a date - the
  // classic footgun, and the reason a spreadsheet exported through YAML
  // arrives with a column of nonsense.
  return JSON.stringify(value);
}

function tomlScalar(value: Value): string {
  if (value === null) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function xmlText(value: Value): string {
  if (value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** A name safe to use as an element or an identifier. */
function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : fallback + cleaned;
}

function markdownCell(value: Value): string {
  if (value === null) return '';
  // Pipes escaped, newlines flattened: a raw pipe ends the cell and a raw
  // newline ends the table, so either would corrupt every row after it.
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function sqlLiteral(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  // Single quotes doubled, which is the SQL standard escape. This produces a
  // literal rather than interpolating anything: nothing here is executed, and
  // the output is a file somebody reads before running.
  return "'" + value.replaceAll("'", "''") + "'";
}

export function write(format: Format, tables: readonly Table[]): string {
  const info = INFO[format];
  const scoped = info.manyTables ? tables : tables.slice(0, 1);

  switch (format) {
    case 'json':
      return JSON.stringify(
        scoped.map((table) => ({ name: table.name, columns: table.columns, rows: table.rows })),
        null,
        2,
      ) + '\n';

    case 'jsonl':
      // One row per line, which is what makes it streamable. The table name is
      // not repeated on every line; it belongs in the filename.
      return (
        (scoped[0]?.rows ?? []).map((row) => JSON.stringify(row)).join('\n') +
        ((scoped[0]?.rows.length ?? 0) > 0 ? '\n' : '')
      );

    case 'yaml': {
      const lines: string[] = [];
      for (const table of scoped) {
        lines.push(yamlScalar(table.name).replace(/^"|"$/g, '') + ':');
        if (table.rows.length === 0) lines.push('  []');
        for (const row of table.rows) {
          lines.push('  - ' + table.columns.map((c) => c + ': ' + yamlScalar(row[c] ?? null)).join('\n    '));
        }
      }
      return lines.join('\n') + '\n';
    }

    case 'toml': {
      const lines: string[] = [];
      for (const table of scoped) {
        for (const row of table.rows) {
          // An array of tables, which is TOML's own way of writing a list of
          // records rather than a shape invented here.
          lines.push('[[' + safeName(table.name, 't_') + ']]');
          for (const column of table.columns) {
            lines.push(safeName(column, 'c_') + ' = ' + tomlScalar(row[column] ?? null));
          }
          lines.push('');
        }
      }
      return lines.join('\n');
    }

    case 'xml': {
      const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<export>'];
      for (const table of scoped) {
        lines.push('  <table name="' + xmlText(table.name) + '">');
        for (const row of table.rows) {
          lines.push('    <row>');
          for (const column of table.columns) {
            const element = safeName(column, 'c_');
            const value = row[column] ?? null;
            // A null is an EMPTY ELEMENT WITH A MARKER rather than an absent
            // one, so a reader can tell "unknown" from "not in this row".
            lines.push(
              value === null
                ? '      <' + element + ' null="true"/>'
                : '      <' + element + '>' + xmlText(value) + '</' + element + '>',
            );
          }
          lines.push('    </row>');
        }
        lines.push('  </table>');
      }
      lines.push('</export>');
      return lines.join('\n') + '\n';
    }

    case 'csv':
      return scoped[0] === undefined ? '' : delimited(scoped[0], ',');

    case 'tsv':
      return scoped[0] === undefined ? '' : delimited(scoped[0], '\t');

    case 'markdown': {
      const lines: string[] = [];
      for (const table of scoped) {
        lines.push('## ' + table.name, '');
        lines.push('| ' + table.columns.map(markdownCell).join(' | ') + ' |');
        lines.push('| ' + table.columns.map(() => '---').join(' | ') + ' |');
        for (const row of table.rows) {
          lines.push('| ' + table.columns.map((c) => markdownCell(row[c] ?? null)).join(' | ') + ' |');
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    case 'html': {
      const lines = [
        '<!doctype html>',
        '<meta charset="utf-8">',
        '<title>Export</title>',
      ];
      for (const table of scoped) {
        lines.push('<h2>' + xmlText(table.name) + '</h2>');
        lines.push('<table>');
        lines.push('<thead><tr>' + table.columns.map((c) => '<th>' + xmlText(c) + '</th>').join('') + '</tr></thead>');
        lines.push('<tbody>');
        for (const row of table.rows) {
          lines.push(
            '<tr>' + table.columns.map((c) => '<td>' + xmlText(row[c] ?? null) + '</td>').join('') + '</tr>',
          );
        }
        lines.push('</tbody></table>');
      }
      return lines.join('\n') + '\n';
    }

    case 'sql': {
      const lines: string[] = [];
      for (const table of scoped) {
        const name = safeName(table.name, 't_');
        for (const row of table.rows) {
          lines.push(
            'INSERT INTO ' +
              name +
              ' (' +
              table.columns.map((c) => safeName(c, 'c_')).join(', ') +
              ') VALUES (' +
              table.columns.map((c) => sqlLiteral(row[c] ?? null)).join(', ') +
              ');',
          );
        }
      }
      return lines.join('\n') + (lines.length > 0 ? '\n' : '');
    }
  }
}

/**
 * A filename for an export. A NAME, never a path.
 *
 * The first version replaced every unusual character with a dash and kept
 * dots, so `../../etc/passwd` became `..-..-etc-passwd` - still carrying the
 * parent references, and still dangerous the moment something joined it to a
 * directory. Separators are not the only way out of a folder.
 *
 * So: separators and dots are stripped rather than substituted, a leading dot
 * is refused because it names a hidden file on every platform that has them,
 * and the length is bounded because several filesystems refuse a component
 * over 255 bytes and the refusal arrives as an unhelpful write error.
 */
export function filenameFor(base: string, format: Format): string {
  const cleaned = base
    // ONE rule does the work: anything outside this set becomes a dash. That
    // covers separators, dots, colons and everything else in one place.
    //
    // An earlier version stripped separators and dots in two extra passes
    // first. Removing them changed nothing - proved by deleting them and
    // watching every test stay green - because this line already catches
    // both. Two rules doing one job is one rule that eventually stops
    // matching the other.
    .replace(/[^A-Za-z0-9_-]/g, '-')
    // Runs collapse, so a mangled name is readable rather than a row of
    // hyphens.
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    // Bounded: several filesystems refuse a component over 255 bytes, and the
    // refusal arrives as an unhelpful write error rather than as anything
    // about the name.
    .slice(0, 120);

  return (cleaned === '' ? 'export' : cleaned) + INFO[format].extension;
}
