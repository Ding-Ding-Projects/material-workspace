/**
 * A small relational store.
 *
 * Typed columns, declared constraints, and a query language that is checked
 * before it runs. The decisions that shape it:
 *
 *   - CONSTRAINTS ARE ENFORCED ON WRITE, not checked afterwards. A store that
 *     accepts a row and reports the problem later has already lost the
 *     guarantee that made the constraint worth declaring — every reader from
 *     that moment on has to handle data the schema says cannot exist.
 *   - NULL IS ITS OWN VALUE, distinct from an empty string and from zero. That
 *     distinction is the whole reason a database is not a spreadsheet: "we do
 *     not know this person's age" and "this person is zero years old" are
 *     different facts, and collapsing them silently loses the first.
 *   - A QUERY IS A STRUCTURE, never a string spliced together. There is no
 *     point at which user input becomes part of a query expression, so there
 *     is no injection surface to defend.
 */

export type ColumnType = 'text' | 'number' | 'boolean' | 'date';

export interface Column {
  readonly name: string;
  readonly type: ColumnType;
  /** A required column refuses null. */
  readonly required?: boolean;
  readonly unique?: boolean;
  /** Applied when a row omits the column entirely. */
  readonly defaultValue?: CellValue;
  /** Names the table this column points at, for a foreign key. */
  readonly references?: string;
}

export interface Table {
  readonly name: string;
  readonly columns: readonly Column[];
  /** The column that identifies a row. Always present, always unique. */
  readonly primaryKey: string;
  readonly rows: readonly Row[];
}

export type CellValue = string | number | boolean | null;
export type Row = Readonly<Record<string, CellValue>>;

export interface Database {
  readonly schema: 'material-workspace/data@1';
  readonly tables: readonly Table[];
}

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export function emptyDatabase(): Database {
  return { schema: 'material-workspace/data@1', tables: [] };
}

// ------------------------------------------------------------- validation --

/**
 * Coerce a value into a column's type, or explain why it cannot be.
 *
 * A TAGGED result, not a union of CellValue and string.
 *
 * The first version returned the coerced value or an error MESSAGE, both as
 * plain values. For a text column a valid result is also a string, so the two
 * were indistinguishable, and a required text column left empty stored the
 * literal words "name is required" AS ITS VALUE. Nothing threw, nothing
 * warned, and the row looked filled in.
 *
 * Reports rather than throwing, because this runs once per
 * cell while somebody is typing and the caller wants to show the reason next
 * to the field rather than catch an exception.
 */
export type Coerced =
  | { readonly ok: true; readonly value: CellValue }
  | { readonly ok: false; readonly message: string };

export function coerce(column: Column, value: CellValue): Coerced {
  if (value === null || value === '') {
    // An empty string in a text column is a real empty string; in every other
    // column it is the absence of a value.
    if (column.type === 'text' && value === '') {
      return column.required === true
        ? { ok: false, message: column.name + ' is required' }
        : { ok: true, value: '' };
    }
    if (column.required === true) {
      return { ok: false, message: column.name + ' is required' };
    }
    return { ok: true, value: null };
  }

  switch (column.type) {
    case 'text':
      return { ok: true, value: typeof value === 'string' ? value : String(value) };
    case 'number': {
      const asNumber = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(asNumber)) {
        return {
          ok: false,
          message:
            column.name + ' must be a number, and ' + JSON.stringify(value) + ' is not',
        };
      }
      return { ok: true, value: asNumber };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', '1'].includes(text)) return { ok: true, value: true };
      if (['false', 'no', '0'].includes(text)) return { ok: true, value: false };
      return { ok: false, message: column.name + ' must be true or false' };
    }
    case 'date': {
      // Stored as an ISO date string rather than a timestamp. A date with no
      // time is not an instant, and turning it into one attaches a timezone
      // that was never in the data — which is how a birthday moves by a day.
      const text = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { ok: false, message: column.name + ' must be a date like 2026-03-15' };
      }
      const parsed = new Date(text + 'T00:00:00Z');
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, message: column.name + ' is not a real date' };
      }
      // Round-tripped, so 2026-02-30 is refused rather than silently becoming
      // the second of March.
      if (parsed.toISOString().slice(0, 10) !== text) {
        return { ok: false, message: column.name + ': there is no such date as ' + text };
      }
      return { ok: true, value: text };
    }
    default:
      return { ok: true, value };
  }
}

export interface ValidationProblem {
  readonly column: string;
  readonly message: string;
}

/**
 * Check a row against a table, returning the coerced row or the problems.
 *
 * Every problem is collected rather than only the first, so somebody fixing a
 * form is told everything that is wrong at once instead of one thing per
 * attempt.
 */
export function validateRow(
  table: Table,
  row: Row,
  options: { readonly ignoreRowId?: CellValue } = {},
): { readonly row: Row } | { readonly problems: readonly ValidationProblem[] } {
  const problems: ValidationProblem[] = [];
  const result: Record<string, CellValue> = {};

  for (const column of table.columns) {
    const raw = column.name in row ? row[column.name] : (column.defaultValue ?? null);
    const coerced = coerce(column, raw ?? null);

    // ONE branch, because the result is tagged. The version that returned a
    // bare value or a bare message needed a special case for text columns, and
    // got it wrong: the error message was stored as the value.
    if (!coerced.ok) {
      problems.push({ column: column.name, message: coerced.message });
      continue;
    }

    result[column.name] = coerced.value;
  }

  // Uniqueness, including the primary key.
  for (const column of table.columns) {
    if (column.unique !== true && column.name !== table.primaryKey) continue;
    const value = result[column.name];
    if (value === null || value === undefined) continue;

    const clash = table.rows.some(
      (existing) =>
        existing[column.name] === value &&
        (options.ignoreRowId === undefined || existing[table.primaryKey] !== options.ignoreRowId),
    );
    if (clash) {
      problems.push({
        column: column.name,
        message: column.name + ' must be unique, and ' + JSON.stringify(value) + ' is already used',
      });
    }
  }

  return problems.length > 0 ? { problems } : { row: result };
}

/**
 * Referential integrity, checked against the whole database.
 *
 * Separate from row validation because a foreign key needs the other table,
 * and a validator that silently skips the check when it cannot see one is a
 * validator that passes on exactly the data it was written to refuse.
 */
export function checkReferences(
  database: Database,
  table: Table,
  row: Row,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  for (const column of table.columns) {
    if (column.references === undefined) continue;
    const value = row[column.name];
    if (value === null || value === undefined) continue;

    const target = database.tables.find((candidate) => candidate.name === column.references);
    if (target === undefined) {
      problems.push({
        column: column.name,
        message: column.name + ' points at the table ' + column.references + ', which does not exist',
      });
      continue;
    }

    const found = target.rows.some((candidate) => candidate[target.primaryKey] === value);
    if (!found) {
      problems.push({
        column: column.name,
        message:
          'No row in ' + target.name + ' has ' + target.primaryKey + ' ' + JSON.stringify(value),
      });
    }
  }

  return problems;
}

/** Rows in other tables that point at this one. Deleting it would orphan them. */
export function dependents(database: Database, table: Table, row: Row): number {
  const key = row[table.primaryKey];
  if (key === null || key === undefined) return 0;

  let count = 0;
  for (const other of database.tables) {
    for (const column of other.columns) {
      if (column.references !== table.name) continue;
      count += other.rows.filter((candidate) => candidate[column.name] === key).length;
    }
  }
  return count;
}

// ---------------------------------------------------------------- queries --

export type Comparison =
  | 'equals'
  | 'notEquals'
  | 'lessThan'
  | 'greaterThan'
  | 'atMost'
  | 'atLeast'
  | 'contains'
  | 'startsWith'
  | 'isEmpty'
  | 'isNotEmpty';

export interface Condition {
  readonly column: string;
  readonly comparison: Comparison;
  readonly value?: CellValue;
}

export interface Query {
  readonly table: string;
  /** All conditions must hold. An empty list matches every row. */
  readonly where: readonly Condition[];
  readonly sortBy?: { readonly column: string; readonly descending?: boolean };
  readonly limit?: number;
}

/**
 * A query is a STRUCTURE, never a string.
 *
 * There is no point at which a value the user typed becomes part of an
 * expression, so there is no injection surface to defend — the value only ever
 * arrives as data, compared by this function.
 */
export function runQuery(database: Database, query: Query): Row[] {
  const table = database.tables.find((candidate) => candidate.name === query.table);
  if (table === undefined) throw new DataError('no table named ' + query.table);

  for (const condition of query.where) {
    if (!table.columns.some((column) => column.name === condition.column)) {
      // Checked before running, so a typo in a column name is an error rather
      // than a query that silently matches nothing.
      throw new DataError(
        'the table ' + table.name + ' has no column named ' + condition.column,
      );
    }
  }

  let rows = table.rows.filter((row) =>
    query.where.every((condition) => matches(row, condition)),
  );

  if (query.sortBy !== undefined) {
    const { column, descending } = query.sortBy;
    if (!table.columns.some((candidate) => candidate.name === column)) {
      throw new DataError('cannot sort by ' + column + ': there is no such column');
    }
    rows = [...rows].sort((a, b) => compareCells(a[column] ?? null, b[column] ?? null));
    if (descending === true) rows.reverse();
  }

  if (query.limit !== undefined && query.limit >= 0) rows = rows.slice(0, query.limit);
  return rows;
}

function matches(row: Row, condition: Condition): boolean {
  const value = row[condition.column] ?? null;
  const target = condition.value ?? null;

  switch (condition.comparison) {
    case 'isEmpty':
      return value === null || value === '';
    case 'isNotEmpty':
      return value !== null && value !== '';
    case 'equals':
      return value === target;
    case 'notEquals':
      return value !== target;
    case 'contains':
      return value !== null && String(value).toLowerCase().includes(String(target).toLowerCase());
    case 'startsWith':
      return value !== null && String(value).toLowerCase().startsWith(String(target).toLowerCase());
    default: {
      // A null never satisfies an ordered comparison. It is not less than,
      // greater than, or equal to anything — treating it as zero is how a row
      // with a missing value silently joins a "less than ten" result.
      if (value === null || target === null) return false;
      const order = compareCells(value, target);
      switch (condition.comparison) {
        case 'lessThan':
          return order < 0;
        case 'greaterThan':
          return order > 0;
        case 'atMost':
          return order <= 0;
        case 'atLeast':
          return order >= 0;
        default:
          return false;
      }
    }
  }
}

/**
 * Order two cells.
 *
 * Nulls sort LAST regardless of direction, because "unknown" belongs at the
 * end of a list whether it is sorted up or down — a column sorted descending
 * that begins with a screen of blanks is a column nobody can read.
 */
export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

// ------------------------------------------------------------- aggregation --

export type Aggregate = 'count' | 'sum' | 'average' | 'min' | 'max';

/**
 * An aggregate over a column.
 *
 * `count` counts ROWS; every other aggregate skips nulls, which is the same
 * distinction a spreadsheet makes and for the same reason: an average that
 * counts unknown values as zero is a wrong number that looks right.
 */
export function aggregate(rows: readonly Row[], column: string, kind: Aggregate): number | null {
  if (kind === 'count') return rows.length;

  const numbers: number[] = [];
  for (const row of rows) {
    const value = row[column];
    if (typeof value === 'number') numbers.push(value);
  }
  if (numbers.length === 0) return null;

  switch (kind) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0);
    case 'average':
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
    default:
      return null;
  }
}

// --------------------------------------------------------------- mutation --

export function insertRow(
  database: Database,
  tableName: string,
  row: Row,
): { readonly database: Database } | { readonly problems: readonly ValidationProblem[] } {
  const table = database.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) throw new DataError('no table named ' + tableName);

  const validated = validateRow(table, row);
  if ('problems' in validated) return validated;

  const referenceProblems = checkReferences(database, table, validated.row);
  if (referenceProblems.length > 0) return { problems: referenceProblems };

  return {
    database: {
      ...database,
      tables: database.tables.map((candidate) =>
        candidate.name === tableName
          ? { ...candidate, rows: [...candidate.rows, validated.row] }
          : candidate,
      ),
    },
  };
}

export function deleteRow(
  database: Database,
  tableName: string,
  key: CellValue,
): { readonly database: Database } | { readonly problems: readonly ValidationProblem[] } {
  const table = database.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) throw new DataError('no table named ' + tableName);

  const row = table.rows.find((candidate) => candidate[table.primaryKey] === key);
  if (row === undefined) return { database };

  // Refused rather than cascading. A delete that quietly removes rows in other
  // tables is the single most destructive default a database can have, and it
  // is not recoverable from the interface.
  const orphans = dependents(database, table, row);
  if (orphans > 0) {
    return {
      problems: [
        {
          column: table.primaryKey,
          message:
            'Cannot delete: ' +
            orphans +
            (orphans === 1 ? ' row in another table points' : ' rows in other tables point') +
            ' at this one.',
        },
      ],
    };
  }

  return {
    database: {
      ...database,
      tables: database.tables.map((candidate) =>
        candidate.name === tableName
          ? { ...candidate, rows: candidate.rows.filter((r) => r !== row) }
          : candidate,
      ),
    },
  };
}
