/**
 * The expression evaluator.
 *
 * It walks the AST and knows nothing about recalculation order — that belongs
 * to the graph. What it needs from the outside is one thing: how to read a
 * cell. Injecting that keeps the evaluator testable against a plain object and
 * keeps the graph free to decide what "read" means during a recalculation.
 */

import {
  type BinaryOperator,
  type Node,
} from './parser';
import {
  type CellAddress,
  type CellReference,
  type RangeReference,
  normaliseRange,
  rangeSize,
} from './reference';
import {
  BLANK,
  DIV_ZERO,
  NAME_ERROR,
  NUMBER_ERROR,
  type ScalarValue,
  VALUE_ERROR,
  type Value,
  compareValues,
  isError,
  isMatrix,
  matrix,
  toNumber,
  toScalar,
  toText,
} from './values';
import { lookupFunction } from './functions';

/**
 * A range wider than this is refused rather than materialised.
 *
 * A whole-column reference in a sheet with a million rows is a perfectly
 * ordinary thing to type and would otherwise allocate a million-element array
 * per evaluation. The bound is generous enough for real data and small enough
 * that a typo cannot take the application down.
 */
export const MAX_RANGE_CELLS = 1_048_576;

export interface EvaluationHost {
  /** The sheet a formula lives on, used to resolve unqualified references. */
  readonly currentSheet: string;
  readonly readCell: (sheet: string, address: CellAddress) => ScalarValue;
  /** Defined names. Returning undefined produces a name error. */
  readonly readName?: (name: string) => Value | undefined;
}

export function evaluate(node: Node, host: EvaluationHost): Value {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'error':
      return { kind: 'error', error: node.error };
    case 'reference':
      return readReference(node.reference, host);
    case 'range':
      return readRange(node.range, host);
    case 'name': {
      const value = host.readName?.(node.name);
      return value === undefined ? NAME_ERROR : value;
    }
    case 'unary': {
      const operand = toScalar(evaluate(node.operand, host));
      if (isError(operand)) return operand;
      const asNumber = toNumber(operand);
      if (isError(asNumber)) return asNumber;
      return node.operator === '-' ? -asNumber : asNumber;
    }
    case 'percent': {
      const operand = toScalar(evaluate(node.operand, host));
      if (isError(operand)) return operand;
      const asNumber = toNumber(operand);
      if (isError(asNumber)) return asNumber;
      return asNumber / 100;
    }
    case 'binary':
      return evaluateBinary(node.operator, node.left, node.right, host);
    case 'array': {
      const rows = node.rows.length;
      const columns = node.rows[0]?.length ?? 0;
      const values: ScalarValue[] = [];
      for (const row of node.rows) {
        for (const item of row) values.push(toScalar(evaluate(item, host)));
      }
      return matrix(rows, columns, values);
    }
    case 'call':
      return evaluateCall(node, host);
    default:
      return VALUE_ERROR;
  }
}

function readReference(reference: CellReference, host: EvaluationHost): ScalarValue {
  return host.readCell(reference.sheet ?? host.currentSheet, {
    column: reference.column,
    row: reference.row,
  });
}

function readRange(range: RangeReference, host: EvaluationHost): Value {
  if (rangeSize(range) > MAX_RANGE_CELLS) return VALUE_ERROR;
  const box = normaliseRange(range);
  const sheet = range.start.sheet ?? host.currentSheet;
  const values: ScalarValue[] = [];
  for (let row = box.top; row <= box.bottom; row += 1) {
    for (let column = box.left; column <= box.right; column += 1) {
      values.push(host.readCell(sheet, { column, row }));
    }
  }
  return matrix(box.bottom - box.top + 1, box.right - box.left + 1, values);
}

function evaluateBinary(
  operator: BinaryOperator,
  leftNode: Node,
  rightNode: Node,
  host: EvaluationHost,
): Value {
  const leftValue = evaluate(leftNode, host);
  const rightValue = evaluate(rightNode, host);

  // An operator applied to two ranges broadcasts elementwise. That is what
  // makes an array formula work, and doing it here rather than in each
  // function keeps the rule in one place.
  if (isMatrix(leftValue) || isMatrix(rightValue)) {
    return broadcast(operator, leftValue, rightValue);
  }

  return applyScalarOperator(operator, leftValue, rightValue);
}

function broadcast(operator: BinaryOperator, left: Value, right: Value): Value {
  const leftRows = isMatrix(left) ? left.rows : 1;
  const leftColumns = isMatrix(left) ? left.columns : 1;
  const rightRows = isMatrix(right) ? right.rows : 1;
  const rightColumns = isMatrix(right) ? right.columns : 1;

  const rows = Math.max(leftRows, rightRows);
  const columns = Math.max(leftColumns, rightColumns);

  // A dimension either matches or is one. Anything else is refused rather
  // than recycled, because recycling a mismatched range produces a full grid
  // of plausible numbers computed from the wrong pairings.
  const compatible = (size: number, target: number): boolean => size === target || size === 1;
  if (
    !compatible(leftRows, rows) ||
    !compatible(rightRows, rows) ||
    !compatible(leftColumns, columns) ||
    !compatible(rightColumns, columns)
  ) {
    return VALUE_ERROR;
  }

  const pick = (value: Value, row: number, column: number): ScalarValue => {
    if (!isMatrix(value)) return value;
    const r = value.rows === 1 ? 0 : row;
    const c = value.columns === 1 ? 0 : column;
    const item = value.values[r * value.columns + c];
    return item === undefined ? BLANK : item;
  };

  const values: ScalarValue[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const result = applyScalarOperator(
        operator,
        pick(left, row, column),
        pick(right, row, column),
      );
      values.push(toScalar(result));
    }
  }
  return matrix(rows, columns, values);
}

function applyScalarOperator(
  operator: BinaryOperator,
  left: Value,
  right: Value,
): Value {
  const leftScalar = toScalar(left);
  const rightScalar = toScalar(right);

  // First error wins, so the reported error names the original cause.
  if (isError(leftScalar)) return leftScalar;
  if (isError(rightScalar)) return rightScalar;

  if (operator === '&') {
    const a = toText(leftScalar);
    if (isError(a)) return a;
    const b = toText(rightScalar);
    if (isError(b)) return b;
    return a + b;
  }

  if (operator === '=' || operator === '<>' || operator === '<' || operator === '>' ||
      operator === '<=' || operator === '>=') {
    const comparison = compareValues(leftScalar, rightScalar);
    if (isError(comparison)) return comparison;
    switch (operator) {
      case '=':
        return comparison === 0;
      case '<>':
        return comparison !== 0;
      case '<':
        return comparison < 0;
      case '>':
        return comparison > 0;
      case '<=':
        return comparison <= 0;
      default:
        return comparison >= 0;
    }
  }

  const a = toNumber(leftScalar);
  if (isError(a)) return a;
  const b = toNumber(rightScalar);
  if (isError(b)) return b;

  switch (operator) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      // Division by zero is its own error, distinct from a value error,
      // because it is the one people write a guard for.
      return b === 0 ? DIV_ZERO : a / b;
    case '^': {
      const result = Math.pow(a, b);
      return Number.isFinite(result) ? result : NUMBER_ERROR;
    }
    default:
      return VALUE_ERROR;
  }
}

function evaluateCall(
  node: Node & { kind: 'call' },
  host: EvaluationHost,
): Value {
  const entry = lookupFunction(node.name);
  if (entry === undefined) return NAME_ERROR;

  if (node.args.length < entry.minimumArguments || node.args.length > entry.maximumArguments) {
    return VALUE_ERROR;
  }

  const context = {
    argumentCount: node.args.length,
    evaluate: (index: number): Value => {
      const argument = node.args[index];
      return argument === undefined ? BLANK : evaluate(argument, host);
    },
  };

  // A lazy function receives no evaluated arguments at all. Passing them
  // anyway would defeat the laziness while looking as though it worked.
  if (entry.lazy) return entry.call([], context);

  const args = node.args.map((argument) => evaluate(argument, host));
  return entry.call(args, context);
}
