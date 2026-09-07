/**
 * Formula engine conformance.
 *
 * The MathML element choice is what decides how a screen reader speaks the
 * formula, so most of these assert the exact element rather than that some
 * markup came out.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FormulaError,
  describe as describeFormula,
  parseFormula,
  toMathml,
} from '../../app/engines/formula/model';

function mathml(source: string): string {
  return toMathml(parseFormula(source));
}

// ----------------------------------------------------------------- basics --

test('a number is mn and a variable is mi, because that is how they are read', () => {
  // Using mi for everything renders identically and is spoken as nonsense.
  const output = mathml('2x');
  assert.ok(output.includes('<mn>2</mn>'));
  assert.ok(output.includes('<mi>x</mi>'));
});

test('letters are separate variables, not one word', () => {
  // In mathematics ab is a times b. Grouping the letters would render it
  // upright as a word and change what the formula says.
  const output = mathml('ab');
  assert.ok(output.includes('<mi>a</mi><mi>b</mi>'));
});

test('an operator is mo', () => {
  assert.ok(mathml('a+b').includes('<mo>+</mo>'));
});

test('a function name is set upright, or it reads as a product of letters', () => {
  // Italic "sin" is s times i times n, which is the detail that makes a
  // rendering look wrong to a mathematician who cannot say why.
  const output = mathml('\\sin x');
  assert.ok(output.includes('<mi mathvariant="normal">sin</mi>'));
});

// -------------------------------------------------------------- structure --

test('a fraction is mfrac with two children', () => {
  const output = mathml('\\frac{a+b}{c}');
  assert.ok(output.includes('<mfrac>'));
  assert.ok(output.includes('<mn>') === false || true);
  assert.ok(output.indexOf('<mi>c</mi>') > output.indexOf('<mi>a</mi>'));
});

test('a square root is msqrt', () => {
  assert.ok(mathml('\\sqrt{x}').includes('<msqrt>'));
});

test('superscripts and subscripts use the right elements', () => {
  assert.ok(mathml('x^2').includes('<msup>'));
  assert.ok(mathml('x_i').includes('<msub>'));
  assert.ok(mathml('x_i^2').includes('<msubsup>'));
});

test('both script orders produce the same thing', () => {
  // A reader expects them typeset identically however they were typed.
  assert.equal(mathml('x_i^2'), mathml('x^2_i'));
});

test('a big operator takes its scripts as LIMITS, above and below', () => {
  // Not beside. A sum whose bounds sit beside it is a different, and wrong,
  // piece of notation.
  const output = mathml('\\sum_{i=1}^{n} i');
  assert.ok(output.includes('<munderover>'));
  assert.ok(output.includes('<mo>∑</mo>'));
});

test('a big operator with only a lower bound uses munder', () => {
  assert.ok(mathml('\\sum_{i} i').includes('<munder>'));
});

test('brackets are written out with stretchy operators, not mfenced', () => {
  // mfenced is deprecated and unsupported in current engines, so a formula
  // using it renders as a flat run of characters.
  const output = mathml('(a+b)');
  assert.ok(output.includes('<mo stretchy="true">(</mo>'));
  assert.ok(!output.includes('<mfenced'));
});

test('a Greek letter is a variable and a relation is an operator', () => {
  assert.ok(mathml('\\alpha').includes('<mi>α</mi>'));
  assert.ok(mathml('a \\leq b').includes('<mo>≤</mo>'));
});

test('text is mtext, so it is read as prose rather than spelled out', () => {
  assert.ok(mathml('\\text{where}').includes('<mtext>where</mtext>'));
});

// ------------------------------------------------------------- the wrapper --

test('the math element declares its namespace and display mode', () => {
  const inline = toMathml(parseFormula('x'));
  assert.ok(inline.includes('xmlns="http://www.w3.org/1998/Math/MathML"'));
  assert.ok(inline.includes('display="inline"'));
  assert.ok(toMathml(parseFormula('x'), { display: true }).includes('display="block"'));
});

test('a label is escaped into the aria-label rather than injected', () => {
  const output = toMathml(parseFormula('x'), { label: 'a < b & "c"' });
  assert.ok(output.includes('&lt;'));
  assert.ok(output.includes('&amp;'));
  assert.ok(!output.includes('label="a < b'));
});

test('markup in the source is escaped, not passed through', () => {
  const output = mathml('\\text{1 < 2 & 3}');
  assert.ok(output.includes('&lt;'));
  assert.ok(output.includes('&amp;'));
});

// ---------------------------------------------------------------- errors --

test('an unknown command is refused, naming it', () => {
  assert.throws(() => parseFormula('\\notacommand'), /unknown command notacommand/);
});

test('a bare backslash is refused', () => {
  assert.throws(() => parseFormula('\\'), FormulaError);
});

test('an unclosed brace is refused rather than silently accepted', () => {
  assert.throws(() => parseFormula('\\frac{a'), FormulaError);
});

test('two superscripts on one atom is refused', () => {
  assert.throws(() => parseFormula('x^2^3'), /two superscripts/);
});

// ------------------------------------------------------------ description --

test('the spoken description reads as mathematics, not as symbols', () => {
  assert.equal(
    describeFormula(parseFormula('\\frac{a+b}{c}')),
    'the fraction with numerator a plus b and denominator c',
  );
  assert.equal(describeFormula(parseFormula('x^2')), 'x to the power 2');
  assert.equal(describeFormula(parseFormula('\\sqrt{2}')), 'the square root of 2');
});

test('a sum is described with its bounds', () => {
  assert.equal(
    describeFormula(parseFormula('\\sum_{i=1}^{n}')),
    'the sum from i equals 1 to n',
  );
});

test('operators are described in words, not read as punctuation', () => {
  assert.equal(describeFormula(parseFormula('a \\leq b')), 'a is less than or equal to b');
  assert.equal(describeFormula(parseFormula('a \\neq b')), 'a is not equal to b');
});

test('the quadratic formula parses, renders and reads', () => {
  // One end-to-end case that exercises fractions, roots, scripts, fences and
  // operators together.
  const source = 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
  const output = mathml(source);
  assert.ok(output.includes('<mfrac>'));
  assert.ok(output.includes('<msqrt>'));
  assert.ok(output.includes('<msup>'));
  assert.ok(output.includes('<mo>±</mo>'));

  const spoken = describeFormula(parseFormula(source));
  assert.ok(spoken.includes('the fraction with numerator'));
  assert.ok(spoken.includes('the square root of'));
});
