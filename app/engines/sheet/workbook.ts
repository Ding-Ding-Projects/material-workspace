/**
 * The workbook: sheets, cells, the dependency graph, and recalculation.
 *
 * The design decision that matters here is INCREMENTAL recalculation. A
 * spreadsheet that recomputes every formula on every keystroke is unusable
 * past a few thousand rows, and the naive fix — recompute the edited cell and
 * whatever it feeds — is wrong, because a dependent may itself depend on
 * something that has not been recomputed yet and would read a stale value.
 *
 * So: edits mark a cell dirty, dirtiness spreads forward through the
 * dependents, and the dirty set is evaluated in dependency order. Nothing is
 * evaluated twice and nothing reads a stale input.
 *
 * CYCLES ARE DETECTED, NOT PREVENTED. A user may legitimately type a formula
 * that closes a cycle, and the answer is a circular-reference error in every
 * cell of the cycle — never a hang, never a stack overflow, and never a
 * partial answer computed from whichever cell happened to be visited first.
 */

import {
  type CellAddress,
  type CellReference,
  addressKey,
  iterateRange,
  rangeSize,
} from './reference';
import {
  type Node,
  FormulaError,
  collectReferences,
  parseFormula,
} from './parser';
import {
  BLANK,
  CIRCULAR_ERROR,
  type ScalarValue,
  VALUE_ERROR,
  type Value,
  isError,
  toScalar,
} from './values';
import { MAX_RANGE_CELLS, evaluate } from './evaluate';

export interface Cell {
  /** The text the user typed. A formula keeps its leading equals sign. */
  readonly input: string;
  /** Parsed once at write time, not at every recalculation. */
  readonly formula?: Node;
  /** A literal cell's own value; a formula cell's last computed value. */
  value: ScalarValue;
  /** Set when the formula failed to parse, so the cell can say why. */
  readonly parseError?: string;
}

export interface Sheet {
  readonly name: string;
  readonly cells: Map<string, Cell>;
}

interface GraphNode {
  /** Keys this cell reads. */
  readonly precedents: Set<string>;
  /** Keys that read this cell. */
  readonly dependents: Set<string>;
}

export class Workbook {
  private readonly sheets = new Map<string, Sheet>();
  private readonly graph = new Map<string, GraphNode>();
  private readonly dirty = new Set<string>();

  /**
   * Ranges are indexed by sheet so a write can find the formulas that read a
   * range covering it WITHOUT walking every formula in the workbook. Without
   * this index, a workbook with n formulas costs O(n) per keystroke just to
   * discover what to recompute.
   */
  private readonly rangeReaders = new Map<string, Set<string>>();

  constructor(sheetNames: readonly string[] = ['Sheet1']) {
    for (const name of sheetNames) this.addSheet(name);
  }

  addSheet(name: string): Sheet {
    const existing = this.sheets.get(name);
    if (existing) return existing;
    const sheet: Sheet = { name, cells: new Map() };
    this.sheets.set(name, sheet);
    return sheet;
  }

  sheetNames(): string[] {
    return [...this.sheets.keys()];
  }

  getCell(sheetName: string, address: CellAddress): Cell | undefined {
    return this.sheets.get(sheetName)?.cells.get(cellKey(address));
  }

  /** The computed value, which is what a renderer draws. */
  read(sheetName: string, address: CellAddress): ScalarValue {
    const cell = this.getCell(sheetName, address);
    return cell === undefined ? BLANK : cell.value;
  }

  /**
   * Write a cell and recalculate everything that depends on it.
   *
   * The input is classified here rather than by the caller, because "does a
   * leading equals sign make this a formula" is a property of the sheet model
   * and every caller getting it independently right is not a plan.
   */
  setCell(sheetName: string, address: CellAddress, input: string): void {
    const sheet = this.addSheet(sheetName);
    const key = addressKey(sheetName, address);
    const local = cellKey(address);

    this.clearPrecedents(key);

    if (input === '') {
      sheet.cells.delete(local);
      this.markDependentsDirty(key);
      this.recalculate();
      return;
    }

    if (input.startsWith('=')) {
      let formula: Node | undefined;
      let parseError: string | undefined;
      try {
        formula = parseFormula(input.slice(1));
      } catch (error) {
        parseError =
          error instanceof FormulaError
            ? error.message + ' at position ' + error.position
            : String(error);
      }

      if (formula === undefined) {
        // A formula that will not parse keeps its text so the user can fix it,
        // and shows a value error rather than silently becoming a text cell.
        sheet.cells.set(local, { input, value: VALUE_ERROR, parseError });
      } else {
        sheet.cells.set(local, { input, formula, value: BLANK });
        this.recordPrecedents(sheetName, key, formula);
      }
    } else {
      sheet.cells.set(local, { input, value: parseLiteral(input) });
    }

    this.dirty.add(key);
    this.markDependentsDirty(key);
    this.recalculate();
  }

  /** Every cell currently holding a value, for rendering and for export. */
  *entries(sheetName: string): Generator<{ address: CellAddress; cell: Cell }> {
    const sheet = this.sheets.get(sheetName);
    if (sheet === undefined) return;
    for (const [key, cell] of sheet.cells) {
      const separator = key.indexOf(':');
      yield {
        address: {
          column: Number(key.slice(0, separator)),
          row: Number(key.slice(separator + 1)),
        },
        cell,
      };
    }
  }

  // ------------------------------------------------------------- the graph --

  private node(key: string): GraphNode {
    let existing = this.graph.get(key);
    if (existing === undefined) {
      existing = { precedents: new Set(), dependents: new Set() };
      this.graph.set(key, existing);
    }
    return existing;
  }

  private clearPrecedents(key: string): void {
    const node = this.graph.get(key);
    if (node === undefined) return;
    for (const precedent of node.precedents) {
      this.graph.get(precedent)?.dependents.delete(key);
    }
    node.precedents.clear();
    for (const readers of this.rangeReaders.values()) readers.delete(key);
  }

  private recordPrecedents(sheetName: string, key: string, formula: Node): void {
    const { cells, ranges } = collectReferences(formula);
    const node = this.node(key);

    for (const reference of cells) {
      const target = addressKey(reference.sheet ?? sheetName, reference);
      node.precedents.add(target);
      this.node(target).dependents.add(key);
    }

    for (const range of ranges) {
      const rangeSheet = range.start.sheet ?? sheetName;
      // A range is registered cell by cell only while it is small. Past the
      // threshold it is registered against the sheet instead, and a write to
      // that sheet dirties it. Registering a million cells individually would
      // cost more memory than the data itself.
      if (rangeSize(range) <= RANGE_EXPANSION_LIMIT) {
        for (const address of iterateRange(range)) {
          const target = addressKey(rangeSheet, address);
          node.precedents.add(target);
          this.node(target).dependents.add(key);
        }
      } else {
        let readers = this.rangeReaders.get(rangeSheet);
        if (readers === undefined) {
          readers = new Set();
          this.rangeReaders.set(rangeSheet, readers);
        }
        readers.add(key);
      }
    }
  }

  private markDependentsDirty(key: string): void {
    const stack = [key];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const dependent of this.graph.get(current)?.dependents ?? []) {
        if (this.dirty.has(dependent) && seen.has(dependent)) continue;
        this.dirty.add(dependent);
        stack.push(dependent);
      }
    }

    // Whole-sheet range readers cannot be resolved cell by cell, so any write
    // to a sheet dirties every formula holding a large range over it.
    const sheetName = key.slice(0, key.indexOf(KEY_SEPARATOR));
    for (const reader of this.rangeReaders.get(sheetName) ?? []) {
      this.dirty.add(reader);
    }
  }

  // ------------------------------------------------------- recalculation --

  /**
   * Evaluate the dirty set in dependency order.
   *
   * Iterative depth-first, not recursion. A deep chain of dependencies is
   * entirely ordinary in a real sheet, and recursion would blow the stack on
   * a column of formulas each referring to the one above.
   */
  private recalculate(): void {
    if (this.dirty.size === 0) return;

    const pending = new Set(this.dirty);
    this.dirty.clear();

    const state = new Map<string, 'visiting' | 'done'>();
    const circular = new Set<string>();

    for (const start of pending) {
      if (state.get(start) === 'done') continue;

      // Explicit stack. Each frame remembers which precedent it is up to, so
      // the walk can resume after descending.
      const stack: { key: string; index: number; list: string[] }[] = [
        { key: start, index: 0, list: [...(this.graph.get(start)?.precedents ?? [])] },
      ];
      state.set(start, 'visiting');

      while (stack.length > 0) {
        const frame = stack[stack.length - 1] as { key: string; index: number; list: string[] };

        if (frame.index < frame.list.length) {
          const next = frame.list[frame.index] as string;
          frame.index += 1;

          if (state.get(next) === 'visiting') {
            // Every cell currently on the stack is part of the cycle.
            for (const entry of stack) circular.add(entry.key);
            circular.add(next);
            continue;
          }
          if (state.get(next) === 'done') continue;
          if (!pending.has(next) && !this.isFormula(next)) {
            state.set(next, 'done');
            continue;
          }

          state.set(next, 'visiting');
          stack.push({
            key: next,
            index: 0,
            list: [...(this.graph.get(next)?.precedents ?? [])],
          });
          continue;
        }

        stack.pop();
        state.set(frame.key, 'done');
        if (!circular.has(frame.key)) this.evaluateCell(frame.key);
      }
    }

    // Every cell in a cycle reports the circular error. Reporting it on one
    // arbitrary member and computing the rest would produce numbers that look
    // fine and depend on visit order.
    for (const key of circular) {
      const located = this.locate(key);
      if (located === undefined) continue;
      const cell = located.sheet.cells.get(cellKey(located.address));
      if (cell !== undefined) cell.value = CIRCULAR_ERROR;
    }
  }

  private isFormula(key: string): boolean {
    const located = this.locate(key);
    if (located === undefined) return false;
    return located.sheet.cells.get(cellKey(located.address))?.formula !== undefined;
  }

  private evaluateCell(key: string): void {
    const located = this.locate(key);
    if (located === undefined) return;
    const cell = located.sheet.cells.get(cellKey(located.address));
    if (cell === undefined || cell.formula === undefined) return;

    const result: Value = evaluate(cell.formula, {
      currentSheet: located.sheet.name,
      readCell: (sheetName, address) => this.read(sheetName, address),
    });

    // A formula producing a matrix shows its top-left cell. Spilling a result
    // across neighbouring cells is a separate feature with its own conflict
    // rules, and pretending to support it by writing over the neighbours would
    // destroy data.
    cell.value = toScalar(result);
    if (isError(cell.value)) return;
  }

  private locate(key: string): { sheet: Sheet; address: CellAddress } | undefined {
    const first = key.indexOf(KEY_SEPARATOR);
    const second = key.indexOf(KEY_SEPARATOR, first + 1);
    if (first < 0 || second < 0) return undefined;
    const sheet = this.sheets.get(key.slice(0, first));
    if (sheet === undefined) return undefined;
    return {
      sheet,
      address: {
        column: Number(key.slice(first + 1, second)),
        row: Number(key.slice(second + 1)),
      },
    };
  }
}

/**
 * Above this size a range is tracked against its sheet rather than cell by
 * cell. Chosen so an ordinary table registers precisely and a whole-column
 * reference does not allocate a million graph entries.
 */
const RANGE_EXPANSION_LIMIT = 4096;

const KEY_SEPARATOR = String.fromCharCode(0);

function cellKey(address: CellAddress): string {
  return address.column + ':' + address.row;
}

/**
 * Classify typed text that is not a formula.
 *
 * Numbers and booleans are recognised; everything else stays text. A leading
 * apostrophe forces text, which is how somebody enters a value that would
 * otherwise be read as a number — a part code, a phone number with a leading
 * zero, a version string.
 */
export function parseLiteral(input: string): ScalarValue {
  if (input.startsWith("'")) return input.slice(1);

  const trimmed = input.trim();
  if (trimmed.length === 0) return input;

  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;

  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    // A number that will not round-trip is kept as text. Otherwise a long
    // account number silently loses its last digits to double precision and
    // the cell shows a different number from the one that was typed.
    if (String(value) === trimmed || Number.isSafeInteger(value) || !Number.isInteger(value)) {
      return value;
    }
    return input;
  }

  const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*%$/.exec(trimmed);
  if (percent && percent[1] !== undefined) return Number(percent[1]) / 100;

  return input;
}

export type { CellReference };
export { MAX_RANGE_CELLS };
