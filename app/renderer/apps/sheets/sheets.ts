/**
 * Sheets.
 *
 * A real grid over the sheet engine. The engine owns cells, formulas, the
 * dependency graph and recalculation; this surface owns what is on screen.
 *
 * IT IS VIRTUALISED, and that is the whole architecture rather than an
 * optimisation bolted on later. The grid is sixteen thousand columns by a
 * million rows. Rendering a DOM node per cell would be sixteen billion nodes,
 * so the only question is whether the virtualisation is designed in from the
 * start or retrofitted after the first person opens a real workbook. Only the
 * cells inside the scroll viewport exist, plus a small overscan so a fast
 * scroll does not show blank rows.
 *
 * Selection is a RANGE, always — a single cell is a one-by-one range. Keeping
 * one shape means every operation that acts on a selection works the same way
 * whether one cell or ten thousand are selected, rather than every one of them
 * carrying its own "is this a single cell" branch.
 */

import { renderChart, seriesColour } from '../../../engines/sheet/chart.js';
import {
  GENERAL,
  type NumberFormat,
  PRESETS,
  describeFormat as describeNumberFormat,
  formatValue,
  roundsForDisplay,
} from '../../../engines/sheet/format.js';
import {
  type Direction,
  formulasBlocking,
  sortRows,
} from '../../../engines/sheet/sort.js';
import {
  type Condition as FilterCondition,
  describeFilter,
  filterRows,
} from '../../../engines/sheet/filter.js';
import { SuperConfirm } from '../../components/super-confirm.js';
import { clear, el } from '../../dom.js';
import {
  type CellAddress,
  columnName,
  formatReference,
  normaliseRange,
} from '../../../engines/sheet/reference.js';
import { Workbook } from '../../../engines/sheet/workbook.js';
import {
  BLANK,
  type ScalarValue,
  formatNumberForText,
  isError,
} from '../../../engines/sheet/values.js';
import { readCsv } from '../../../engines/codec/csv.js';
import { readXlsx, writeXlsx, type XlsxCell } from '../../../engines/codec/xlsx.js';
import { readOds, writeOds } from '../../../engines/codec/odf.js';
import {
  describeFormat as describeDetected,
  detectFormat,
  looksLikeZip,
} from '../../../engines/codec/detect.js';
import {
  FORMATS,
  type TableCell,
  type TableFormat,
  describeFormat,
  exportTable,
} from '../../../engines/codec/table-export.js';

/** Geometry. Fixed for now; per-column widths are the next increment. */
const DEFAULT_COLUMN_WIDTH = 96;

/**
 * A column can be narrowed but never to nothing.
 *
 * A column dragged to zero is a column that cannot be grabbed again, so the
 * only way back is a reset the user has to find - and until they do, a column
 * of their data is simply gone from the screen with nothing to say where.
 */
const MIN_COLUMN_WIDTH = 24;
const MAX_COLUMN_WIDTH = 640;

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 52;

/**
 * The visible grid is bounded well below the engine's own limits.
 *
 * A scrollable area a million rows tall is 26 million pixels, and browsers do
 * not reliably scroll past a few million. Rendering a spacer that tall gives a
 * scrollbar that jumps and a viewport that cannot reach the bottom, which
 * looks like a rendering fault rather than a platform limit. The engine still
 * addresses the full grid; this is what the user can scroll to.
 */
const VISIBLE_ROWS = 20000;
const VISIBLE_COLUMNS = 512;

/** Rows and columns rendered beyond the viewport, so scrolling stays smooth. */
const OVERSCAN = 4;

export interface SheetsOptions {
  workbook?: Workbook;
  onChange?: (workbook: Workbook) => void;
  /** Widths the user has set, so they survive a restart. */
  columnWidths?: Readonly<Record<number, number>>;
  onColumnWidths?: (widths: Readonly<Record<number, number>>) => void;
  /** Per-column number formats, likewise persisted by the caller. */
  columnFormats?: Readonly<Record<number, NumberFormat>>;
  onColumnFormats?: (formats: Readonly<Record<number, NumberFormat>>) => void;
}

interface Selection {
  readonly anchor: CellAddress;
  readonly focus: CellAddress;
}

export class Sheets {
  readonly element: HTMLElement;

  private readonly workbook: Workbook;
  private readonly options: SheetsOptions;

  /** Only the columns that differ from the default are stored. */
  private readonly columnWidths = new Map<number, number>();
  private readonly columnFormats = new Map<number, NumberFormat>();

  /**
   * A sentence the status bar carries until the next selection change.
   *
   * Held rather than written straight into the label, because the label is
   * rebuilt on every render - so a message written directly would survive
   * until the next arrow key and no longer, which is not long enough to read.
   */
  private note = '';

  /** Whether the first row is a heading rather than data. */
  private readonly headerToggle: HTMLInputElement;

  /** Once the user has set it, the suggestion stops overriding them. */
  private headerTouched = false;

  /** Which column the last sort used, so the header can show it. */
  private sortedColumn: number | null = null;
  private sortDirection: Direction = 'ascending';

  private sheetName: string;
  private selection: Selection;
  private editing: { address: CellAddress; original: string } | null = null;

  private readonly formulaInput: HTMLInputElement;
  private readonly addressLabel: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly corner: HTMLElement;
  private readonly columnHeader: HTMLElement;
  private readonly rowHeader: HTMLElement;
  private readonly canvasHost: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly cellEditor: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private readonly toolbar: HTMLElement;
  private readonly lossNote: HTMLElement;
  private readonly chartHost: HTMLElement;

  constructor(options: SheetsOptions = {}) {
    this.options = options;
    this.workbook = options.workbook ?? new Workbook(['Sheet1']);

    this.headerToggle = el('input', {
      type: 'checkbox',
      class: 'sheets__checkbox',
      'data-control': 'header-row',
      'aria-label': 'Treat the first row as a header rather than as data',
    }) as HTMLInputElement;

    // Restored through the same bounded setter a drag uses, so a width that
    // arrived from a profile written by an older build cannot put a column
    // somewhere it can never be grabbed from.
    for (const [column, width] of Object.entries(options.columnWidths ?? {})) {
      const bounded = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
      if (bounded !== DEFAULT_COLUMN_WIDTH) this.columnWidths.set(Number(column), bounded);
    }
    for (const [column, format] of Object.entries(options.columnFormats ?? {})) {
      this.columnFormats.set(Number(column), format);
    }
    this.sheetName = this.workbook.sheetNames()[0] ?? 'Sheet1';
    this.selection = { anchor: { column: 0, row: 0 }, focus: { column: 0, row: 0 } };

    this.addressLabel = el('button', {
      class: 'sheets__address',
      type: 'button',
      'aria-label': 'Selected cell',
      title: 'The selected cell',
    });

    this.formulaInput = el('input', {
      class: 'sheets__formula',
      type: 'text',
      'aria-label': 'Formula bar',
      placeholder: 'Type a value, or a formula beginning with =',
    }) as HTMLInputElement;

    this.statusLabel = el('div', {
      class: 'sheets__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.corner = el('div', { class: 'sheets__corner', 'aria-hidden': 'true' });
    // Declared clipping frames. An absolutely positioned track slides behind a
    // fixed window so the headers stay locked to the grid, so the content is
    // wider than the box on purpose and every header is reachable by scrolling
    // the grid. Said out loud here rather than left for the layout matrix to
    // guess at from the shape.
    this.columnHeader = el('div', {
      class: 'sheets__column-header',
      role: 'row',
      'data-clip': 'viewport',
    });
    this.rowHeader = el('div', { class: 'sheets__row-header', 'data-clip': 'viewport' });
    this.canvasHost = el('div', { class: 'sheets__cells', role: 'rowgroup' });

    this.cellEditor = el('input', {
      class: 'sheets__cell-editor',
      type: 'text',
      'aria-label': 'Cell editor',
    }) as HTMLInputElement;
    this.cellEditor.hidden = true;

    this.scroller = el(
      'div',
      {
        class: 'sheets__scroller',
        role: 'grid',
        tabindex: '0',
        'aria-label': 'Spreadsheet grid',
        'aria-rowcount': String(VISIBLE_ROWS),
        'aria-colcount': String(VISIBLE_COLUMNS),
      },
      [
        // The spacer is what gives the scrollbar its size. Without it the
        // scroller would be exactly as tall as the handful of rendered rows
        // and there would be nothing to scroll.
        el('div', {
          class: 'sheets__spacer',
          'aria-hidden': 'true',
          style:
            'width:' +
            this.totalWidth() +
            'px;height:' +
            VISIBLE_ROWS * ROW_HEIGHT +
            'px',
        }),
        this.canvasHost,
        this.cellEditor,
      ],
    );

    this.fileInput = el('input', {
      class: 'sheets__file',
      type: 'file',
      accept: '.csv,.tsv,.txt,.xlsx,.ods,text/csv,text/tab-separated-values',
      'aria-label': 'Choose a CSV, TSV or Excel file to import',
    }) as HTMLInputElement;

    this.chartHost = el('div', {
      class: 'sheets__chart',
      // Hidden until there is a chart. An empty framed box reads as a chart
      // that failed to draw rather than as one nobody has asked for yet.
      hidden: true,
    });

    this.lossNote = el('div', {
      class: 'sheets__loss',
      role: 'status',
      'aria-live': 'polite',
      'data-shown': 'false',
    });

    this.toolbar = el('div', { class: 'sheets__toolbar' }, [
      el('span', { class: 'sheets__toolbar-label' }, ['Import']),
      this.fileInput,
      el('span', { class: 'sheets__toolbar-label' }, ['Selection']),
      // A filter is CHOSEN, not assumed. A button that applies a rule nobody
      // picked is a decorative control: it does something, and the person who
      // pressed it cannot say what.
      el(
        'select',
        {
          class: 'sheets__filter-column',
          'aria-label': 'Column to filter on',
          'data-filter': 'column',
        },
        [],
      ),
      el(
        'select',
        {
          class: 'sheets__filter-comparison',
          'aria-label': 'How to compare',
          'data-filter': 'comparison',
        },
        [
          el('option', { value: 'contains' }, ['contains']),
          el('option', { value: 'equals' }, ['is exactly']),
          el('option', { value: 'notEquals' }, ['is not']),
          el('option', { value: 'startsWith' }, ['starts with']),
          el('option', { value: 'greaterThan' }, ['is more than']),
          el('option', { value: 'lessThan' }, ['is less than']),
          el('option', { value: 'isBlank' }, ['is blank']),
          el('option', { value: 'isNotBlank' }, ['is not blank']),
          el('option', { value: 'isError' }, ['is an error']),
        ],
      ),
      el('input', {
        class: 'sheets__filter-value',
        type: 'text',
        placeholder: 'Value',
        'aria-label': 'Value to compare against',
        'data-filter': 'value',
      }),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'filter',
          title: 'Hide rows in this range that do not match - never removes them',
        },
        ['Filter rows'],
      ),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'clear-filter',
          title: 'Show every row again',
        },
        ['Clear filter'],
      ),
      el('span', { class: 'sheets__toolbar-label' }, ['Column']),
      el('label', { class: 'sheets__check' }, [
        this.headerToggle,
        'First row is a header',
      ]),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'sort-ascending',
          title: 'Sort the whole rows by this column, smallest first',
        },
        ['Sort up'],
      ),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'sort-descending',
          title: 'Sort the whole rows by this column, largest first',
        },
        ['Sort down'],
      ),
      el(
        'select',
        {
          class: 'sheets__select',
          'data-control': 'format',
          'aria-label': 'Number format for this column',
        },
        PRESETS.map((preset) =>
          el('option', { value: preset.label }, [preset.label]),
        ),
      ),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'narrower',
          title: 'Make this column narrower',
        },
        ['Narrower'],
      ),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'wider',
          title: 'Make this column wider',
        },
        ['Wider'],
      ),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'fit-column',
          title: 'Fit this column to the longest value in it',
        },
        ['Fit'],
      ),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'chart',
          title: 'Chart the selected range - a bar chart always includes zero',
        },
        ['Chart'],
      ),
      el('span', { class: 'sheets__toolbar-label' }, ['In bulk']),
      el(
        'button',
        {
          class: 'sheets__bulk',
          type: 'button',
          'data-action': 'clear-cells',
          // Delete already did this from the keyboard and nowhere else, which
          // is a bulk action only the people who already knew about it could
          // find.
          title: 'Clear every cell in the selection',
        },
        ['Clear cells'],
      ),
      el('span', { class: 'sheets__toolbar-label' }, ['Export']),
      el(
        'button',
        {
          class: 'sheets__export',
          type: 'button',
          'data-format': 'xlsx',
          title: 'Excel workbook \u2014 loses: cell formatting; column widths',
        },
        ['Excel workbook'],
      ),
      el(
        'button',
        {
          class: 'sheets__export',
          type: 'button',
          'data-format': 'ods',
          title:
            'OpenDocument spreadsheet \u2014 loses: cell formatting; column widths. Formulas are translated to the OpenDocument syntax.',
        },
        ['OpenDocument spreadsheet'],
      ),
      ...FORMATS.map((format) =>
        el(
          'button',
          {
            class: 'sheets__export',
            type: 'button',
            'data-format': format.id,
            // The losses are named on the control ITSELF rather than
            // discovered afterwards. An export that quietly drops formulas
            // is one somebody finds out about a week later.
            title:
              format.losses.length === 0
                ? format.label + ' \u2014 nothing is lost'
                : format.label + ' \u2014 loses: ' + format.losses.join('; '),
          },
          [format.label],
        ),
      ),
    ]);
    this.element = el('div', { class: 'sheets' }, [
      el('div', { class: 'sheets__bar' }, [
        this.addressLabel,
        el('div', { class: 'sheets__formula-wrap' }, [
          el('span', { class: 'sheets__fx', 'aria-hidden': 'true' }, ['fx']),
          this.formulaInput,
        ]),
      ]),
      this.toolbar,
      this.lossNote,
      el('div', { class: 'sheets__frame' }, [
        el('div', { class: 'sheets__header-row' }, [this.corner, this.columnHeader]),
        el('div', { class: 'sheets__body' }, [this.rowHeader, this.scroller]),
      ]),
      this.chartHost,
      this.statusLabel,
    ]);

    this.wire();
    this.render();
  }

  /** Focus the grid, for the command palette and for tab activation. */
  focus(): void {
    this.scroller.focus();
  }

  private wire(): void {
    this.scroller.addEventListener('scroll', () => this.render());

    this.scroller.addEventListener('mousedown', (event) => {
      const address = this.addressFromPoint(event as MouseEvent);
      if (address === undefined) return;
      // Shift extends the range from the existing anchor rather than starting
      // a new one, which is what makes shift-click select a block.
      if ((event as MouseEvent).shiftKey) {
        this.selection = { anchor: this.selection.anchor, focus: address };
      } else {
        this.selection = { anchor: address, focus: address };
      }
      this.commitEditor();
      this.render();
      this.scroller.focus();
    });

    this.scroller.addEventListener('dblclick', () => this.beginEdit(''));

    this.scroller.addEventListener('keydown', (event) => this.onKeyDown(event as KeyboardEvent));

    this.formulaInput.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Enter') {
        event.preventDefault();
        this.writeSelected(this.formulaInput.value);
        this.moveFocus(0, 1, false);
        this.scroller.focus();
      } else if (key === 'Escape') {
        event.preventDefault();
        this.render();
        this.scroller.focus();
      }
    });

    this.cellEditor.addEventListener('keydown', (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === 'Enter') {
        event.preventDefault();
        this.commitEditor();
        this.moveFocus(0, 1, false);
      } else if (keyboard.key === 'Escape') {
        event.preventDefault();
        this.cancelEditor();
      } else if (keyboard.key === 'Tab') {
        event.preventDefault();
        this.commitEditor();
        this.moveFocus(keyboard.shiftKey ? -1 : 1, 0, false);
      }
    });

    this.addressLabel.addEventListener('click', () => this.scroller.focus());

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      void this.importFile(file);
    });

    this.toolbar
      .querySelector('[data-action="clear-cells"]')
      ?.addEventListener('click', () => this.clearMarkedCells());

    this.toolbar
      .querySelector('[data-action="filter"]')
      ?.addEventListener('click', () => this.applyFilter());
    this.toolbar
      .querySelector('[data-action="clear-filter"]')
      ?.addEventListener('click', () => this.clearFilter());
    this.toolbar
      .querySelector('[data-action="chart"]')
      ?.addEventListener('click', () => this.drawChart());

    // Dragging the handle. The listener sits on the header rather than on each
    // handle, because the header is rebuilt on every scroll and a listener per
    // handle would be added and dropped hundreds of times a second.
    this.columnHeader.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement;
      const attribute = target.getAttribute?.('data-resize');
      if (attribute === null || attribute === undefined) return;

      event.preventDefault();
      const column = Number(attribute);
      const startX = event.clientX;
      const startWidth = this.widthOf(column);

      const move = (moved: PointerEvent): void => {
        this.setColumnWidth(column, startWidth + (moved.clientX - startX));
      };
      const done = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
        this.setStatus(
          'Column ' + columnName(column) + ' is now ' + this.widthOf(column) + ' pixels wide.',
        );
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
    });

    // Double-click to fit, the convention everywhere else.
    this.columnHeader.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement;
      const attribute = target.getAttribute?.('data-resize');
      if (attribute === null || attribute === undefined) return;
      this.selection = {
        anchor: { column: Number(attribute), row: this.selection.anchor.row },
        focus: { column: Number(attribute), row: this.selection.focus.row },
      };
      this.fitColumn();
    });

    this.headerToggle.addEventListener('change', () => {
      this.headerTouched = true;
    });

    this.toolbar
      .querySelector('[data-action="sort-ascending"]')
      ?.addEventListener('click', () => this.sortByColumn('ascending'));
    this.toolbar
      .querySelector('[data-action="sort-descending"]')
      ?.addEventListener('click', () => this.sortByColumn('descending'));

    // A keyboard path for resizing, not only a drag handle. A column somebody
    // cannot use a mouse for is a column they cannot read.
    this.toolbar
      .querySelector('[data-action="narrower"]')
      ?.addEventListener('click', () => this.stepWidth(-16));
    this.toolbar
      .querySelector('[data-action="wider"]')
      ?.addEventListener('click', () => this.stepWidth(16));
    this.toolbar
      .querySelector('[data-action="fit-column"]')
      ?.addEventListener('click', () => this.fitColumn());

    const formatPicker = this.toolbar.querySelector('[data-control="format"]');
    formatPicker?.addEventListener('change', () => {
      const label = (formatPicker as HTMLSelectElement).value;
      const preset = PRESETS.find((candidate) => candidate.label === label);
      if (preset === undefined) return;
      this.setColumnFormat(this.selection.focus.column, preset.format);
    });

    for (const button of this.toolbar.querySelectorAll('.sheets__export')) {
      button.addEventListener('click', () => {
        const format = button.getAttribute('data-format');
        if (format === 'xlsx' || format === 'ods') {
          this.exportWorkbook(format);
          return;
        }
        if (format) this.exportAs(format as TableFormat);
      });
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const { key, shiftKey, ctrlKey } = event;

    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };

    const move = moves[key];
    if (move) {
      event.preventDefault();
      // Control jumps a screenful, which is what people reach for in a large
      // sheet and is far more useful than jumping to the very edge.
      const factor = ctrlKey ? 10 : 1;
      this.moveFocus(move[0] * factor, move[1] * factor, shiftKey);
      return;
    }

    if (key === 'Tab') {
      event.preventDefault();
      this.moveFocus(shiftKey ? -1 : 1, 0, false);
      return;
    }

    if (key === 'Enter') {
      event.preventDefault();
      if (this.editing) this.commitEditor();
      else this.beginEdit(this.currentInput());
      return;
    }

    if (key === 'F2') {
      event.preventDefault();
      this.beginEdit(this.currentInput());
      return;
    }

    if (key === 'Home') {
      event.preventDefault();
      // Control goes to the very first cell, which is the standard shortcut
      // and the only way back from deep in a large sheet without scrolling.
      const row = ctrlKey ? 0 : this.selection.focus.row;
      this.setSelection({ column: 0, row }, shiftKey);
      return;
    }

    if (key === 'End' && ctrlKey) {
      event.preventDefault();
      this.setSelection(this.lastUsedCell(), shiftKey);
      return;
    }

    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      this.clearSelection();
      return;
    }

    // A printable character starts an edit with that character, exactly as
    // typing into a spreadsheet does. Modifier chords are excluded so that
    // Ctrl+C does not begin an edit containing the letter c.
    if (!ctrlKey && !event.metaKey && !event.altKey && key.length === 1) {
      event.preventDefault();
      this.beginEdit(key);
    }
  }

  private moveFocus(columnDelta: number, rowDelta: number, extend: boolean): void {
    const focus = this.selection.focus;
    const target: CellAddress = {
      column: clamp(focus.column + columnDelta, 0, VISIBLE_COLUMNS - 1),
      row: clamp(focus.row + rowDelta, 0, VISIBLE_ROWS - 1),
    };
    this.setSelection(target, extend);
  }

  private setSelection(target: CellAddress, extend: boolean): void {
    this.commitEditor();
    this.selection = extend
      ? { anchor: this.selection.anchor, focus: target }
      : { anchor: target, focus: target };
    this.scrollIntoView(target);
    this.render();
  }

  /**
   * Keep the focused cell visible.
   *
   * Adjusting scrollLeft/scrollTop directly rather than using scrollIntoView,
   * because scrollIntoView on a virtualised grid scrolls to wherever the node
   * currently happens to be — and the node for a cell just outside the
   * viewport does not exist yet.
   */
  private scrollIntoView(address: CellAddress): void {
    const left = this.leftOf(address.column);
    const top = address.row * ROW_HEIGHT;
    const viewWidth = this.scroller.clientWidth;
    const viewHeight = this.scroller.clientHeight;

    if (left < this.scroller.scrollLeft) this.scroller.scrollLeft = left;
    else if (left + this.widthOf(address.column) > this.scroller.scrollLeft + viewWidth) {
      this.scroller.scrollLeft = left + this.widthOf(address.column) - viewWidth;
    }

    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + viewHeight) {
      this.scroller.scrollTop = top + ROW_HEIGHT - viewHeight;
    }
  }

  private addressFromPoint(event: MouseEvent): CellAddress | undefined {
    const box = this.scroller.getBoundingClientRect();
    const x = event.clientX - box.left + this.scroller.scrollLeft;
    const y = event.clientY - box.top + this.scroller.scrollTop;
    if (x < 0 || y < 0) return undefined;
    return {
      column: clamp(this.columnAt(x), 0, VISIBLE_COLUMNS - 1),
      row: clamp(Math.floor(y / ROW_HEIGHT), 0, VISIBLE_ROWS - 1),
    };
  }

  // ------------------------------------------------------------- editing --

  private currentInput(): string {
    return this.workbook.getCell(this.sheetName, this.selection.focus)?.input ?? '';
  }

  private beginEdit(seed: string): void {
    const address = this.selection.focus;
    this.editing = { address, original: this.currentInput() };
    this.cellEditor.value = seed === '' ? this.currentInput() : seed;
    this.cellEditor.hidden = false;
    this.positionEditor(address);
    this.cellEditor.focus();
    // Caret to the end, so typing a seed character continues rather than
    // overwriting it.
    const end = this.cellEditor.value.length;
    this.cellEditor.setSelectionRange(end, end);
  }

  private positionEditor(address: CellAddress): void {
    this.cellEditor.style.left = this.leftOf(address.column) + 'px';
    this.cellEditor.style.top = address.row * ROW_HEIGHT + 'px';
    this.cellEditor.style.width = this.widthOf(address.column) + 'px';
    this.cellEditor.style.height = ROW_HEIGHT + 'px';
  }

  private commitEditor(): void {
    if (!this.editing) return;
    const { address } = this.editing;
    const value = this.cellEditor.value;
    this.editing = null;
    this.cellEditor.hidden = true;
    // Focus returns to the grid. Without this it lands on the now-hidden
    // editor, which means the browser drops it to the body and the very next
    // arrow key goes nowhere — the commit appears to work and the grid
    // appears to freeze.
    this.scroller.focus();
    if (value !== (this.workbook.getCell(this.sheetName, address)?.input ?? '')) {
      this.workbook.setCell(this.sheetName, address, value);
      this.options.onChange?.(this.workbook);
    }
    this.render();
  }

  private cancelEditor(): void {
    if (!this.editing) return;
    this.editing = null;
    this.cellEditor.hidden = true;
    this.scroller.focus();
    this.render();
  }

  private writeSelected(input: string): void {
    this.workbook.setCell(this.sheetName, this.selection.focus, input);
    this.options.onChange?.(this.workbook);
    this.render();
  }

  /**
   * How many cells the selection covers, and how many of those hold anything.
   *
   * Two numbers rather than one, because a clear over a hundred cells of which
   * six are filled changes six things - and reporting the hundred would be the
   * same overstatement as counting selected rows a bulk delete will skip.
   */
  private selectionCounts(): { covered: number; filled: number } {
    const box = this.selectionBox();
    let filled = 0;
    for (let row = box.top; row <= box.bottom; row += 1) {
      for (let column = box.left; column <= box.right; column += 1) {
        const cell = this.workbook.getCell(this.sheetName, { column, row });
        if (cell !== undefined && cell.input !== '') filled += 1;
      }
    }
    return {
      covered: (box.bottom - box.top + 1) * (box.right - box.left + 1),
      filled,
    };
  }

  /**
   * The visible route to the clear that Delete has always done.
   *
   * Says what will change BEFORE it changes: the cells covered and the cells
   * that actually hold something are different numbers, and collapsing them is
   * how somebody discovers afterwards that far less happened than they read.
   */
  private clearMarkedCells(): void {
    const counts = this.selectionCounts();
    if (counts.filled === 0) {
      this.setNote(
        counts.covered === 1
          ? 'That cell is already empty.'
          : 'All ' + counts.covered + ' selected cells are already empty.',
      );
      return;
    }

    const sentence =
      counts.filled +
      (counts.filled === 1 ? ' cell will be cleared' : ' cells will be cleared') +
      ' of the ' +
      counts.covered +
      ' selected.';

    void SuperConfirm.open({
      title: 'Clear ' + counts.filled + ' cells',
      affected: sentence,
      irreversible:
        'The contents go. Formulas elsewhere that referred to them recalculate immediately.',
      actionLabel: 'Clear ' + counts.filled + ' cells',
      anchor: this.toolbar.querySelector('[data-action="clear-cells"]'),
    }).then((result) => {
      if (!result.confirmed) return;
      this.clearSelection();
      this.setNote(sentence);
    });
  }

  /* ------------------------------------------------ filtering and charts -- */

  private filterConditions: FilterCondition[] = [];
  private hiddenRows: ReadonlySet<number> = new Set();

  /** The selected range as rows of values, for a filter or a chart. */
  private selectedRows(): { rows: ScalarValue[][]; top: number; left: number } {
    const box = this.selectionBox();
    const rows: ScalarValue[][] = [];
    for (let row = box.top; row <= box.bottom; row += 1) {
      const line: ScalarValue[] = [];
      for (let column = box.left; column <= box.right; column += 1) {
        const cell = this.workbook.getCell(this.sheetName, { column, row });
        line.push(cell === undefined ? BLANK : cell.value);
      }
      rows.push(line);
    }
    return { rows, top: box.top, left: box.left };
  }

  /**
   * Hide the rows in the selection that do not match.
   *
   * HIDES. Never removes. A spreadsheet that deletes what a filter excludes
   * loses data every time somebody narrows a view, and the loss is invisible
   * until they clear the filter and find the rows gone - so the sentence below
   * says so every time.
   */
  private applyFilter(): void {
    const { rows, top } = this.selectedRows();
    if (rows.length < 2) {
      this.setNote('Select a range with at least a header and one row to filter.');
      return;
    }

    const columnSelect = this.toolbar.querySelector<HTMLSelectElement>('[data-filter="column"]');
    const comparisonSelect = this.toolbar.querySelector<HTMLSelectElement>(
      '[data-filter="comparison"]',
    );
    const valueInput = this.toolbar.querySelector<HTMLInputElement>('[data-filter="value"]');

    const comparison = (comparisonSelect?.value ?? 'contains') as FilterCondition['comparison'];
    const needsValue =
      comparison !== 'isBlank' && comparison !== 'isNotBlank' && comparison !== 'isError';
    const raw = (valueInput?.value ?? '').trim();

    if (needsValue && raw === '') {
      // Refused rather than run on nothing. A filter with an empty value either
      // matches everything or nothing depending on the comparison, and both
      // look like the button did not work.
      this.setNote('Type a value to filter on, or choose a comparison that does not need one.');
      return;
    }

    // A value that reads as a number is compared AS a number, so "more than 90"
    // does not compare "120" as text and decide it is smaller.
    const asNumber = Number(raw);
    const value: string | number =
      raw !== '' && Number.isFinite(asNumber) && raw === String(asNumber) ? asNumber : raw;

    // The first row of the selection is the header, which stays visible
    // whatever the filter says - filtering it out makes the table unreadable.
    this.filterConditions = [
      {
        column: Math.max(0, Number(columnSelect?.value ?? 0)),
        comparison,
        ...(needsValue ? { value } : {}),
      },
    ];
    const result = filterRows(rows, this.filterConditions, { hasHeader: true });

    const visible = new Set(result.visible.map((index) => top + index));
    const hidden = new Set<number>();
    for (let index = 0; index < rows.length; index += 1) {
      if (!visible.has(top + index)) hidden.add(top + index);
    }
    this.hiddenRows = hidden;

    this.render();
    this.setNote(describeFilter(result));
  }

  /**
   * Offer the columns the selection actually has.
   *
   * Filled from the header row rather than from a fixed list, so a person
   * filtering a table sees their own column names - and a range with no header
   * gets "Column A" rather than a blank entry that says nothing.
   */
  private refreshFilterColumns(): void {
    const select = this.toolbar.querySelector<HTMLSelectElement>('[data-filter="column"]');
    if (select === null) return;

    const box = this.selectionBox();
    const previous = select.value;
    clear(select);

    for (let column = box.left; column <= box.right; column += 1) {
      const header = this.workbook.read(this.sheetName, { column, row: box.top });
      const label =
        header === BLANK || isError(header)
          ? 'Column ' + columnName(column)
          : String(header);
      select.append(
        el('option', { value: String(column - box.left) }, [label]) as HTMLOptionElement,
      );
    }

    // The previous choice is kept when it still exists, so widening a selection
    // does not silently move the filter to a different column.
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    }
  }

  private clearFilter(): void {
    if (this.hiddenRows.size === 0) {
      this.setNote('No rows are hidden.');
      return;
    }
    const count = this.hiddenRows.size;
    this.hiddenRows = new Set();
    this.filterConditions = [];
    this.render();
    this.setNote(
      count + (count === 1 ? ' row is shown again.' : ' rows are shown again.') +
        ' Nothing was ever removed.',
    );
  }

  /**
   * Chart the selection.
   *
   * The first column is the categories and every other column is a series,
   * which is the arrangement a person selecting a table already has.
   */
  private drawChart(): void {
    const { rows } = this.selectedRows();
    if (rows.length < 2 || (rows[0]?.length ?? 0) < 2) {
      this.setNote('Select at least two columns and two rows to chart.');
      return;
    }

    const header = rows[0] as ScalarValue[];
    const body = rows.slice(1);
    const categories = body.map((row) => String(row[0] === BLANK ? '' : row[0]));

    const series = header.slice(1).map((name, index) => ({
      name: String(name === BLANK ? 'Series ' + (index + 1) : name),
      values: body.map((row) => row[index + 1] ?? BLANK),
      colour: seriesColour(index),
    }));

    const chart = renderChart({
      kind: 'bar',
      title: 'Selection',
      categories,
      series,
      width: 420,
      height: 260,
    });

    clear(this.chartHost);
    this.chartHost.hidden = false;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sheets__chart-svg');
    svg.setAttribute('viewBox', '0 0 420 260');
    svg.setAttribute('width', '420');
    svg.setAttribute('height', '260');
    // Named, because an SVG is invisible to a screen reader otherwise, and a
    // chart with no accessible name is a chart that does not exist for anybody
    // using one.
    svg.setAttribute('role', 'img');
    svg.setAttribute(
      'aria-label',
      'Bar chart of the selected range: ' + series.length +
        (series.length === 1 ? ' series over ' : ' series over ') +
        categories.length + ' categories',
    );

    for (const tick of chart.ticks) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(chart.plot.x));
      line.setAttribute('x2', String(chart.plot.x + chart.plot.width));
      line.setAttribute('y1', String(tick.y));
      line.setAttribute('y2', String(tick.y));
      line.setAttribute('class', 'sheets__chart-grid');
      svg.append(line);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(chart.plot.x - 6));
      label.setAttribute('y', String(tick.y + 4));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('class', 'sheets__chart-label');
      label.textContent = tick.label;
      svg.append(label);
    }

    for (const bar of chart.bars) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(bar.x));
      rect.setAttribute('y', String(bar.y));
      rect.setAttribute('width', String(Math.max(1, bar.width - 2)));
      rect.setAttribute('height', String(Math.max(0, bar.height)));
      rect.setAttribute('fill', bar.colour);
      rect.setAttribute('data-series', bar.series);
      rect.setAttribute('data-value', String(bar.value));
      svg.append(rect);
    }

    this.chartHost.append(svg);

    // What the chart does NOT show, said beside it. A gap plotted as zero
    // draws a crash that never happened, so the count of gaps is stated
    // rather than left to be inferred from a bar that is not there.
    const note = el('p', { class: 'sheets__chart-note' });
    note.textContent =
      chart.bars.length + (chart.bars.length === 1 ? ' bar' : ' bars') +
      (chart.gaps === 0
        ? '.'
        : ', and ' + chart.gaps +
          (chart.gaps === 1
            ? ' value was blank or an error and is not drawn.'
            : ' values were blank or errors and are not drawn.')) +
      (chart.axisNote === null ? ' The axis starts at zero.' : ' ' + chart.axisNote);
    this.chartHost.append(note);

    this.setNote('Charted ' + categories.length + ' categories.');
  }

  private clearSelection(): void {
    const box = normaliseRange({
      start: { ...this.selection.anchor, columnAbsolute: false, rowAbsolute: false },
      end: { ...this.selection.focus, columnAbsolute: false, rowAbsolute: false },
    });
    for (let row = box.top; row <= box.bottom; row += 1) {
      for (let column = box.left; column <= box.right; column += 1) {
        this.workbook.setCell(this.sheetName, { column, row }, '');
      }
    }
    this.options.onChange?.(this.workbook);
    this.render();
  }

  // ------------------------------------------------------ import / export --

  /**
   * Read a delimited file into the sheet.
   *
   * Values arrive as TYPED input rather than as text: a column of numbers
   * has to become numbers or nothing can be summed, which is the whole
   * reason somebody is importing rather than reading the file elsewhere.
   * That is the same classification a typed cell already goes through, so
   * it stays in setCell and is not reimplemented here.
   */
  private async importFile(file: File): Promise<void> {
    try {
      // Dispatch on the BYTES, not on the extension. A file named .csv
      // that is actually a zip is a spreadsheet somebody renamed, and
      // reading its binary as text produces a screen of mojibake rather
      // than an error anybody can act on.
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (looksLikeZip(head)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const format = await detectFormat(bytes);
        if (format === 'xlsx' || format === 'ods') {
          await this.importWorkbook(bytes, format);
          return;
        }
        // A zip that is a Word document, or something else entirely.
        // Naming what it actually is beats "could not read this file".
        this.setNote(
          'That file is ' + describeDetected(format) + ', which Sheets cannot open.',
        );
        return;
      }

      const text = await file.text();
      const result = readCsv(text);

      for (let row = 0; row < result.rows.length; row += 1) {
        const cells = result.rows[row] as readonly string[];
        for (let column = 0; column < cells.length; column += 1) {
          const raw = cells[column] as string;
          if (raw === '') continue;
          // A leading equals sign in imported data is DATA, not a formula.
          // Treating it as one would let a downloaded file run lookups
          // across the rest of the sheet the moment it is opened.
          const safe = raw.startsWith('=') ? "'" + raw : raw;
          this.workbook.setCell(this.sheetName, { column, row }, safe);
        }
      }

      const delimiterName =
        result.delimiter === '\t' ? 'tab' : result.delimiter;
      const warningPart =
        result.warnings.length > 0
          ? '. ' + result.warnings.length + ' warning(s): ' + result.warnings[0]
          : '';
      this.setNote(
        result.rows.length + ' rows imported, delimiter ' + delimiterName + warningPart,
      );
      this.options.onChange?.(this.workbook);
      this.render();
    } catch (error) {
      this.setNote('Import failed: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      // Cleared so choosing the same file twice fires a change event again.
      this.fileInput.value = '';
    }
  }

  /**
   * Read a workbook.
   *
   * A formula cell is written back as its FORMULA, so the engine
   * recomputes it and the sheet stays live. Writing the cached value
   * instead would turn every formula in the file into a literal the
   * moment it was opened, which is a silent and irreversible loss.
   */
  private async importWorkbook(bytes: Uint8Array, format: 'xlsx' | 'ods'): Promise<void> {
    const workbook = format === 'ods' ? await readOds(bytes) : await readXlsx(bytes);
    const sheet = workbook.sheets[0];
    if (sheet === undefined) {
      this.setNote('That workbook contains no sheets.');
      return;
    }

    for (const cell of sheet.cells) {
      const input =
        cell.formula !== undefined
          ? '=' + cell.formula
          : cell.isText === true && typeof cell.value === 'string'
            ? forceTextIfFormulaLike(cell.value)
            : cell.value === undefined
              ? ''
              : String(cell.value);
      if (input === '') continue;
      this.workbook.setCell(this.sheetName, { column: cell.column, row: cell.row }, input);
    }

    this.setNote(
      'Imported ' +
        sheet.cells.length +
        ' cells from the sheet named ' +
        sheet.name +
        (workbook.sheets.length > 1
          ? '. This file has ' + workbook.sheets.length + ' sheets; only the first was read.'
          : '.'),
    );
    this.options.onChange?.(this.workbook);
    this.render();
  }

  private exportWorkbook(format: 'xlsx' | 'ods'): void {
    const cells: XlsxCell[] = [];
    for (const entry of this.workbook.entries(this.sheetName)) {
      const value = this.workbook.read(this.sheetName, entry.address);
      const formula =
        entry.cell.formula !== undefined ? entry.cell.input.slice(1) : undefined;
      const base = { column: entry.address.column, row: entry.address.row };

      if (formula !== undefined) {
        cells.push({
          ...base,
          formula,
          ...(typeof value === 'number' || typeof value === 'boolean'
            ? { value }
            : {}),
        });
        continue;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        cells.push({ ...base, value });
      } else if (typeof value === 'string') {
        cells.push({ ...base, value, isText: true });
      }
    }

    if (cells.length === 0) {
      this.setNote('Nothing to export \u2014 the sheet is empty.');
      return;
    }

    const workbook = { sheets: [{ name: this.sheetName, cells }] };
    const isOds = format === 'ods';
    const bytes = isOds ? writeOds(workbook) : writeXlsx(workbook);
    const blob = new Blob([bytes as BlobPart], {
      type: isOds
        ? 'application/vnd.oasis.opendocument.spreadsheet'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', {
      href: url,
      download: this.sheetName + (isOds ? '.ods' : '.xlsx'),
    }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);

    this.setNote(
      'Exported ' +
        cells.length +
        ' cells as ' +
        (isOds ? 'an OpenDocument spreadsheet' : 'an Excel workbook') +
        '. Formulas are kept' +
        (isOds ? ', translated to the OpenDocument syntax' : '') +
        '. This format does not carry: cell formatting; column widths.',
    );
  }

  /** Every cell in the used region, in the shape the export layer wants. */
  private tableCells(): TableCell[][] {
    let lastColumn = 0;
    let lastRow = 0;
    let any = false;
    for (const entry of this.workbook.entries(this.sheetName)) {
      any = true;
      if (entry.address.column > lastColumn) lastColumn = entry.address.column;
      if (entry.address.row > lastRow) lastRow = entry.address.row;
    }
    if (!any) return [];

    const rows: TableCell[][] = [];
    for (let row = 0; row <= lastRow; row += 1) {
      const cells: TableCell[] = [];
      for (let column = 0; column <= lastColumn; column += 1) {
        const value = this.workbook.read(this.sheetName, { column, row });
        const cell = this.workbook.getCell(this.sheetName, { column, row });
        cells.push({
          text: displayValue(value),
          value: isError(value) || value === BLANK ? null : value,
          ...(cell?.formula !== undefined ? { formula: cell.input } : {}),
        });
      }
      rows.push(cells);
    }
    return rows;
  }

  private exportAs(format: TableFormat): void {
    const description = describeFormat(format);
    const rows = this.tableCells();
    if (rows.length === 0) {
      this.setNote('Nothing to export \u2014 the sheet is empty.');
      return;
    }

    const text = exportTable(rows, { format, name: this.sheetName });
    const blob = new Blob([text], { type: description.mediaType + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', {
      href: url,
      download: this.sheetName + description.extension,
    }) as HTMLAnchorElement;
    anchor.click();
    // Revoked on the next turn. Revoking immediately can beat the download
    // in some builds, which produces an empty file and no error at all.
    setTimeout(() => URL.revokeObjectURL(url), 0);

    this.setNote(
      'Exported ' +
        rows.length +
        ' rows as ' +
        description.label +
        (description.losses.length === 0
          ? '. Nothing was lost.'
          : '. This format does not carry: ' + description.losses.join('; ') + '.'),
    );
  }

  private setNote(message: string): void {
    clear(this.lossNote);
    this.lossNote.append(message);
    this.lossNote.setAttribute('data-shown', message === '' ? 'false' : 'true');
  }

  // ----------------------------------------------------------- rendering --

  private render(): void {
    const scrollTop = this.scroller.scrollTop;
    const scrollLeft = this.scroller.scrollLeft;
    const height = this.scroller.clientHeight || 400;
    const width = this.scroller.clientWidth || 600;

    const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastRow = Math.min(
      VISIBLE_ROWS - 1,
      Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
    );
    const firstColumn = Math.max(0, this.columnAt(scrollLeft) - OVERSCAN);
    const lastColumn = Math.min(
      VISIBLE_COLUMNS - 1,
      this.columnAt(scrollLeft + width) + OVERSCAN + 1,
    );

    this.renderColumnHeader(firstColumn, lastColumn, scrollLeft);
    this.renderRowHeader(firstRow, lastRow, scrollTop);
    this.renderCells(firstRow, lastRow, firstColumn, lastColumn);
    this.renderBar();
  }


  /** The width of one column, honouring whatever the user has set. */
  private widthOf(column: number): number {
    return this.columnWidths.get(column) ?? DEFAULT_COLUMN_WIDTH;
  }

  /**
   * The x position of a column's left edge.
   *
   * Summed rather than multiplied. Multiplying by a constant is correct only
   * while every column is the same width, and the moment one is not, every
   * column to its right is drawn in the wrong place - headers and cells drift
   * apart, and the grid looks like a rendering fault rather than a sizing one.
   */
  private leftOf(column: number): number {
    let left = 0;
    for (let index = 0; index < column; index += 1) left += this.widthOf(index);
    return left;
  }

  /** The column containing an x position, and the total width of the sheet. */
  private columnAt(x: number): number {
    let left = 0;
    for (let column = 0; column < VISIBLE_COLUMNS; column += 1) {
      const width = this.widthOf(column);
      if (x < left + width) return column;
      left += width;
    }
    return VISIBLE_COLUMNS - 1;
  }

  private totalWidth(): number {
    return this.leftOf(VISIBLE_COLUMNS);
  }

  /**
   * Set one column's width, bounded.
   *
   * Bounded here rather than at the drag handler, so a width arriving from a
   * restored profile or a keyboard step is clamped by the same rule as one
   * arriving from a pointer.
   */
  setColumnWidth(column: number, width: number): void {
    const bounded = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
    if (bounded === DEFAULT_COLUMN_WIDTH) this.columnWidths.delete(column);
    else this.columnWidths.set(column, bounded);
    this.options.onColumnWidths?.(Object.fromEntries(this.columnWidths));
    this.render();
  }

  /** The format for a column, defaulting to general. */
  private formatOf(column: number): NumberFormat {
    return this.columnFormats.get(column) ?? GENERAL;
  }

  private setColumnFormat(column: number, format: NumberFormat): void {
    if (format.kind === 'general') this.columnFormats.delete(column);
    else this.columnFormats.set(column, format);
    this.options.onColumnFormats?.(Object.fromEntries(this.columnFormats));
    this.render();

    // Whether the column now shows fewer decimals than it holds is SAID, not
    // discovered: a column shown to two places whose values hold six will not
    // add up to its own displayed total, and somebody who finds that without
    // being told concludes the arithmetic is broken.
    const rounded = this.columnValues(column).some((value) =>
      roundsForDisplay(value, format),
    );
    this.setStatus(
      'Column ' + columnName(column) + ': ' + describeNumberFormat(format) + '.' +
        (rounded
          ? ' Some values hold more decimals than are shown, so this column will not add up to its own displayed total. The stored values are unchanged.'
          : ''),
    );
  }

  /** Every value in a column, over the rows that hold anything. */
  private columnValues(column: number): ScalarValue[] {
    const out: ScalarValue[] = [];
    for (let row = 0; row < this.usedRows(); row += 1) {
      const value = this.workbook.read(this.sheetName, { column, row });
      out.push(value);
    }
    return out;
  }

  /**
   * Tick the header box when the sheet looks like it has one.
   *
   * A SUGGESTION, not a decision: the box is visible and the user can clear it.
   * Once they have touched it their choice stands, because a control that
   * keeps re-deciding for you is worse than one that never helps.
   */
  private suggestHeader(): void {
    if (this.headerTouched) return;
    const rows = this.usedRows();
    if (rows < 2) return;

    let textAcross = false;
    let numbersBelow = false;
    for (let column = 0; column < VISIBLE_COLUMNS; column += 1) {
      const first = this.workbook.read(this.sheetName, { column, row: 0 });
      if (typeof first === 'string' && first !== '') textAcross = true;
      else if (typeof first === 'number') return; // a number in the top row is data
      for (let row = 1; row < rows; row += 1) {
        if (typeof this.workbook.read(this.sheetName, { column, row }) === 'number') {
          numbersBelow = true;
          break;
        }
      }
    }
    this.headerToggle.checked = textAcross && numbersBelow;
  }

  /** How many rows hold anything at all, so a sort knows where to stop. */
  private usedRows(): number {
    let last = -1;
    for (let row = 0; row < VISIBLE_ROWS; row += 1) {
      for (let column = 0; column < VISIBLE_COLUMNS; column += 1) {
        const cell = this.workbook.getCell(this.sheetName, { column, row });
        if (cell !== undefined && cell.input !== '') {
          last = row;
          break;
        }
      }
    }
    return last + 1;
  }

  /**
   * Sort the used rows by the focused column.
   *
   * WHOLE ROWS. Sorting a single column in place detaches every value from the
   * row it was entered against, and nothing about the result looks wrong -
   * which is why the engine hands back an order rather than sorted values.
   */
  private sortByColumn(direction: Direction): void {
    const column = this.selection.focus.column;
    const rows = this.usedRows();
    if (rows < 2) {
      this.setStatus('There is nothing to sort yet.');
      return;
    }

    // A header row is not data, and whether the first row is one is the user's
    // to say. The box is TICKED for them when the sheet looks like it has one -
    // a first row of text over columns that hold numbers below - but it stays a
    // control they can see and change, because a guess made silently is a guess
    // nobody can correct, and getting it wrong sorts a heading into the middle
    // of the data.
    this.suggestHeader();
    const hasHeader = this.headerToggle.checked;
    const start = hasHeader ? 1 : 0;

    const cells: { address: string; input: string }[] = [];
    for (let row = start; row < rows; row += 1) {
      for (let index = 0; index < VISIBLE_COLUMNS; index += 1) {
        const cell = this.workbook.getCell(this.sheetName, { column: index, row });
        if (cell !== undefined && cell.input !== '') {
          cells.push({ address: columnName(index) + (row + 1), input: cell.input });
        }
      }
    }

    const blocked = formulasBlocking(cells);
    if (blocked !== null) {
      this.setStatus(blocked.reason);
      return;
    }

    const width = Math.max(
      1,
      ...cells.map((cell) => {
        const letters = /^[A-Z]+/.exec(cell.address)?.[0] ?? 'A';
        return letters.length === 1
          ? (letters.charCodeAt(0) - 64)
          : VISIBLE_COLUMNS;
      }),
    );

    const table = [];
    for (let row = start; row < rows; row += 1) {
      const values = [];
      for (let index = 0; index < width; index += 1) {
        values.push(this.workbook.read(this.sheetName, { column: index, row }));
      }
      table.push({ index: row, values });
    }

    const result = sortRows({ rows: table, column, direction });
    if (!result.ok) {
      this.setStatus(result.reason);
      return;
    }

    // Read every row's INPUTS first, then write them all back. Writing as we
    // go would overwrite a row that has not been read yet.
    const inputs = table.map((row) => {
      const line: string[] = [];
      for (let index = 0; index < width; index += 1) {
        line.push(
          this.workbook.getCell(this.sheetName, { column: index, row: row.index })?.input ?? '',
        );
      }
      return line;
    });
    const byIndex = new Map(table.map((row, position) => [row.index, position]));

    result.order.forEach((sourceRow, position) => {
      const source = inputs[byIndex.get(sourceRow) ?? 0] ?? [];
      for (let index = 0; index < width; index += 1) {
        this.workbook.setCell(
          this.sheetName,
          { column: index, row: start + position },
          source[index] ?? '',
        );
      }
    });

    this.sortedColumn = column;
    this.sortDirection = direction;
    this.options.onChange?.(this.workbook);
    this.render();
    this.setStatus(
      'Sorted by column ' + columnName(column) + ', ' + direction + '. ' + result.summary +
        (hasHeader
          ? ' The first row was kept as a header.'
          : ' Every row was sorted, including the first - clear that if row one is a heading.'),
    );
  }

  private stepWidth(by: number): void {
    const column = this.selection.focus.column;
    this.setColumnWidth(column, this.widthOf(column) + by);
    this.setStatus(
      'Column ' + columnName(column) + ' is now ' + this.widthOf(column) + ' pixels wide.',
    );
  }

  /**
   * Fit a column to its longest value.
   *
   * Measured from the FORMATTED text, because that is what has to fit. Fitting
   * to the stored value makes a currency column one character too narrow, for
   * every row, for ever.
   */
  private fitColumn(): void {
    const column = this.selection.focus.column;
    const format = this.formatOf(column);
    const longest = this.columnValues(column).reduce<number>(
      (most, value) => Math.max(most, formatValue(value, format).length),
      columnName(column).length,
    );
    this.setColumnWidth(column, longest * 8 + 20);
    this.setStatus(
      'Column ' + columnName(column) + ' fitted to its longest value, ' +
        this.widthOf(column) + ' pixels.',
    );
  }

  private renderColumnHeader(first: number, last: number, scrollLeft: number): void {
    clear(this.columnHeader);
    const box = this.selectionBox();
    const track = el('div', {
      class: 'sheets__header-track',
      style: 'transform:translateX(' + -scrollLeft + 'px)',
    });
    for (let column = first; column <= last; column += 1) {
      track.append(
        el(
          'div',
          {
            class: 'sheets__column-cell',
            role: 'columnheader',
            'data-selected': column >= box.left && column <= box.right ? 'true' : 'false',
            // Which column the last sort used, and which way. Without it a
            // sorted sheet is indistinguishable from one that arrived in that
            // order, and nobody can tell whether their sort ran.
            'data-sorted':
              column === this.sortedColumn
                ? this.sortDirection === 'ascending'
                  ? 'up'
                  : 'down'
                : 'no',
            style:
              'left:' + this.leftOf(column) + 'px;width:' + this.widthOf(column) + 'px',
          },
          [
            columnName(column) +
              (column === this.sortedColumn
                ? this.sortDirection === 'ascending'
                  ? ' ↑'
                  : ' ↓'
                : ''),
            // The grab handle. Its own element rather than a border, because a
            // border cannot receive a pointer and cannot carry an accessible
            // name - and a resize that only works by mouse is a column
            // somebody cannot read.
            el('span', {
              class: 'sheets__resize',
              'data-resize': String(column),
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': 'Resize column ' + columnName(column),
              title: 'Drag to resize, or double-click to fit the longest value',
            }),
          ],
        ),
      );
    }
    this.columnHeader.append(track);
  }

  private renderRowHeader(first: number, last: number, scrollTop: number): void {
    clear(this.rowHeader);
    const box = this.selectionBox();
    const track = el('div', {
      class: 'sheets__header-track',
      style: 'transform:translateY(' + -scrollTop + 'px)',
    });
    for (let row = first; row <= last; row += 1) {
      track.append(
        el(
          'div',
          {
            class: 'sheets__row-cell',
            role: 'rowheader',
            'data-selected': row >= box.top && row <= box.bottom ? 'true' : 'false',
            style: 'top:' + row * ROW_HEIGHT + 'px;height:' + ROW_HEIGHT + 'px',
          },
          [String(row + 1)],
        ),
      );
    }
    this.rowHeader.append(track);
  }

  private renderCells(
    firstRow: number,
    lastRow: number,
    firstColumn: number,
    lastColumn: number,
  ): void {
    clear(this.canvasHost);
    const box = this.selectionBox();
    const focus = this.selection.focus;

    for (let row = firstRow; row <= lastRow; row += 1) {
      // A hidden row is not drawn. It is still in the workbook, untouched -
      // the filter hides, it never removes - and clearing the filter brings
      // every one of them straight back.
      if (this.hiddenRows.has(row)) continue;

      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const value = this.workbook.read(this.sheetName, { column, row });
        const cell = this.workbook.getCell(this.sheetName, { column, row });
        const selected =
          row >= box.top && row <= box.bottom && column >= box.left && column <= box.right;
        const isFocus = row === focus.row && column === focus.column;

        // Blank cells inside the viewport still get a node, because the grid
        // lines are drawn by the cell borders. Skipping them would leave holes
        // in the ruling that look like a rendering fault.
        const node = el(
          'div',
          {
            class: 'sheets__cell',
            role: 'gridcell',
            'data-address': columnName(column) + (row + 1),
            'data-selected': selected ? 'true' : 'false',
            'data-focused': isFocus ? 'true' : 'false',
            'data-kind': valueKind(value),
            'aria-selected': selected ? 'true' : 'false',
            style:
              'left:' +
              this.leftOf(column) +
              'px;top:' +
              row * ROW_HEIGHT +
              'px;width:' +
              this.widthOf(column) +
              'px;height:' +
              ROW_HEIGHT +
              'px',
            title: cell?.parseError ?? '',
            // The format reaches the RENDERED cell. A format stored and never
            // read is the wired-at-one-end defect: the picker changes, the
            // status line agrees, and the grid shows exactly what it did
            // before.
            'data-format': this.formatOf(column).kind,
          },
          [
            this.columnFormats.has(column)
              ? formatValue(value, this.formatOf(column))
              : displayValue(value),
          ],
        );
        this.canvasHost.append(node);
      }
    }
  }

  private renderBar(): void {
    const focus = this.selection.focus;
    clear(this.addressLabel);
    this.addressLabel.append(
      formatReference({ ...focus, columnAbsolute: false, rowAbsolute: false }),
    );

    // Never overwrite the formula bar while the user is typing in it.
    if (document.activeElement !== this.formulaInput) {
      this.formulaInput.value = this.currentInput();
    }

    // The filter's column list follows the selection, so it always offers the
    // columns the person is actually looking at.
    this.refreshFilterColumns();

    const box = this.selectionBox();
    const cellCount = (box.bottom - box.top + 1) * (box.right - box.left + 1);
    const summary = this.summarise(box);

    clear(this.statusLabel);
    this.statusLabel.append(
      cellCount === 1
        ? 'Cell ' + formatReference({ ...focus, columnAbsolute: false, rowAbsolute: false })
        : cellCount + ' cells selected',
      summary === '' ? '' : '   ' + summary,
      this.note === '' ? '' : '   ' + this.note,
    );
  }

  private setStatus(message: string): void {
    this.note = message;
    this.renderBar();
  }

  /**
   * The status-bar aggregates.
   *
   * Bounded: a selection of ten thousand cells is summarised, a selection of
   * a whole column is not, because summing a million cells on every arrow key
   * would make the grid unusable to serve a number nobody asked for.
   */
  private summarise(box: {
    top: number;
    left: number;
    bottom: number;
    right: number;
  }): string {
    const cellCount = (box.bottom - box.top + 1) * (box.right - box.left + 1);
    if (cellCount <= 1 || cellCount > 10000) return '';
    let sum = 0;
    let numbers = 0;
    let filled = 0;
    for (let row = box.top; row <= box.bottom; row += 1) {
      for (let column = box.left; column <= box.right; column += 1) {
        const value = this.workbook.read(this.sheetName, { column, row });
        if (value === BLANK) continue;
        filled += 1;
        if (typeof value === 'number') {
          sum += value;
          numbers += 1;
        }
      }
    }
    if (numbers === 0) return filled === 0 ? '' : 'Count ' + filled;
    return (
      'Sum ' +
      formatNumberForText(sum) +
      '   Average ' +
      formatNumberForText(sum / numbers) +
      '   Count ' +
      filled
    );
  }

  /**
   * The bottom-right corner of the region that actually holds data.
   *
   * Derived from the cells that exist rather than from the grid bounds, so
   * Ctrl+End lands on the end of the user's data instead of on row twenty
   * thousand of an empty sheet.
   */
  private lastUsedCell(): CellAddress {
    let column = 0;
    let row = 0;
    for (const entry of this.workbook.entries(this.sheetName)) {
      if (entry.address.column > column) column = entry.address.column;
      if (entry.address.row > row) row = entry.address.row;
    }
    return { column, row };
  }

  private selectionBox(): { top: number; left: number; bottom: number; right: number } {
    return normaliseRange({
      start: { ...this.selection.anchor, columnAbsolute: false, rowAbsolute: false },
      end: { ...this.selection.focus, columnAbsolute: false, rowAbsolute: false },
    });
  }
}

/**
 * Imported text that begins with an equals sign stays text.
 *
 * Same rule as the CSV path: a downloaded workbook must not become a live
 * formula the moment it is opened. A leading apostrophe is how this sheet
 * model spells "this is literally text".
 */
function forceTextIfFormulaLike(value: string): string {
  return value.startsWith('=') ? "'" + value : value;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function valueKind(value: ScalarValue): string {
  if (isError(value)) return 'error';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === BLANK) return 'blank';
  return 'text';
}

/**
 * What a cell shows.
 *
 * Numbers are right-aligned by the stylesheet reading data-kind, which is why
 * the kind is an attribute rather than a class: alignment is a property of the
 * VALUE, and a text cell that happens to contain digits must stay left-aligned
 * so the difference between a number and text that looks like one is visible
 * without clicking it.
 */
function displayValue(value: ScalarValue): string {
  if (value === BLANK) return '';
  if (isError(value)) return '#' + value.error + (value.error.endsWith('?') ? '' : '!');
  if (typeof value === 'number') return formatNumberForText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
}
