/**
 * Formula tokenizer and parser.
 *
 * The output is an AST, never a closure. That matters more than it looks: the
 * dependency graph has to read a formula's references WITHOUT evaluating it,
 * because evaluation order is decided by the dependencies and you cannot
 * discover the dependencies by running the thing you have not yet ordered. A
 * compiled closure hides its references inside itself and makes that
 * impossible.
 *
 * Precedence is climbing rather than a tower of nested functions, because the
 * spreadsheet operator set is small and flat and a table is easier to check
 * against the specification than nine mutually recursive parse functions.
 */

import {
  type CellReference,
  type RangeReference,
  parseReference,
} from './reference';

export type ErrorKind =
  | 'DIV/0'
  | 'VALUE'
  | 'REF'
  | 'NAME'
  | 'NUM'
  | 'N/A'
  | 'NULL'
  | 'CIRCULAR';

export type Node =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly error: ErrorKind }
  | { readonly kind: 'reference'; readonly reference: CellReference }
  | { readonly kind: 'range'; readonly range: RangeReference }
  | { readonly kind: 'name'; readonly name: string }
  | {
      readonly kind: 'call';
      readonly name: string;
      readonly args: readonly Node[];
    }
  | {
      readonly kind: 'binary';
      readonly operator: BinaryOperator;
      readonly left: Node;
      readonly right: Node;
    }
  | { readonly kind: 'unary'; readonly operator: '-' | '+'; readonly operand: Node }
  | { readonly kind: 'percent'; readonly operand: Node }
  | { readonly kind: 'array'; readonly rows: readonly (readonly Node[])[] };

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '<>'
  | '<'
  | '>'
  | '<='
  | '>=';

/**
 * Binding powers.
 *
 * Comparison binds LOOSEST, which is the opposite of most programming
 * languages and is the detail most hand-rolled spreadsheet parsers get wrong.
 * A formula comparing two sums must parse as one comparison of two sums, not
 * as a sum whose last term is a comparison.
 *
 * Concatenation sits between comparison and addition. Exponentiation is
 * LEFT-associative here, unlike mathematics and unlike most languages, because
 * that is what every mainstream spreadsheet does and matching the specification
 * matters more than matching taste.
 */
const PRECEDENCE: Readonly<Record<BinaryOperator, number>> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
};

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

type Token =
  | { kind: 'number'; value: number; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'error'; value: ErrorKind; at: number }
  | { kind: 'identifier'; value: string; at: number }
  | { kind: 'operator'; value: string; at: number }
  | { kind: 'punct'; value: string; at: number }
  | { kind: 'end'; at: number };

const ERROR_LITERALS: Readonly<Record<string, ErrorKind>> = {
  '#DIV/0!': 'DIV/0',
  '#VALUE!': 'VALUE',
  '#REF!': 'REF',
  '#NAME?': 'NAME',
  '#NUM!': 'NUM',
  '#N/A': 'N/A',
  '#NULL!': 'NULL',
};

const QUOTE = String.fromCharCode(39);
const DOUBLE_QUOTE = String.fromCharCode(34);

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '_' ||
    character === '$' ||
    character === QUOTE ||
    character.charCodeAt(0) > 127
  );
}

function isIdentifierPart(character: string): boolean {
  return (
    isIdentifierStart(character) ||
    isDigit(character) ||
    character === '.' ||
    character === '!'
  );
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const character = source[cursor] as string;

    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      cursor += 1;
      continue;
    }

    // Error literals first. They begin with a character nothing else uses, and
    // several contain characters that would otherwise tokenize as operators.
    if (character === '#') {
      const rest = source.slice(cursor);
      const literal = Object.keys(ERROR_LITERALS).find((candidate) =>
        rest.toUpperCase().startsWith(candidate),
      );
      if (literal === undefined) {
        throw new FormulaError('unknown error literal', cursor);
      }
      tokens.push({ kind: 'error', value: ERROR_LITERALS[literal] as ErrorKind, at: cursor });
      cursor += literal.length;
      continue;
    }

    if (character === DOUBLE_QUOTE) {
      let text = '';
      let scan = cursor + 1;
      let closed = false;
      while (scan < source.length) {
        if (source[scan] === DOUBLE_QUOTE) {
          // A doubled quote is one literal quote, not the end of the string.
          if (source[scan + 1] === DOUBLE_QUOTE) {
            text += DOUBLE_QUOTE;
            scan += 2;
            continue;
          }
          closed = true;
          scan += 1;
          break;
        }
        text += source[scan];
        scan += 1;
      }
      if (!closed) throw new FormulaError('unterminated string', cursor);
      tokens.push({ kind: 'string', value: text, at: cursor });
      cursor = scan;
      continue;
    }

    if (isDigit(character) || (character === '.' && isDigit(source[cursor + 1] ?? ''))) {
      let scan = cursor;
      while (scan < source.length && isDigit(source[scan] as string)) scan += 1;
      if (source[scan] === '.') {
        scan += 1;
        while (scan < source.length && isDigit(source[scan] as string)) scan += 1;
      }
      if (source[scan] === 'e' || source[scan] === 'E') {
        const exponentStart = scan;
        scan += 1;
        if (source[scan] === '+' || source[scan] === '-') scan += 1;
        if (!isDigit(source[scan] ?? '')) {
          // Not an exponent after all. Rewind rather than throw, so a cell
          // reference such as the one below still tokenizes.
          scan = exponentStart;
        } else {
          while (scan < source.length && isDigit(source[scan] as string)) scan += 1;
        }
      }
      tokens.push({ kind: 'number', value: Number(source.slice(cursor, scan)), at: cursor });
      cursor = scan;
      continue;
    }

    if (isIdentifierStart(character)) {
      let scan = cursor;
      if (character === QUOTE) {
        // A quoted sheet name. Consume through the closing quote, honouring the
        // doubled-quote escape, then continue into the unquoted remainder.
        scan += 1;
        while (scan < source.length) {
          if (source[scan] === QUOTE) {
            if (source[scan + 1] === QUOTE) {
              scan += 2;
              continue;
            }
            scan += 1;
            break;
          }
          scan += 1;
        }
      }
      while (scan < source.length && isIdentifierPart(source[scan] as string)) scan += 1;
      tokens.push({ kind: 'identifier', value: source.slice(cursor, scan), at: cursor });
      cursor = scan;
      continue;
    }

    const twoCharacter = source.slice(cursor, cursor + 2);
    if (twoCharacter === '<=' || twoCharacter === '>=' || twoCharacter === '<>') {
      tokens.push({ kind: 'operator', value: twoCharacter, at: cursor });
      cursor += 2;
      continue;
    }

    if ('+-*/^&=<>%'.includes(character)) {
      tokens.push({ kind: 'operator', value: character, at: cursor });
      cursor += 1;
      continue;
    }

    if ('(),:;{}'.includes(character)) {
      tokens.push({ kind: 'punct', value: character, at: cursor });
      cursor += 1;
      continue;
    }

    throw new FormulaError('unexpected character ' + character, cursor);
  }

  tokens.push({ kind: 'end', at: source.length });
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

  private expect(value: string): Token {
    const token = this.next();
    if ((token.kind !== 'punct' && token.kind !== 'operator') || token.value !== value) {
      throw new FormulaError('expected ' + value, token.at);
    }
    return token;
  }

  parse(): Node {
    const node = this.parseExpression(0);
    const token = this.peek();
    if (token.kind !== 'end') {
      throw new FormulaError('unexpected trailing input', token.at);
    }
    return node;
  }

  private parseExpression(minimumPrecedence: number): Node {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();
      if (token.kind !== 'operator') break;
      const operator = token.value as BinaryOperator;
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minimumPrecedence) break;
      this.next();
      // Left-associative throughout, exponentiation included. See the note on
      // PRECEDENCE: this deliberately matches the spreadsheet convention
      // rather than the mathematical one.
      const right = this.parseExpression(precedence + 1);
      left = { kind: 'binary', operator, left, right };
    }

    return left;
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.kind === 'operator' && (token.value === '-' || token.value === '+')) {
      this.next();
      // Unary binds tighter than every binary operator except exponentiation,
      // and it may stack.
      const operand = this.parseUnary();
      return { kind: 'unary', operator: token.value, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (token.kind === 'operator' && token.value === '%') {
        this.next();
        node = { kind: 'percent', operand: node };
        continue;
      }
      break;
    }
    return node;
  }

  private parsePrimary(): Node {
    const token = this.next();

    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'error':
        return { kind: 'error', error: token.value };
      case 'punct':
        if (token.value === '(') {
          const inner = this.parseExpression(0);
          this.expect(')');
          return inner;
        }
        if (token.value === '{') return this.parseArray();
        break;
      case 'identifier':
        return this.parseIdentifier(token);
      default:
        break;
    }

    throw new FormulaError('unexpected token', token.at);
  }

  private parseArray(): Node {
    const rows: Node[][] = [];
    let row: Node[] = [];
    for (;;) {
      row.push(this.parseExpression(0));
      const token = this.peek();
      if (token.kind === 'punct' && token.value === ',') {
        this.next();
        continue;
      }
      if (token.kind === 'punct' && token.value === ';') {
        this.next();
        rows.push(row);
        row = [];
        continue;
      }
      break;
    }
    rows.push(row);
    this.expect('}');

    // Every row must be the same width. A ragged literal is a typo, and
    // padding it with blanks would turn that typo into a plausible answer.
    const width = rows[0]?.length ?? 0;
    if (rows.some((candidate) => candidate.length !== width)) {
      throw new FormulaError('array rows are not the same length', this.peek().at);
    }
    return { kind: 'array', rows };
  }

  private parseIdentifier(token: Token & { kind: 'identifier' }): Node {
    const nextToken = this.peek();

    // A function call: an identifier immediately followed by an open paren.
    if (nextToken.kind === 'punct' && nextToken.value === '(') {
      this.next();
      const args: Node[] = [];
      if (!(this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === ')')) {
        for (;;) {
          args.push(this.parseExpression(0));
          const separator = this.peek();
          if (separator.kind === 'punct' && separator.value === ',') {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expect(')');
      return { kind: 'call', name: token.value.toUpperCase(), args };
    }

    // A range: reference colon reference.
    if (nextToken.kind === 'punct' && nextToken.value === ':') {
      const start = parseReference(token.value);
      if (start !== undefined) {
        this.next();
        const endToken = this.next();
        if (endToken.kind !== 'identifier') {
          throw new FormulaError('expected a cell reference after the colon', endToken.at);
        }
        const end = parseReference(endToken.value);
        if (end === undefined) {
          throw new FormulaError('not a cell reference: ' + endToken.value, endToken.at);
        }
        // A range written across two sheets is refused rather than silently
        // reduced to one of them.
        if (end.sheet !== undefined && start.sheet !== undefined && end.sheet !== start.sheet) {
          throw new FormulaError('a range cannot span two sheets', endToken.at);
        }
        return {
          kind: 'range',
          range: { start, end: end.sheet === undefined ? { ...end, sheet: start.sheet } : end },
        };
      }
    }

    const upper = token.value.toUpperCase();
    if (upper === 'TRUE') return { kind: 'boolean', value: true };
    if (upper === 'FALSE') return { kind: 'boolean', value: false };

    const reference = parseReference(token.value);
    if (reference !== undefined) return { kind: 'reference', reference };

    return { kind: 'name', name: token.value };
  }
}

/**
 * Parse a formula body, WITHOUT its leading equals sign.
 *
 * Callers strip the sign, because a cell whose text merely starts with one is
 * not necessarily a formula and that decision belongs to the cell, not here.
 */
export function parseFormula(source: string): Node {
  return new Parser(tokenize(source)).parse();
}

/**
 * Every reference a formula reads, without evaluating it.
 *
 * This is what the dependency graph is built from, and it is why the parser
 * returns a tree rather than a closure.
 */
export function collectReferences(node: Node): {
  readonly cells: readonly CellReference[];
  readonly ranges: readonly RangeReference[];
  readonly names: readonly string[];
} {
  const cells: CellReference[] = [];
  const ranges: RangeReference[] = [];
  const names: string[] = [];

  const walk = (current: Node): void => {
    switch (current.kind) {
      case 'reference':
        cells.push(current.reference);
        return;
      case 'range':
        ranges.push(current.range);
        return;
      case 'name':
        names.push(current.name);
        return;
      case 'call':
        for (const argument of current.args) walk(argument);
        return;
      case 'binary':
        walk(current.left);
        walk(current.right);
        return;
      case 'unary':
      case 'percent':
        walk(current.operand);
        return;
      case 'array':
        for (const row of current.rows) for (const item of row) walk(item);
        return;
      default:
        return;
    }
  };

  walk(node);
  return { cells, ranges, names };
}
