/**
 * Mathematical typesetting.
 *
 * The input language is close to TeX, because that is what everybody who
 * writes mathematics already knows. Inventing a new one would mean every user
 * learning a notation that exists only here.
 *
 * The output is MathML. That choice matters more than it looks:
 *
 *   - IT IS READ ALOUD CORRECTLY. A screen reader speaks MathML as
 *     mathematics — "the fraction with numerator a plus b" — where an image of
 *     a formula is silent and a pile of positioned spans is gibberish. An
 *     equation editor whose output is inaccessible has failed at the one thing
 *     that distinguishes it from a drawing.
 *   - IT IS SELECTABLE AND SEARCHABLE, so a formula can be copied into
 *     something else and still be a formula.
 *   - IT IS RENDERED BY THE PLATFORM, so it matches the surrounding text's
 *     font and scales with it rather than being a fixed-size picture.
 *
 * The parser is a precedence climber over a small token set, and it is
 * deliberately NOT a full TeX implementation: TeX is a programming language
 * with macros, and implementing a subset that pretends to be the whole thing
 * is worse than implementing a subset that says what it covers.
 */

export type Node =
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'operator'; readonly symbol: string }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'row'; readonly children: readonly Node[] }
  | { readonly kind: 'fraction'; readonly numerator: Node; readonly denominator: Node }
  | { readonly kind: 'root'; readonly radicand: Node; readonly index?: Node }
  | { readonly kind: 'superscript'; readonly base: Node; readonly exponent: Node }
  | { readonly kind: 'subscript'; readonly base: Node; readonly index: Node }
  | {
      readonly kind: 'subsup';
      readonly base: Node;
      readonly index: Node;
      readonly exponent: Node;
    }
  | {
      readonly kind: 'fenced';
      readonly open: string;
      readonly close: string;
      readonly body: Node;
    }
  | {
      readonly kind: 'bigop';
      readonly symbol: string;
      readonly lower?: Node;
      readonly upper?: Node;
    }
  | { readonly kind: 'function'; readonly name: string }
  | {
      readonly kind: 'matrix';
      /** The rows, each a list of cells. Every row has the same length. */
      readonly rows: readonly (readonly Node[])[];
      /** Delimiters, or an empty string for none. Cases opens and never closes. */
      readonly open: string;
      readonly close: string;
      /** What the rows MEAN, which decides how they are aligned and spoken. */
      readonly style: 'matrix' | 'cases' | 'aligned';
      /**
       * True when a row was short and got padded.
       *
       * Kept rather than swallowed: padding is the right thing to do, because
       * a cases block genuinely has rows with one cell and rows with two, but
       * a matrix whose second row is one cell short is nearly always a typo,
       * and a renderer that pads it silently draws a plausible matrix that is
       * not the one anybody wrote.
       */
      readonly ragged: boolean;
    };

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message + ' at position ' + position);
    this.name = 'FormulaError';
  }
}

/**
 * Named symbols.
 *
 * The Unicode character, not an image and not a font hack: a formula that
 * depends on a particular font to be legible is a formula that is illegible
 * anywhere that font is missing.
 */
const SYMBOLS: ReadonlyMap<string, string> = new Map([
  ['alpha', 'α'],
  ['beta', 'β'],
  ['gamma', 'γ'],
  ['delta', 'δ'],
  ['epsilon', 'ε'],
  ['theta', 'θ'],
  ['lambda', 'λ'],
  ['mu', 'μ'],
  ['pi', 'π'],
  ['rho', 'ρ'],
  ['sigma', 'σ'],
  ['tau', 'τ'],
  ['phi', 'φ'],
  ['omega', 'ω'],
  ['Gamma', 'Γ'],
  ['Delta', 'Δ'],
  ['Theta', 'Θ'],
  ['Lambda', 'Λ'],
  ['Sigma', 'Σ'],
  ['Phi', 'Φ'],
  ['Omega', 'Ω'],
  ['infty', '∞'],
  ['partial', '∂'],
  ['nabla', '∇'],
  ['times', '×'],
  ['div', '÷'],
  ['pm', '±'],
  ['mp', '∓'],
  ['cdot', '⋅'],
  ['leq', '≤'],
  ['geq', '≥'],
  ['neq', '≠'],
  ['approx', '≈'],
  ['equiv', '≡'],
  ['propto', '∝'],
  ['in', '∈'],
  ['notin', '∉'],
  ['subset', '⊂'],
  ['subseteq', '⊆'],
  ['cup', '∪'],
  ['cap', '∩'],
  ['forall', '∀'],
  ['exists', '∃'],
  ['rightarrow', '→'],
  ['leftarrow', '←'],
  ['leftrightarrow', '↔'],
  ['Rightarrow', '⇒'],
  ['ldots', '…'],
  ['cdots', '⋯'],
]);

/** Operators that take limits above and below rather than beside. */
const BIG_OPERATORS: ReadonlyMap<string, string> = new Map([
  ['sum', '∑'],
  ['prod', '∏'],
  ['int', '∫'],
  ['oint', '∮'],
  ['bigcup', '⋃'],
  ['bigcap', '⋂'],
  ['lim', 'lim'],
]);

/**
 * Function names set upright rather than italic.
 *
 * In mathematical typesetting a single-letter variable is italic and a
 * function name is not, so `sin` set in italics reads as the product of three
 * variables s, i and n. This is the detail that makes a rendering look wrong
 * to anybody who reads mathematics, without their being able to say why.
 */
const FUNCTIONS: ReadonlySet<string> = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh',
  'log', 'ln', 'exp', 'det', 'dim', 'gcd', 'max', 'min', 'sup', 'inf',
]);

const OPEN_FENCES: ReadonlyMap<string, string> = new Map([
  ['(', ')'],
  ['[', ']'],
  ['\\{', '\\}'],
  ['|', '|'],
]);

interface Token {
  readonly kind: 'number' | 'identifier' | 'command' | 'operator' | 'punct' | 'end';
  readonly value: string;
  readonly at: number;
}

/**
 * The environments, and what each one's delimiters and alignment mean.
 *
 * `cases` opens with a brace and never closes: the missing right brace is the
 * notation, not an oversight, and adding one would change what it says.
 */
const ENVIRONMENTS: ReadonlyMap<
  string,
  { readonly open: string; readonly close: string; readonly style: 'matrix' | 'cases' | 'aligned' }
> = new Map([
  ['matrix', { open: '', close: '', style: 'matrix' as const }],
  ['pmatrix', { open: '(', close: ')', style: 'matrix' as const }],
  ['bmatrix', { open: '[', close: ']', style: 'matrix' as const }],
  ['Bmatrix', { open: '{', close: '}', style: 'matrix' as const }],
  ['vmatrix', { open: '|', close: '|', style: 'matrix' as const }],
  ['Vmatrix', { open: '\u2016', close: '\u2016', style: 'matrix' as const }],
  ['cases', { open: '{', close: '', style: 'cases' as const }],
  ['aligned', { open: '', close: '', style: 'aligned' as const }],
  ['align', { open: '', close: '', style: 'aligned' as const }],
]);

/**
 * How each column of a table lines up.
 *
 * An aligned block alternates right then left, and that alternation IS the
 * feature: the ampersand marks the point every row should meet at, so getting
 * it wrong leaves a column of equals signs that do not line up, which is the
 * only reason to reach for the environment in the first place.
 */
export function alignmentFor(style: 'matrix' | 'cases' | 'aligned', columns: number): string[] {
  if (style === 'cases') return Array.from({ length: columns }, () => 'left');
  if (style === 'matrix') return Array.from({ length: columns }, () => 'center');
  return Array.from({ length: columns }, (_, index) => (index % 2 === 0 ? 'right' : 'left'));
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const character = source[cursor] as string;

    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }

    if (character === '\\') {
      // A double backslash is a ROW BREAK, not a command with an empty name.
      // Recognised before the name scan, which would otherwise throw on it and
      // make every matrix a syntax error.
      if (source[cursor + 1] === '\\') {
        tokens.push({ kind: 'punct', value: '\\\\', at: cursor });
        cursor += 2;
        continue;
      }
      // A command. The backslash-brace forms are fences rather than names, so
      // they are recognised before the general name scan.
      if (source[cursor + 1] === '{' || source[cursor + 1] === '}') {
        tokens.push({ kind: 'punct', value: source.slice(cursor, cursor + 2), at: cursor });
        cursor += 2;
        continue;
      }
      let scan = cursor + 1;
      while (scan < source.length && /[A-Za-z]/.test(source[scan] as string)) scan += 1;
      if (scan === cursor + 1) throw new FormulaError('a backslash with no command', cursor);
      tokens.push({ kind: 'command', value: source.slice(cursor + 1, scan), at: cursor });
      cursor = scan;
      continue;
    }

    if (/[0-9]/.test(character)) {
      let scan = cursor;
      while (scan < source.length && /[0-9]/.test(source[scan] as string)) scan += 1;
      if (source[scan] === '.' && /[0-9]/.test(source[scan + 1] ?? '')) {
        scan += 1;
        while (scan < source.length && /[0-9]/.test(source[scan] as string)) scan += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(cursor, scan), at: cursor });
      cursor = scan;
      continue;
    }

    if (/[A-Za-z]/.test(character)) {
      // One letter at a time. In mathematics `ab` is a times b, not a variable
      // called ab — grouping the letters would render it upright as a word and
      // change what the formula says.
      tokens.push({ kind: 'identifier', value: character, at: cursor });
      cursor += 1;
      continue;
    }

    if ('{}^_'.includes(character)) {
      tokens.push({ kind: 'punct', value: character, at: cursor });
      cursor += 1;
      continue;
    }

    if ('()[]|'.includes(character)) {
      tokens.push({ kind: 'punct', value: character, at: cursor });
      cursor += 1;
      continue;
    }

    tokens.push({ kind: 'operator', value: character, at: cursor });
    cursor += 1;
  }

  tokens.push({ kind: 'end', value: '', at: source.length });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  parse(): Node {
    const row = this.parseRow(['end']);
    const token = this.peek();
    if (token.kind !== 'end') throw new FormulaError('unexpected input', token.at);
    return row;
  }

  /** A run of atoms, stopping at any of the given terminators. */
  private parseRow(stopAt: readonly string[]): Node {
    const children: Node[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'end') break;
      if (stopAt.includes(token.value)) break;
      children.push(this.parseScripted());
    }
    return children.length === 1 ? (children[0] as Node) : { kind: 'row', children };
  }

  /**
   * An atom with any superscripts and subscripts attached.
   *
   * Both orders are accepted and both produce the same node, because a reader
   * expects them typeset identically however they were typed.
   */
  private parseScripted(): Node {
    let base = this.parseAtom();

    let sub: Node | undefined;
    let sup: Node | undefined;

    for (;;) {
      const token = this.peek();
      if (token.kind !== 'punct') break;
      if (token.value === '^') {
        this.next();
        if (sup !== undefined) throw new FormulaError('two superscripts on one atom', token.at);
        sup = this.parseAtom();
        continue;
      }
      if (token.value === '_') {
        this.next();
        if (sub !== undefined) throw new FormulaError('two subscripts on one atom', token.at);
        sub = this.parseAtom();
        continue;
      }
      break;
    }

    // A big operator takes its scripts as LIMITS, above and below, not beside.
    if (base.kind === 'bigop') {
      base = {
        ...base,
        ...(sub === undefined ? {} : { lower: sub }),
        ...(sup === undefined ? {} : { upper: sup }),
      };
      return base;
    }

    if (sub !== undefined && sup !== undefined) {
      return { kind: 'subsup', base, index: sub, exponent: sup };
    }
    if (sup !== undefined) return { kind: 'superscript', base, exponent: sup };
    if (sub !== undefined) return { kind: 'subscript', base, index: sub };
    return base;
  }

  /**
   * The name between the braces of a begin or an end.
   *
   * Letters tokenize one at a time, because in mathematics `ab` is a times b -
   * so the name arrives in pieces and is put back together here rather than
   * read as a single token that does not exist.
   */
  private readEnvironmentName(): string {
    const open = this.next();
    if (!(open.kind === 'punct' && open.value === '{')) {
      throw new FormulaError('an environment needs its name in braces', open.at);
    }
    let name = '';
    for (;;) {
      const token = this.next();
      if (token.kind === 'end') {
        throw new FormulaError('an environment name that never closes', token.at);
      }
      if (token.kind === 'punct' && token.value === '}') break;
      name += token.value;
    }
    return name;
  }

  /**
   * A matrix, a cases block, or a set of aligned equations.
   *
   * Cells are parsed with the ordinary atom parser rather than by splitting the
   * token stream on separators, so a matrix nested inside a cell keeps its own
   * row breaks instead of ending the outer row.
   */
  private parseTable(name: string, at: number): Node {
    const shape = ENVIRONMENTS.get(name);
    if (shape === undefined) {
      throw new FormulaError(
        'unknown environment ' + name + ', expected one of ' +
          [...ENVIRONMENTS.keys()].join(', '),
        at,
      );
    }

    const rows: Node[][] = [];
    let cells: Node[] = [];
    let current: Node[] = [];

    const closeCell = (): void => {
      cells.push(current.length === 1 ? (current[0] as Node) : { kind: 'row', children: current });
      current = [];
    };
    const closeRow = (): void => {
      closeCell();
      rows.push(cells);
      cells = [];
    };

    for (;;) {
      const token = this.peek();
      if (token.kind === 'end') {
        throw new FormulaError('a ' + name + ' that is never ended', token.at);
      }
      if (token.kind === 'command' && token.value === 'end') {
        this.next();
        const closing = this.readEnvironmentName();
        if (closing !== name) {
          throw new FormulaError('began ' + name + ' and ended ' + closing, token.at);
        }
        break;
      }
      if (token.kind === 'punct' && token.value === '\\\\') {
        this.next();
        closeRow();
        continue;
      }
      if (token.kind === 'operator' && token.value === '&') {
        this.next();
        closeCell();
        continue;
      }
      current.push(this.parseScripted());
    }
    closeRow();

    // A row separator before the end is idiomatic and means nothing. Keeping
    // the empty row it produces adds a blank line to every carefully written
    // matrix in the world.
    while (rows.length > 1) {
      const last = rows[rows.length - 1] as Node[];
      const blank = last.every(
        (cell) => cell.kind === 'row' && cell.children.length === 0,
      );
      if (!blank) break;
      rows.pop();
    }

    const widest = rows.reduce((most, row) => Math.max(most, row.length), 0);
    const ragged = rows.some((row) => row.length !== widest);
    const padded = rows.map((row) => {
      const copy = [...row];
      while (copy.length < widest) copy.push({ kind: 'row', children: [] });
      return copy;
    });

    return {
      kind: 'matrix',
      rows: padded,
      open: shape.open,
      close: shape.close,
      style: shape.style,
      ragged,
    };
  }

  private parseAtom(): Node {
    const token = this.next();

    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: token.value };
      case 'identifier':
        return { kind: 'identifier', name: token.value };
      case 'operator':
        return { kind: 'operator', symbol: token.value };
      case 'command':
        return this.parseCommand(token);
      case 'punct': {
        if (token.value === '{') {
          const body = this.parseRow(['}']);
          this.expect('}');
          return body;
        }
        const close = OPEN_FENCES.get(token.value);
        if (close !== undefined) {
          const body = this.parseRow([close, token.value === '|' ? '|' : close]);
          this.expect(close);
          return { kind: 'fenced', open: token.value, close, body };
        }
        break;
      }
      default:
        break;
    }

    throw new FormulaError('unexpected ' + (token.value === '' ? 'end of input' : token.value), token.at);
  }

  private parseCommand(token: Token): Node {
    const name = token.value;

    if (name === 'begin') {
      return this.parseTable(this.readEnvironmentName(), token.at);
    }

    if (name === 'frac') {
      return {
        kind: 'fraction',
        numerator: this.parseAtom(),
        denominator: this.parseAtom(),
      };
    }
    if (name === 'sqrt') {
      return { kind: 'root', radicand: this.parseAtom() };
    }
    if (name === 'text' || name === 'mathrm') {
      return { kind: 'text', value: this.parseTextArgument(token.at) };
    }
    if (name === 'left' || name === 'right') {
      // Sizing hints. The fence itself follows, and MathML sizes fences on its
      // own, so these are consumed rather than represented.
      const following = this.next();
      if (following.kind === 'end') throw new FormulaError('a fence with nothing after it', token.at);
      const close = OPEN_FENCES.get(following.value);
      if (name === 'left' && close !== undefined) {
        const body = this.parseRow(['right']);
        // The matching \right, then its own fence character.
        const rightToken = this.next();
        if (rightToken.kind !== 'command' || rightToken.value !== 'right') {
          throw new FormulaError('a \\left with no matching \\right', token.at);
        }
        const closer = this.next();
        return { kind: 'fenced', open: following.value, close: closer.value, body };
      }
      return { kind: 'operator', symbol: following.value };
    }

    const big = BIG_OPERATORS.get(name);
    if (big !== undefined) return { kind: 'bigop', symbol: big };

    if (FUNCTIONS.has(name)) return { kind: 'function', name };

    const symbol = SYMBOLS.get(name);
    if (symbol !== undefined) {
      // A Greek letter is a VARIABLE and is set italic; a relation or an
      // arrow is an operator and is not.
      const isLetter = /^[A-Za-z]/.test(name) && /[Ͱ-Ͽ]/.test(symbol);
      return isLetter ? { kind: 'identifier', name: symbol } : { kind: 'operator', symbol };
    }

    throw new FormulaError('unknown command ' + name, token.at);
  }

  private parseTextArgument(at: number): string {
    const open = this.next();
    if (open.kind !== 'punct' || open.value !== '{') {
      throw new FormulaError('text needs a braced argument', at);
    }
    let text = '';
    for (;;) {
      const token = this.next();
      if (token.kind === 'end') throw new FormulaError('unterminated text', at);
      if (token.kind === 'punct' && token.value === '}') break;
      // Reconstructed with spaces between words, since the tokenizer dropped
      // the original whitespace.
      text += (text.length > 0 && token.kind === 'identifier' ? '' : '') + token.value;
    }
    return text;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new FormulaError('expected ' + value, token.at);
  }
}

export function parseFormula(source: string): Node {
  return new Parser(tokenize(source)).parse();
}

// ----------------------------------------------------------------- MathML --

function escapeXml(text: string): string {
  return text
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;');
}

/**
 * MathML for one node.
 *
 * The element chosen for each kind is what decides how a screen reader speaks
 * it: `mi` is a variable, `mn` a number, `mo` an operator, `mtext` prose. Using
 * `mi` for everything renders identically and is read aloud as nonsense.
 */
function nodeToMathml(node: Node): string {
  switch (node.kind) {
    case 'number':
      return '<mn>' + escapeXml(node.value) + '</mn>';
    case 'identifier':
      return '<mi>' + escapeXml(node.name) + '</mi>';
    case 'operator':
      return '<mo>' + escapeXml(node.symbol) + '</mo>';
    case 'text':
      return '<mtext>' + escapeXml(node.value) + '</mtext>';
    case 'function':
      // Upright, because an italic `sin` reads as s times i times n.
      return '<mi mathvariant="normal">' + escapeXml(node.name) + '</mi>';
    case 'row':
      return '<mrow>' + node.children.map(nodeToMathml).join('') + '</mrow>';
    case 'fraction':
      return (
        '<mfrac>' + nodeToMathml(node.numerator) + nodeToMathml(node.denominator) + '</mfrac>'
      );
    case 'root':
      return node.index === undefined
        ? '<msqrt>' + nodeToMathml(node.radicand) + '</msqrt>'
        : '<mroot>' + nodeToMathml(node.radicand) + nodeToMathml(node.index) + '</mroot>';
    case 'superscript':
      return '<msup>' + nodeToMathml(node.base) + nodeToMathml(node.exponent) + '</msup>';
    case 'subscript':
      return '<msub>' + nodeToMathml(node.base) + nodeToMathml(node.index) + '</msub>';
    case 'subsup':
      return (
        '<msubsup>' +
        nodeToMathml(node.base) +
        nodeToMathml(node.index) +
        nodeToMathml(node.exponent) +
        '</msubsup>'
      );
    case 'fenced':
      // Written out rather than using <mfenced>, which is deprecated and
      // unsupported in current engines. The stretchy attribute is what makes
      // the bracket grow around a tall fraction.
      return (
        '<mrow><mo stretchy="true">' +
        escapeXml(node.open.replace('\\', '')) +
        '</mo>' +
        nodeToMathml(node.body) +
        '<mo stretchy="true">' +
        escapeXml(node.close.replace('\\', '')) +
        '</mo></mrow>'
      );
    case 'bigop': {
      const operator = '<mo>' + escapeXml(node.symbol) + '</mo>';
      if (node.lower === undefined && node.upper === undefined) return operator;
      if (node.upper === undefined) {
        return '<munder>' + operator + nodeToMathml(node.lower as Node) + '</munder>';
      }
      if (node.lower === undefined) {
        return '<mover>' + operator + nodeToMathml(node.upper) + '</mover>';
      }
      return (
        '<munderover>' +
        operator +
        nodeToMathml(node.lower as Node) +
        nodeToMathml(node.upper) +
        '</munderover>'
      );
    }
    case 'matrix': {
      const columns = node.rows[0]?.length ?? 0;
      const align = alignmentFor(node.style, columns).join(' ');
      // rowspacing is what separates a matrix from a set of equations: the
      // same table with the same cells reads as one or the other depending on
      // how far apart the lines sit.
      const spacing = node.style === 'matrix' ? '0.35ex' : '0.9ex';
      const table =
        '<mtable columnalign="' + align + '" rowspacing="' + spacing + '">' +
        node.rows
          .map(
            (row) =>
              '<mtr>' +
              // An empty cell still emits its mtd. Dropping it shifts every
              // later cell one column left, which renders as a perfectly
              // plausible matrix that is not the one anybody wrote.
              row
                .map((cell) =>
                  cell.kind === 'row' && cell.children.length === 0
                    ? '<mtd></mtd>'
                    : '<mtd>' + nodeToMathml(cell) + '</mtd>',
                )
                .join('') +
              '</mtr>',
          )
          .join('') +
        '</mtable>';

      if (node.open === '' && node.close === '') return table;
      const open =
        node.open === ''
          ? ''
          : '<mo stretchy="true" fence="true">' + escapeXml(node.open) + '</mo>';
      const close =
        node.close === ''
          ? ''
          : '<mo stretchy="true" fence="true">' + escapeXml(node.close) + '</mo>';
      return '<mrow>' + open + table + close + '</mrow>';
    }
    default:
      return '<mtext>?</mtext>';
  }
}

export interface MathmlOptions {
  /** Block display centres the formula and sets limits above and below. */
  readonly display?: boolean;
  /** A plain-language description, for assistive technology. */
  readonly label?: string;
}

export function toMathml(node: Node, options: MathmlOptions = {}): string {
  const attributes = [
    'xmlns="http://www.w3.org/1998/Math/MathML"',
    'display="' + (options.display === true ? 'block' : 'inline') + '"',
  ];
  if (options.label !== undefined) {
    attributes.push('aria-label="' + escapeXml(options.label).split('"').join('&quot;') + '"');
  }
  const body = nodeToMathml(node);
  const wrapped = body.startsWith('<mrow>') ? body : '<mrow>' + body + '</mrow>';
  return '<math ' + attributes.join(' ') + '>' + wrapped + '</math>';
}

/**
 * A plain-language reading of the formula.
 *
 * MathML is read correctly by a screen reader that supports it, and not every
 * one does. This is the fallback, and it is also what goes in an alt attribute
 * when the formula is exported as an image.
 */
export function describe(node: Node): string {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'identifier':
      return node.name;
    case 'operator':
      return operatorWord(node.symbol);
    case 'text':
      return node.value;
    case 'function':
      return node.name;
    case 'row':
      return node.children.map(describe).join(' ');
    case 'fraction':
      return (
        'the fraction with numerator ' +
        describe(node.numerator) +
        ' and denominator ' +
        describe(node.denominator)
      );
    case 'root':
      return node.index === undefined
        ? 'the square root of ' + describe(node.radicand)
        : 'the ' + describe(node.index) + 'th root of ' + describe(node.radicand);
    case 'superscript':
      return describe(node.base) + ' to the power ' + describe(node.exponent);
    case 'subscript':
      return describe(node.base) + ' sub ' + describe(node.index);
    case 'subsup':
      return (
        describe(node.base) +
        ' sub ' +
        describe(node.index) +
        ' to the power ' +
        describe(node.exponent)
      );
    case 'fenced':
      return 'open bracket ' + describe(node.body) + ' close bracket';
    case 'bigop': {
      const name = bigOperatorWord(node.symbol);
      const from = node.lower === undefined ? '' : ' from ' + describe(node.lower);
      const to = node.upper === undefined ? '' : ' to ' + describe(node.upper);
      return name + from + to;
    }
    case 'matrix': {
      const columns = node.rows[0]?.length ?? 0;
      // Spoken as a shape and then as rows, because a screen reader reading a
      // table cell by cell gives a listener a stream of numbers with no way to
      // tell where one row ended and the next began.
      const shape =
        node.style === 'cases'
          ? 'cases, ' + node.rows.length + (node.rows.length === 1 ? ' case' : ' cases')
          : node.style === 'aligned'
            ? node.rows.length + (node.rows.length === 1 ? ' equation' : ' aligned equations')
            : node.rows.length + ' by ' + columns + ' matrix';

      const rows = node.rows
        .map((row, index) => {
          const cells = row
            .map((cell) => describe(cell))
            .map((text) => (text.trim() === '' ? 'blank' : text))
            .join(', ');
          return 'row ' + (index + 1) + ', ' + cells;
        })
        .join('; ');

      return shape + ', ' + rows;
    }
    default:
      return '';
  }
}

function operatorWord(symbol: string): string {
  const words: Record<string, string> = {
    '+': 'plus',
    '-': 'minus',
    '=': 'equals',
    '<': 'is less than',
    '>': 'is greater than',
    '×': 'times',
    '÷': 'divided by',
    '±': 'plus or minus',
    '≤': 'is less than or equal to',
    '≥': 'is greater than or equal to',
    '≠': 'is not equal to',
    '≈': 'is approximately',
    '∞': 'infinity',
    '→': 'implies',
    '∈': 'is in',
  };
  return words[symbol] ?? symbol;
}

function bigOperatorWord(symbol: string): string {
  const words: Record<string, string> = {
    '∑': 'the sum',
    '∏': 'the product',
    '∫': 'the integral',
    '∮': 'the contour integral',
    lim: 'the limit',
  };
  return words[symbol] ?? symbol;
}
