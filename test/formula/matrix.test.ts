/**
 * Matrices, cases and aligned equations.
 *
 * FIVE WAYS A TABLE OF MATHEMATICS LOOKS RIGHT AND IS WRONG, each of which has
 * its own test below because none of them throws:
 *
 *   - A DROPPED EMPTY CELL shifts every later cell one column left. The result
 *     is a perfectly plausible matrix that is not the one anybody wrote, and
 *     nothing about it looks broken.
 *
 *   - A TRAILING ROW SEPARATOR before the end is idiomatic and means nothing.
 *     Honouring it puts a blank line under every carefully written matrix.
 *
 *   - A NESTED TABLE's row breaks belong to the inner table. A parser that
 *     splits the token stream on separators instead of parsing cells lets an
 *     inner break end the outer row, and the outer matrix quietly gains rows.
 *
 *   - AN ALIGNED BLOCK ALTERNATES RIGHT THEN LEFT. That alternation is the
 *     entire feature: the ampersand marks the point the rows meet at, so
 *     centring the columns instead leaves the equals signs not lining up,
 *     which is the only reason anybody reached for it.
 *
 *   - A RAGGED ROW IS PADDED, AND SAID. Padding is right, because a cases
 *     block genuinely mixes one-cell and two-cell rows - but a matrix a cell
 *     short is nearly always a typo, so the padding is recorded rather than
 *     performed silently.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Node,
  FormulaError,
  alignmentFor,
  describe,
  parseFormula,
  toMathml,
} from '../../app/engines/formula/model';

const B = String.fromCharCode(92);
const BREAK = B + B;

const matrixOf = (node: Node): Extract<Node, { kind: 'matrix' }> => {
  assert.equal(node.kind, 'matrix');
  return node as Extract<Node, { kind: 'matrix' }>;
};

// ------------------------------------------------------------ the shape --

test('a two by two matrix parses as two rows of two, with its brackets', () => {
  const node = matrixOf(
    parseFormula(B + 'begin{pmatrix} a & b ' + BREAK + ' c & d ' + B + 'end{pmatrix}'),
  );
  assert.equal(node.rows.length, 2);
  assert.equal(node.rows[0]?.length, 2);
  assert.equal(node.open, '(');
  assert.equal(node.close, ')');
  assert.equal(node.ragged, false);
});

test('each bracket style keeps its own delimiters, and a plain matrix has none', () => {
  const styles: readonly [string, string, string][] = [
    ['matrix', '', ''],
    ['pmatrix', '(', ')'],
    ['bmatrix', '[', ']'],
    ['Bmatrix', '{', '}'],
    ['vmatrix', '|', '|'],
  ];
  for (const [name, open, close] of styles) {
    const node = matrixOf(parseFormula(B + 'begin{' + name + '} 1 ' + B + 'end{' + name + '}'));
    assert.equal(node.open, open, name + ' opened with ' + node.open);
    assert.equal(node.close, close, name + ' closed with ' + node.close);
  }
});

test('a cases block opens with a brace and deliberately never closes one', () => {
  // The missing right brace is the notation, not an oversight. Adding one
  // changes what the formula says.
  const node = matrixOf(
    parseFormula(B + 'begin{cases} x & y ' + BREAK + ' z ' + B + 'end{cases}'),
  );
  assert.equal(node.open, '{');
  assert.equal(node.close, '');
});

// ------------------------------------------------------------ the traps --

test('an empty cell survives, because dropping it shifts the whole row left', () => {
  const node = matrixOf(
    parseFormula(B + 'begin{bmatrix} 1 & & 3 ' + BREAK + ' 4 & 5 & 6 ' + B + 'end{bmatrix}'),
  );
  assert.equal(node.rows[0]?.length, 3);
  assert.equal(node.rows[1]?.length, 3);

  const mathml = toMathml(node);
  // Three cells in the first row, one of them empty - not two cells.
  const firstRow = mathml.slice(mathml.indexOf('<mtr>'), mathml.indexOf('</mtr>'));
  assert.equal(firstRow.split('<mtd>').length - 1, 3);
  assert.ok(firstRow.includes('<mtd></mtd>'), firstRow);
});

test('a row separator before the end adds nothing, because it means nothing', () => {
  const withTrailing = matrixOf(
    parseFormula(B + 'begin{bmatrix} 1 & 2 ' + BREAK + ' 3 & 4 ' + BREAK + ' ' + B + 'end{bmatrix}'),
  );
  const without = matrixOf(
    parseFormula(B + 'begin{bmatrix} 1 & 2 ' + BREAK + ' 3 & 4 ' + B + 'end{bmatrix}'),
  );
  assert.equal(withTrailing.rows.length, 2);
  assert.deepEqual(withTrailing.rows, without.rows);
});

test('a genuinely blank middle row is KEPT, unlike a trailing one', () => {
  // Only the trailing separator is meaningless. A blank row somebody put in
  // the middle is spacing they asked for, and deleting it is not a tidy-up.
  const node = matrixOf(
    parseFormula(
      B + 'begin{bmatrix} 1 ' + BREAK + ' ' + BREAK + ' 3 ' + B + 'end{bmatrix}',
    ),
  );
  assert.equal(node.rows.length, 3);
});

test("a nested table's row breaks belong to the inner table", () => {
  const node = matrixOf(
    parseFormula(
      B + 'begin{pmatrix} ' + B + 'begin{matrix} 1 ' + BREAK + ' 2 ' + B + 'end{matrix} & 3 ' +
        B + 'end{pmatrix}',
    ),
  );
  // One row outside, two inside. A stream split on separators gives two and one.
  assert.equal(node.rows.length, 1);
  assert.equal(node.rows[0]?.length, 2);
  const inner = matrixOf(node.rows[0]?.[0] as Node);
  assert.equal(inner.rows.length, 2);
});

test('a short row is padded, and the padding is recorded rather than hidden', () => {
  const node = matrixOf(
    parseFormula(B + 'begin{cases} x & y ' + BREAK + ' z ' + B + 'end{cases}'),
  );
  assert.equal(node.ragged, true);
  assert.equal(node.rows[1]?.length, 2);

  const square = matrixOf(
    parseFormula(B + 'begin{cases} x & y ' + BREAK + ' z & w ' + B + 'end{cases}'),
  );
  assert.equal(square.ragged, false, 'a full table was reported ragged');
});

// -------------------------------------------------------- the alignment --

test('an aligned block alternates right then left, which is the whole point', () => {
  assert.deepEqual(alignmentFor('aligned', 4), ['right', 'left', 'right', 'left']);
  assert.deepEqual(alignmentFor('matrix', 3), ['center', 'center', 'center']);
  assert.deepEqual(alignmentFor('cases', 2), ['left', 'left']);
});

test('the alignment reaches the MathML, not just the function that computes it', () => {
  // A value computed correctly and never attached is the wired-at-one-end
  // defect: every test of the helper passes and every equals sign still fails
  // to line up on screen.
  const aligned = toMathml(
    parseFormula(B + 'begin{aligned} a &= b ' + BREAK + ' c &= d ' + B + 'end{aligned}'),
  );
  assert.match(aligned, /columnalign="right left"/);

  const matrix = toMathml(parseFormula(B + 'begin{pmatrix} a & b ' + B + 'end{pmatrix}'));
  assert.match(matrix, /columnalign="center center"/);
});

test('equations sit further apart than matrix rows do', () => {
  // The same cells in the same table read as a matrix or as a set of equations
  // depending on nothing but the gap between the lines.
  const matrix = toMathml(parseFormula(B + 'begin{pmatrix} a ' + B + 'end{pmatrix}'));
  const aligned = toMathml(parseFormula(B + 'begin{aligned} a ' + B + 'end{aligned}'));
  const spacingOf = (source: string): number =>
    Number(/rowspacing="([0-9.]+)ex"/.exec(source)?.[1] ?? '0');
  assert.ok(spacingOf(aligned) > spacingOf(matrix), matrix + ' vs ' + aligned);
});

// ------------------------------------------------------------- MathML --

test('a matrix becomes a real mtable, and its fences stretch', () => {
  const mathml = toMathml(
    parseFormula(B + 'begin{pmatrix} a & b ' + BREAK + ' c & d ' + B + 'end{pmatrix}'),
  );
  assert.match(mathml, /<mtable/);
  assert.equal(mathml.split('<mtr>').length - 1, 2);
  assert.equal(mathml.split('<mtd>').length - 1, 4);
  // Without stretchy the bracket stays one line tall beside a two-line matrix.
  assert.match(mathml, /<mo stretchy="true" fence="true">\(<\/mo>/);
});

test('a plain matrix emits no fence at all, rather than an empty one', () => {
  const mathml = toMathml(parseFormula(B + 'begin{matrix} a ' + B + 'end{matrix}'));
  assert.ok(!mathml.includes('fence="true"'), mathml);
});

test('a cell keeps its own structure instead of being flattened to text', () => {
  const mathml = toMathml(
    parseFormula(B + 'begin{pmatrix} ' + B + 'frac{1}{2} & x^2 ' + B + 'end{pmatrix}'),
  );
  assert.match(mathml, /<mtd><mfrac>/);
  assert.match(mathml, /<msup>/);
});

// ------------------------------------------------------ what is spoken --

test('a matrix is spoken as a shape and then row by row', () => {
  // A reader given the cells one after another gets a stream of numbers with
  // no way to tell where a row ended.
  const spoken = describe(
    parseFormula(B + 'begin{pmatrix} 1 & 2 ' + BREAK + ' 3 & 4 ' + B + 'end{pmatrix}'),
  );
  assert.match(spoken, /2 by 2 matrix/);
  assert.match(spoken, /row 1, 1, 2/);
  assert.match(spoken, /row 2, 3, 4/);
});

test('an empty cell is spoken as blank, not skipped into silence', () => {
  const spoken = describe(
    parseFormula(B + 'begin{bmatrix} 1 & ' + B + 'end{bmatrix}'),
  );
  assert.match(spoken, /blank/);
});

test('cases and aligned equations announce what they are, not "matrix"', () => {
  const cases = describe(
    parseFormula(B + 'begin{cases} x & y ' + BREAK + ' z & w ' + B + 'end{cases}'),
  );
  assert.match(cases, /cases, 2 cases/);
  assert.ok(!/matrix/.test(cases), cases);

  const aligned = describe(
    parseFormula(B + 'begin{aligned} a &= b ' + B + 'end{aligned}'),
  );
  assert.match(aligned, /equation/);
});

// -------------------------------------------------------- what refuses --

test('an unknown environment is refused, and the message names the real ones', () => {
  // Returning an empty row instead would put a formula on screen that silently
  // omitted everything the author typed.
  assert.throws(
    () => parseFormula(B + 'begin{smallmatrix} a ' + B + 'end{smallmatrix}'),
    (error: unknown) => {
      assert.ok(error instanceof FormulaError);
      assert.match(error.message, /unknown environment smallmatrix/);
      assert.match(error.message, /pmatrix/);
      return true;
    },
  );
});

test('a mismatched end is refused, naming both halves', () => {
  assert.throws(
    () => parseFormula(B + 'begin{pmatrix} a ' + B + 'end{bmatrix}'),
    /began pmatrix and ended bmatrix/,
  );
});

test('an unterminated table is refused rather than silently closed', () => {
  assert.throws(
    () => parseFormula(B + 'begin{pmatrix} a & b'),
    /pmatrix that is never ended/,
  );
});

test('an environment with no name in braces is refused', () => {
  assert.throws(() => parseFormula(B + 'begin pmatrix'), /needs its name in braces/);
});

test('a row break outside any table does not silently disappear', () => {
  // It is meaningless there, and swallowing it would let a typo change a
  // formula without saying anything.
  assert.throws(() => parseFormula('a ' + BREAK + ' b'), FormulaError);
});
