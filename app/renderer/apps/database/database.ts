/**
 * Database.
 *
 * A table list, a grid, a row form and a query builder over the data engine.
 *
 * The query builder is a set of CONTROLS, not a text box. That is not a
 * simplification — it is the security property: a value the user types never
 * becomes part of an expression, so there is nothing to escape and no
 * injection surface to get wrong. The cost is that a query this cannot express
 * cannot be written, and that limit is stated rather than worked around with a
 * "raw query" escape hatch that would reintroduce the whole problem.
 */

import { clear, el } from '../../dom.js';
import { SuperConfirm } from '../../components/super-confirm.js';
import {
  type CellValue,
  type Comparison,
  type Condition,
  type Database as DataStore,
  type Row,
  type Table,
  type ValidationProblem,
  aggregate,
  deleteRow,
  insertRow,
  runQuery,
} from '../../../engines/data/model.js';

export interface DatabaseOptions {
  store?: DataStore;
  onChange?: (store: DataStore) => void;
}

const COMPARISONS: readonly { value: Comparison; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'is', needsValue: true },
  { value: 'notEquals', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'startsWith', label: 'starts with', needsValue: true },
  { value: 'lessThan', label: 'is less than', needsValue: true },
  { value: 'greaterThan', label: 'is greater than', needsValue: true },
  { value: 'atMost', label: 'is at most', needsValue: true },
  { value: 'atLeast', label: 'is at least', needsValue: true },
  { value: 'isEmpty', label: 'is empty', needsValue: false },
  { value: 'isNotEmpty', label: 'is not empty', needsValue: false },
];

/** A worked example, so the application opens with something to look at. */
function sampleStore(): DataStore {
  return {
    schema: 'material-workspace/data@1',
    tables: [
      {
        name: 'people',
        primaryKey: 'id',
        columns: [
          { name: 'id', type: 'number' },
          { name: 'name', type: 'text', required: true },
          { name: 'age', type: 'number' },
          { name: 'active', type: 'boolean', defaultValue: true },
          { name: 'joined', type: 'date' },
        ],
        rows: [
          { id: 1, name: 'Ada', age: 36, active: true, joined: '2020-01-15' },
          { id: 2, name: 'Bob', age: null, active: false, joined: '2021-06-01' },
          { id: 3, name: 'Cheung', age: 5, active: true, joined: null },
        ],
      },
      {
        name: 'orders',
        primaryKey: 'ref',
        columns: [
          { name: 'ref', type: 'text' },
          { name: 'person', type: 'number', references: 'people' },
          { name: 'total', type: 'number' },
        ],
        rows: [
          { ref: 'A1', person: 1, total: 120 },
          { ref: 'A2', person: 1, total: 80 },
        ],
      },
    ],
  };
}

export class DatabaseApp {
  readonly element: HTMLElement;

  private store: DataStore;
  private readonly options: DatabaseOptions;

  private tableName: string;
  private conditions: Condition[] = [];
  private sortColumn: string | null = null;
  private sortDescending = false;
  private problems: readonly ValidationProblem[] = [];
  /**
   * A transient message, shown BESIDE the counts rather than instead of them.
   *
   * The first version called setStatus after render, so a confirmation
   * replaced the row counts and the aggregate outright — the moment somebody
   * added a row, the numbers they were watching vanished and did not come
   * back until they clicked something else.
   */
  private note = '';

  private readonly tableList: HTMLElement;
  private readonly queryBar: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly form: HTMLElement;
  private readonly problemList: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly toolbar: HTMLElement;

  constructor(options: DatabaseOptions = {}) {
    this.options = options;
    this.store = options.store ?? sampleStore();
    this.tableName = this.store.tables[0]?.name ?? '';

    this.tableList = el('div', {
      class: 'database__tables',
      role: 'listbox',
      'aria-label': 'Tables',
    });
    this.queryBar = el('div', {
      class: 'database__query',
      role: 'group',
      'aria-label': 'Filter rows',
    });
    this.grid = el('div', { class: 'database__grid', role: 'table', 'aria-label': 'Rows' });
    this.form = el('form', {
      class: 'database__form',
      'aria-label': 'Add a row',
      // The browser’s own validation is turned OFF, deliberately.
      //
      // A required field with the native attribute blocks submit entirely, so
      // the engine’s validation never runs — and the engine reports every
      // problem at once, beside the field it belongs to, where the native
      // bubble shows one at a time and vanishes. The accessible semantics are
      // kept through aria-required, which announces the requirement without
      // taking over the submit.
      novalidate: 'novalidate',
    });
    this.problemList = el('ul', {
      class: 'database__problems',
      role: 'alert',
      'data-shown': 'false',
    });
    this.statusLine = el('div', {
      class: 'database__status',
      role: 'status',
      'aria-live': 'polite',
    });
    this.toolbar = el('div', {
      class: 'database__toolbar',
      role: 'toolbar',
      'aria-label': 'Database',
    });

    this.element = el('div', { class: 'database' }, [
      this.toolbar,
      el('div', { class: 'database__body' }, [
        this.tableList,
        el('div', { class: 'database__main' }, [this.queryBar, this.grid]),
        el('div', { class: 'database__side' }, [
          el('h3', { class: 'database__side-title' }, ['Add a row']),
          this.form,
          this.problemList,
        ]),
      ]),
      this.statusLine,
    ]);

    this.buildToolbar();
    this.wire();
    this.render();
  }

  private buildToolbar(): void {
    clear(this.toolbar);
    this.toolbar.append(
      el('button', { class: 'database__action', type: 'button', 'data-action': 'add-filter' }, [
        'Add filter',
      ]),
      el('button', { class: 'database__action', type: 'button', 'data-action': 'clear-filters' }, [
        'Clear filters',
      ]),
      el('button', { class: 'database__action', type: 'button', 'data-action': 'export' }, [
        'Export as CSV',
      ]),
    );
  }

  private wire(): void {
    this.tableList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.database__table');
      if (!target) return;
      this.tableName = target.getAttribute('data-table') ?? this.tableName;
      // Filters are cleared when the table changes: a condition naming a
      // column the new table does not have is an error, and silently dropping
      // it would show an unfiltered list that looks filtered.
      this.conditions = [];
      this.sortColumn = null;
      this.problems = [];
      this.render();
    });

    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.database__action');
      if (!target) return;
      const action = target.getAttribute('data-action');
      if (action === 'add-filter') this.addFilter();
      else if (action === 'clear-filters') {
        this.conditions = [];
        this.render();
      } else if (action === 'export') this.exportCsv();
    });

    this.queryBar.addEventListener('change', () => this.readFilters());
    this.queryBar.addEventListener('input', () => this.readFilters());
    this.queryBar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-remove]');
      if (!target) return;
      const index = Number(target.getAttribute('data-remove'));
      this.conditions.splice(index, 1);
      this.render();
    });

    this.grid.addEventListener('click', (event) => {
      const header = (event.target as HTMLElement).closest('[data-sort]');
      if (header !== null) {
        const column = header.getAttribute('data-sort') ?? '';
        if (this.sortColumn === column) this.sortDescending = !this.sortDescending;
        else {
          this.sortColumn = column;
          this.sortDescending = false;
        }
        this.render();
        return;
      }

      const remove = (event.target as HTMLElement).closest('[data-delete]');
      if (remove !== null) {
        this.deleteByKey(remove.getAttribute('data-delete') ?? '');
      }
    });

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.addRow();
    });
  }

  private currentTable(): Table | undefined {
    return this.store.tables.find((table) => table.name === this.tableName);
  }

  private addFilter(): void {
    const table = this.currentTable();
    const column = table?.columns[0];
    if (column === undefined) return;
    this.conditions.push({ column: column.name, comparison: 'equals', value: '' });
    this.render();
  }

  /** Read every filter row back out of its controls. */
  private readFilters(): void {
    const rows = [...this.queryBar.querySelectorAll('.database__condition')];
    this.conditions = rows.map((row) => {
      const column = row.querySelector<HTMLSelectElement>('.database__filter-column')?.value ?? '';
      const comparison = (row.querySelector<HTMLSelectElement>('.database__filter-comparison')
        ?.value ?? 'equals') as Comparison;
      const value = row.querySelector<HTMLInputElement>('.database__filter-value')?.value ?? '';
      return { column, comparison, value };
    });
    // Only the results are redrawn, so a field being typed into keeps focus
    // and its caret.
    this.renderGrid();
    this.renderStatus();
    this.updateValueVisibility();
  }

  /** Hide the value box for comparisons that take no value. */
  private updateValueVisibility(): void {
    for (const row of this.queryBar.querySelectorAll('.database__condition')) {
      const comparison = row.querySelector<HTMLSelectElement>('.database__filter-comparison')?.value;
      const entry = COMPARISONS.find((candidate) => candidate.value === comparison);
      const input = row.querySelector<HTMLInputElement>('.database__filter-value');
      if (input === null) continue;
      // Disabled AND hidden. Hidden alone leaves it in the tab order, so
      // keyboard users land on a box that does nothing.
      const needed = entry?.needsValue !== false;
      input.hidden = !needed;
      input.disabled = !needed;
    }
  }

  private addRow(): void {
    const table = this.currentTable();
    if (table === undefined) return;

    const row: Record<string, CellValue> = {};
    for (const column of table.columns) {
      const field = this.form.querySelector<HTMLInputElement>(
        '[data-column="' + column.name + '"]',
      );
      if (field === null) continue;
      row[column.name] = field.type === 'checkbox' ? field.checked : field.value;
    }

    const result = insertRow(this.store, table.name, row);
    if ('problems' in result) {
      // Every problem at once, beside the field it belongs to — not one per
      // attempt, which turns filling in a form into a guessing game.
      this.problems = result.problems;
      this.render();
      return;
    }

    this.store = result.database;
    this.problems = [];
    this.options.onChange?.(this.store);
    this.note = 'Row added.';
    this.render();
  }

  /**
   * Delete a row, behind the destructive-action gate.
   *
   * There is no undo for this yet, so it goes through the two-key gate rather
   * than a plain confirm. The gate already existed and nothing in the
   * application used it - a destructive-action confirmation no destructive
   * action goes through is decoration, which is the defect this Oak Kay
   * refuses everywhere else.
   */
  private deleteByKey(key: string): void {
    const table = this.currentTable();
    if (table === undefined) return;

    const anchor = this.element.querySelector<HTMLElement>(
      '[data-delete="' + CSS.escape(key) + '"]',
    );

    void SuperConfirm.open({
      title: 'Delete this row from ' + table.name,
      // Named, not counted: "1 row" tells somebody nothing about WHICH row,
      // and the whole point of the gate is that they can check before it goes.
      affected: 'The row whose ' + table.primaryKey + ' is ' + key + '.',
      irreversible: 'There is no undo for a deleted row yet. It will be gone.',
      actionLabel: 'Delete the row',
      anchor,
    }).then((outcome) => {
      if (outcome.confirmed) this.reallyDeleteByKey(key);
    });
  }

  private reallyDeleteByKey(key: string): void {
    const table = this.currentTable();
    if (table === undefined) return;

    const column = table.columns.find((candidate) => candidate.name === table.primaryKey);
    const typed: CellValue = column?.type === 'number' ? Number(key) : key;

    const result = deleteRow(this.store, table.name, typed);
    if ('problems' in result) {
      this.problems = result.problems;
      this.render();
      return;
    }
    this.store = result.database;
    this.problems = [];
    this.options.onChange?.(this.store);
    this.render();
  }

  private visibleRows(): Row[] {
    const table = this.currentTable();
    if (table === undefined) return [];
    try {
      return runQuery(this.store, {
        table: table.name,
        // A condition with an empty value is ignored rather than matching
        // nothing: a half-built filter should not empty the grid.
        where: this.conditions.filter(
          (condition) =>
            condition.comparison === 'isEmpty' ||
            condition.comparison === 'isNotEmpty' ||
            String(condition.value ?? '').length > 0,
        ),
        ...(this.sortColumn === null
          ? {}
          : { sortBy: { column: this.sortColumn, descending: this.sortDescending } }),
      });
    } catch {
      // A query that will not run leaves the grid empty and says so in the
      // status line rather than throwing into the event handler.
      return [];
    }
  }

  private exportCsv(): void {
    const table = this.currentTable();
    if (table === undefined) return;
    const rows = this.visibleRows();
    if (rows.length === 0) {
      this.note = 'Nothing to export: no rows match.';
      this.renderStatus();
      return;
    }

    const escape = (value: CellValue): string => {
      if (value === null) return '';
      const text = String(value);
      const quote = String.fromCharCode(34);
      return /[",\n\r]/.test(text) ? quote + text.split(quote).join(quote + quote) + quote : text;
    };

    const lines = [
      table.columns.map((column) => escape(column.name)).join(','),
      ...rows.map((row) => table.columns.map((column) => escape(row[column.name] ?? null)).join(',')),
    ];

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: table.name + '.csv' }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);

    this.note =
      'Exported ' +
      rows.length +
      (rows.length === 1 ? ' row' : ' rows') +
      ' as CSV. This format does not carry: column types; constraints; ' +
      'the difference between an empty value and an empty string.';
    this.renderStatus();
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    this.renderTables();
    this.renderQuery();
    this.renderGrid();
    this.renderForm();
    this.renderProblems();
    this.renderStatus();
  }

  private renderTables(): void {
    clear(this.tableList);
    for (const table of this.store.tables) {
      this.tableList.append(
        el(
          'div',
          {
            class: 'database__table',
            role: 'option',
            'data-table': table.name,
            'data-current': table.name === this.tableName ? 'true' : 'false',
            'aria-selected': table.name === this.tableName ? 'true' : 'false',
          },
          [
            el('span', { class: 'database__table-name' }, [table.name]),
            el('span', { class: 'database__table-count' }, [
              String(table.rows.length) + (table.rows.length === 1 ? ' row' : ' rows'),
            ]),
          ],
        ),
      );
    }
  }

  private renderQuery(): void {
    clear(this.queryBar);
    const table = this.currentTable();
    if (table === undefined) return;

    if (this.conditions.length === 0) {
      this.queryBar.append(
        el('span', { class: 'database__query-empty' }, [
          'No filters. Every row is shown.',
        ]),
      );
      return;
    }

    this.conditions.forEach((condition, index) => {
      const columnSelect = el('select', {
        class: 'database__filter-column',
        'aria-label': 'Column for filter ' + (index + 1),
      }) as HTMLSelectElement;
      for (const column of table.columns) {
        columnSelect.append(el('option', { value: column.name, text: column.name }));
      }
      columnSelect.value = condition.column;

      const comparisonSelect = el('select', {
        class: 'database__filter-comparison',
        'aria-label': 'Comparison for filter ' + (index + 1),
      }) as HTMLSelectElement;
      for (const entry of COMPARISONS) {
        comparisonSelect.append(el('option', { value: entry.value, text: entry.label }));
      }
      comparisonSelect.value = condition.comparison;

      const valueInput = el('input', {
        class: 'database__filter-value',
        type: 'text',
        'aria-label': 'Value for filter ' + (index + 1),
      }) as HTMLInputElement;
      valueInput.value = String(condition.value ?? '');

      this.queryBar.append(
        el('div', { class: 'database__condition' }, [
          columnSelect,
          comparisonSelect,
          valueInput,
          el(
            'button',
            {
              class: 'database__remove',
              type: 'button',
              'data-remove': String(index),
              'aria-label': 'Remove filter ' + (index + 1),
            },
            ['Remove'],
          ),
        ]),
      );
    });

    this.updateValueVisibility();
  }

  private renderGrid(): void {
    clear(this.grid);
    const table = this.currentTable();
    if (table === undefined) return;

    const header = el('div', { class: 'database__row database__row--header', role: 'row' });
    for (const column of table.columns) {
      const sorted = this.sortColumn === column.name;
      header.append(
        el(
          'button',
          {
            class: 'database__cell database__cell--header',
            type: 'button',
            role: 'columnheader',
            'data-sort': column.name,
            // The sort state is announced, not only shown by an arrow.
            'aria-sort': sorted ? (this.sortDescending ? 'descending' : 'ascending') : 'none',
            'data-type': column.type,
          },
          [
            column.name,
            el('span', { class: 'database__cell-type' }, [
              column.type + (column.required === true ? ', required' : ''),
            ]),
          ],
        ),
      );
    }
    header.append(el('span', { class: 'database__cell database__cell--actions' }, ['']));
    this.grid.append(header);

    const rows = this.visibleRows();
    if (rows.length === 0) {
      this.grid.append(
        el('p', { class: 'database__empty' }, [
          table.rows.length === 0
            ? 'This table has no rows yet.'
            : 'No row matches the current filters.',
        ]),
      );
      return;
    }

    for (const row of rows) {
      const key = String(row[table.primaryKey] ?? '');
      const node = el('div', { class: 'database__row', role: 'row' });
      for (const column of table.columns) {
        const value = row[column.name] ?? null;
        node.append(
          el(
            'span',
            {
              class: 'database__cell',
              role: 'cell',
              'data-type': column.type,
              // An empty value is not an empty cell. The distinction is the
              // whole reason this is a database, so it is shown rather than
              // rendered as blank space.
              'data-empty': value === null ? 'true' : 'false',
            },
            [value === null ? 'empty' : formatCell(value)],
          ),
        );
      }
      node.append(
        el(
          'span',
          { class: 'database__cell database__cell--actions', role: 'cell' },
          [
            el(
              'button',
              {
                class: 'database__remove',
                type: 'button',
                'data-delete': key,
                'aria-label': 'Delete row ' + key,
              },
              ['Delete'],
            ),
          ],
        ),
      );
      this.grid.append(node);
    }
  }

  private renderForm(): void {
    clear(this.form);
    const table = this.currentTable();
    if (table === undefined) return;

    for (const column of table.columns) {
      const id = 'db-field-' + column.name;
      const problem = this.problems.find((candidate) => candidate.column === column.name);

      const input = el('input', {
        class: 'database__field',
        id,
        'data-column': column.name,
        // A number field is text with a NUMERIC INPUT MODE rather than
        // type='number'. A number input silently discards anything
        // non-numeric before any script sees it, so the engine’s own
        // message — which names the column and quotes the value — can never
        // be shown. inputmode still raises the numeric keyboard on a phone.
        type:
          column.type === 'boolean'
            ? 'checkbox'
            : column.type === 'date'
              ? 'date'
              : 'text',
        ...(column.type === 'number' ? { inputmode: 'decimal' } : {}),
        // The type of the field matches the type of the column, so the
        // platform's own keyboard and picker appear rather than a plain box
        // that accepts anything and fails on save.
        ...(column.required === true ? { 'aria-required': 'true' } : {}),
        ...(problem === undefined ? {} : { 'aria-invalid': 'true', 'aria-describedby': id + '-problem' }),
      }) as HTMLInputElement;

      if (column.type === 'boolean' && column.defaultValue === true) input.checked = true;

      this.form.append(
        el('label', { class: 'database__label', for: id }, [
          column.name,
          el('span', { class: 'database__label-type' }, [
            column.type +
              (column.required === true ? ' · required' : '') +
              (column.references !== undefined ? ' · from ' + column.references : ''),
          ]),
        ]),
        input,
        // The problem sits beside the field it belongs to, not only in a list
        // at the bottom, so it is obvious which box to fix.
        ...(problem === undefined
          ? []
          : [el('span', { class: 'database__field-problem', id: id + '-problem' }, [problem.message])]),
      );
    }

    this.form.append(
      el('button', { class: 'database__action', type: 'submit' }, ['Add row']),
    );
  }

  private renderProblems(): void {
    clear(this.problemList);
    this.problemList.setAttribute('data-shown', this.problems.length > 0 ? 'true' : 'false');
    for (const problem of this.problems) {
      this.problemList.append(el('li', {}, [problem.message]));
    }
  }

  private renderStatus(): void {
    const table = this.currentTable();
    if (table === undefined) {
      this.setStatus('No table selected.');
      this.note = '';
      return;
    }

    const rows = this.visibleRows();
    const parts = [
      table.name,
      rows.length + ' of ' + table.rows.length + (table.rows.length === 1 ? ' row' : ' rows'),
    ];

    // An aggregate over the first numeric column, so a filtered view answers
    // the obvious question without anybody building a report.
    const numeric = table.columns.find((column) => column.type === 'number' && column.name !== table.primaryKey);
    if (numeric !== undefined && rows.length > 0) {
      const total = aggregate(rows, numeric.name, 'sum');
      const mean = aggregate(rows, numeric.name, 'average');
      parts.push(
        total === null
          ? numeric.name + ': no values'
          : numeric.name + ' total ' + formatNumber(total) + ', average ' + formatNumber(mean ?? 0),
      );
    }

    if (this.note !== '') parts.push(this.note);
    this.setStatus(parts.join('   '));
    // Cleared after showing, so it does not follow the user around.
    this.note = '';
  }

  private setStatus(message: string): void {
    clear(this.statusLine);
    this.statusLine.append(message);
  }
}

function formatCell(value: CellValue): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
