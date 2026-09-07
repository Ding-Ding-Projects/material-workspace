/**
 * The function library.
 *
 * Each entry declares whether it wants its arguments EVALUATED or RAW. That
 * distinction is not a convenience, it is a correctness requirement:
 *
 *   - IF must not evaluate the branch it does not take. A sheet where
 *     `IF(A1=0, "n/a", B1/A1)` divides by zero anyway is a sheet where the
 *     guard people actually write does not work.
 *   - The aggregate functions need to know which of their inputs were BLANK
 *     cells rather than zeros, so they cannot take a pre-coerced number list.
 *   - The lookup functions need the shape of a range, not its contents in a
 *     flat list, so a two-dimensional lookup can index it.
 *
 * Errors propagate first-wins, so the reported error names the original cause
 * rather than whatever noticed it last.
 */

import {
  BLANK,
  type CellError,
  DIV_ZERO,
  NOT_AVAILABLE,
  NUMBER_ERROR,
  type ScalarValue,
  VALUE_ERROR,
  type Value,
  compareValues,
  flatten,
  isBlank,
  isError,
  isMatrix,
  matrix,
  matrixAt,
  toBoolean,
  toNumber,
  toScalar,
  toText,
} from './values';

export interface FunctionContext {
  /** Evaluate a raw argument. Used by the lazy functions only. */
  readonly evaluate: (index: number) => Value;
  readonly argumentCount: number;
}

export interface SheetFunction {
  readonly name: string;
  readonly minimumArguments: number;
  /** Infinity for a variadic function. */
  readonly maximumArguments: number;
  /** Lazy functions receive no evaluated args and use the context instead. */
  readonly lazy?: boolean;
  readonly call: (args: readonly Value[], context: FunctionContext) => Value;
}

function firstError(values: readonly Value[]): CellError | undefined {
  for (const value of values) {
    if (isError(value)) return value;
    if (isMatrix(value)) {
      for (const item of value.values) if (isError(item)) return item;
    }
  }
  return undefined;
}

/**
 * The numbers an aggregate should actually see.
 *
 * A blank is skipped rather than counted as zero — that is the difference
 * between AVERAGE over a partly empty column being right and being quietly
 * wrong. Text inside a RANGE is skipped too, matching the convention that a
 * heading in a column does not break the sum beneath it; text passed DIRECTLY
 * as an argument is coerced, and fails loudly if it is not numeric.
 */
function numericOperands(args: readonly Value[]): number[] | CellError {
  const numbers: number[] = [];
  for (const argument of args) {
    if (isError(argument)) return argument;
    if (isMatrix(argument)) {
      for (const item of argument.values) {
        if (isError(item)) return item;
        if (typeof item === 'number') numbers.push(item);
        else if (typeof item === 'boolean') continue;
        else if (isBlank(item)) continue;
        // Text inside a range is skipped, deliberately.
      }
      continue;
    }
    if (isBlank(argument)) continue;
    const asNumber = toNumber(argument);
    if (isError(asNumber)) return asNumber;
    numbers.push(asNumber);
  }
  return numbers;
}

function scalarArgument(args: readonly Value[], index: number): ScalarValue {
  const value = args[index];
  return value === undefined ? BLANK : toScalar(value);
}

function numberArgument(args: readonly Value[], index: number): number | CellError {
  return toNumber(scalarArgument(args, index));
}

function textArgument(args: readonly Value[], index: number): string | CellError {
  return toText(scalarArgument(args, index));
}

function define(
  name: string,
  minimumArguments: number,
  maximumArguments: number,
  call: SheetFunction['call'],
  lazy = false,
): SheetFunction {
  return { name, minimumArguments, maximumArguments, call, lazy };
}

/** Wrap a one-number function, propagating errors and rejecting non-numbers. */
function unaryMath(name: string, compute: (value: number) => number): SheetFunction {
  return define(name, 1, 1, (args) => {
    const value = numberArgument(args, 0);
    if (isError(value)) return value;
    const result = compute(value);
    // A domain error must be an error rather than NaN. NaN spreads silently.
    if (Number.isNaN(result)) return NUMBER_ERROR;
    if (!Number.isFinite(result)) return NUMBER_ERROR;
    return result;
  });
}

/**
 * Criteria matching, as used by COUNTIF, SUMIF and their relatives.
 *
 * A criterion may be a bare value ("matches this") or a string carrying a
 * comparison operator. Wildcards are supported because a criterion without
 * them is far less useful than people expect.
 */
function makeCriterion(criterion: ScalarValue): (candidate: ScalarValue) => boolean {
  if (typeof criterion === 'string') {
    const operatorMatch = /^(<>|>=|<=|>|<|=)(.*)$/s.exec(criterion);
    if (operatorMatch) {
      const operator = operatorMatch[1] as string;
      const rest = (operatorMatch[2] ?? '').trim();
      const asNumber = toNumber(rest);
      const target: ScalarValue = isError(asNumber) ? rest : rest === '' ? BLANK : asNumber;
      return (candidate) => {
        const comparison = compareValues(candidate, target);
        if (isError(comparison)) return false;
        switch (operator) {
          case '>':
            return comparison > 0;
          case '<':
            return comparison < 0;
          case '>=':
            return comparison >= 0;
          case '<=':
            return comparison <= 0;
          case '<>':
            return comparison !== 0;
          default:
            return comparison === 0;
        }
      };
    }

    if (criterion.includes('*') || criterion.includes('?')) {
      const pattern = wildcardToRegExp(criterion);
      return (candidate) => {
        const text = toText(candidate);
        return isError(text) ? false : pattern.test(text);
      };
    }
  }

  return (candidate) => {
    const comparison = compareValues(candidate, criterion);
    return !isError(comparison) && comparison === 0;
  };
}

/**
 * Wildcards to a regular expression.
 *
 * Every other character is escaped. Without that, a criterion containing a
 * regular-expression metacharacter — a dot in a filename, a plus in a product
 * code — would match far more than the user asked for, and a tilde-escaped
 * literal star would be a wildcard.
 */
function wildcardToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '~') {
      const next = pattern[index + 1];
      if (next === '*' || next === '?' || next === '~') {
        source += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        index += 1;
        continue;
      }
      source += '~';
      continue;
    }
    if (character === '*') {
      source += '[\\s\\S]*';
      continue;
    }
    if (character === '?') {
      source += '[\\s\\S]';
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$', 'i');
}

const LIST: SheetFunction[] = [
  // ---------------------------------------------------------------- maths --
  define('SUM', 1, Infinity, (args) => {
    const numbers = numericOperands(args);
    if (isError(numbers)) return numbers;
    return numbers.reduce((total, value) => total + value, 0);
  }),
  define('PRODUCT', 1, Infinity, (args) => {
    const numbers = numericOperands(args);
    if (isError(numbers)) return numbers;
    if (numbers.length === 0) return 0;
    return numbers.reduce((total, value) => total * value, 1);
  }),
  define('AVERAGE', 1, Infinity, (args) => {
    const numbers = numericOperands(args);
    if (isError(numbers)) return numbers;
    // An average of nothing is a division error, not zero. Zero would be a
    // plausible-looking answer to a question with no answer.
    if (numbers.length === 0) return DIV_ZERO;
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  }),
  define('MIN', 1, Infinity, (args) => {
    const numbers = numericOperands(args);
    if (isError(numbers)) return numbers;
    return numbers.length === 0 ? 0 : Math.min(...numbers);
  }),
  define('MAX', 1, Infinity, (args) => {
    const numbers = numericOperands(args);
    if (isError(numbers)) return numbers;
    return numbers.length === 0 ? 0 : Math.max(...numbers);
  }),
  define('MEDIAN', 1, Infinity, (args) => {
    const numbers = numericOperands(args);
    if (isError(numbers)) return numbers;
    if (numbers.length === 0) return NUMBER_ERROR;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  }),
  define('COUNT', 1, Infinity, (args) => {
    // Counts numbers only. A blank or a text cell is not a number, which is
    // the entire difference between COUNT and COUNTA.
    let count = 0;
    for (const argument of args) {
      for (const item of flatten(argument)) {
        if (typeof item === 'number') count += 1;
      }
    }
    return count;
  }),
  define('COUNTA', 1, Infinity, (args) => {
    let count = 0;
    for (const argument of args) {
      for (const item of flatten(argument)) {
        if (!isBlank(item)) count += 1;
      }
    }
    return count;
  }),
  define('COUNTBLANK', 1, 1, (args) => {
    let count = 0;
    for (const item of flatten(args[0] ?? BLANK)) {
      if (isBlank(item) || item === '') count += 1;
    }
    return count;
  }),
  define('ABS', 1, 1, (args) => {
    const value = numberArgument(args, 0);
    return isError(value) ? value : Math.abs(value);
  }),
  define('SIGN', 1, 1, (args) => {
    const value = numberArgument(args, 0);
    return isError(value) ? value : Math.sign(value);
  }),
  unaryMath('SQRT', (value) => Math.sqrt(value)),
  unaryMath('EXP', (value) => Math.exp(value)),
  unaryMath('LN', (value) => Math.log(value)),
  unaryMath('LOG10', (value) => Math.log10(value)),
  unaryMath('SIN', (value) => Math.sin(value)),
  unaryMath('COS', (value) => Math.cos(value)),
  unaryMath('TAN', (value) => Math.tan(value)),
  unaryMath('ASIN', (value) => Math.asin(value)),
  unaryMath('ACOS', (value) => Math.acos(value)),
  unaryMath('ATAN', (value) => Math.atan(value)),
  unaryMath('SINH', (value) => Math.sinh(value)),
  unaryMath('COSH', (value) => Math.cosh(value)),
  unaryMath('TANH', (value) => Math.tanh(value)),
  define('PI', 0, 0, () => Math.PI),
  define('ATAN2', 2, 2, (args) => {
    const x = numberArgument(args, 0);
    if (isError(x)) return x;
    const y = numberArgument(args, 1);
    if (isError(y)) return y;
    // Argument order is x then y here, which is the reverse of the usual
    // programming convention and matches the spreadsheet one.
    return Math.atan2(y, x);
  }),
  define('LOG', 1, 2, (args) => {
    const value = numberArgument(args, 0);
    if (isError(value)) return value;
    const base = args.length > 1 ? numberArgument(args, 1) : 10;
    if (isError(base)) return base;
    if (value <= 0 || base <= 0 || base === 1) return NUMBER_ERROR;
    return Math.log(value) / Math.log(base);
  }),
  define('POWER', 2, 2, (args) => {
    const base = numberArgument(args, 0);
    if (isError(base)) return base;
    const exponent = numberArgument(args, 1);
    if (isError(exponent)) return exponent;
    const result = Math.pow(base, exponent);
    return Number.isFinite(result) ? result : NUMBER_ERROR;
  }),
  define('MOD', 2, 2, (args) => {
    const value = numberArgument(args, 0);
    if (isError(value)) return value;
    const divisor = numberArgument(args, 1);
    if (isError(divisor)) return divisor;
    if (divisor === 0) return DIV_ZERO;
    // Result takes the sign of the DIVISOR, not of the dividend. That is the
    // spreadsheet rule and the opposite of the JavaScript remainder operator,
    // so this cannot be written as a bare percent sign.
    return value - divisor * Math.floor(value / divisor);
  }),
  define('QUOTIENT', 2, 2, (args) => {
    const value = numberArgument(args, 0);
    if (isError(value)) return value;
    const divisor = numberArgument(args, 1);
    if (isError(divisor)) return divisor;
    if (divisor === 0) return DIV_ZERO;
    return Math.trunc(value / divisor);
  }),
  define('ROUND', 1, 2, (args) => roundTo(args, 'half-away')),
  define('ROUNDUP', 1, 2, (args) => roundTo(args, 'up')),
  define('ROUNDDOWN', 1, 2, (args) => roundTo(args, 'down')),
  define('TRUNC', 1, 2, (args) => roundTo(args, 'down')),
  define('INT', 1, 1, (args) => {
    const value = numberArgument(args, 0);
    // Floor, not truncate. INT(-2.5) is -3, which surprises people who expect
    // it to behave like a cast.
    return isError(value) ? value : Math.floor(value);
  }),
  define('CEILING', 1, 2, (args) => {
    const value = numberArgument(args, 0);
    if (isError(value)) return value;
    const step = args.length > 1 ? numberArgument(args, 1) : 1;
    if (isError(step)) return step;
    if (step === 0) return 0;
    return Math.ceil(value / step) * step;
  }),
  define('FLOOR', 1, 2, (args) => {
    const value = numberArgument(args, 0);
    if (isError(value)) return value;
    const step = args.length > 1 ? numberArgument(args, 1) : 1;
    if (isError(step)) return step;
    if (step === 0) return DIV_ZERO;
    return Math.floor(value / step) * step;
  }),
  define('SUMPRODUCT', 1, Infinity, (args) => {
    const propagated = firstError(args);
    if (propagated) return propagated;
    const lists = args.map((argument) => flatten(argument));
    const length = lists[0]?.length ?? 0;
    // Mismatched lengths are an error rather than a truncation. Truncating
    // gives a smaller total that looks entirely reasonable.
    if (lists.some((list) => list.length !== length)) return VALUE_ERROR;
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      let product = 1;
      for (const list of lists) {
        const item = list[index] as ScalarValue;
        product *= typeof item === 'number' ? item : 0;
      }
      total += product;
    }
    return total;
  }),

  // ------------------------------------------------------------ statistics --
  define('STDEV', 1, Infinity, (args) => deviation(args, true)),
  define('STDEVP', 1, Infinity, (args) => deviation(args, false)),
  define('VAR', 1, Infinity, (args) => variance(args, true)),
  define('VARP', 1, Infinity, (args) => variance(args, false)),
  define('LARGE', 2, 2, (args) => nth(args, 'largest')),
  define('SMALL', 2, 2, (args) => nth(args, 'smallest')),

  // ----------------------------------------------------------- conditional --
  define('COUNTIF', 2, 2, (args) => {
    const range = flatten(args[0] ?? BLANK);
    const matches = makeCriterion(scalarArgument(args, 1));
    return range.filter((item) => matches(item)).length;
  }),
  define('SUMIF', 2, 3, (args) => {
    const range = flatten(args[0] ?? BLANK);
    const matches = makeCriterion(scalarArgument(args, 1));
    const target = args.length > 2 ? flatten(args[2] as Value) : range;
    let total = 0;
    for (let index = 0; index < range.length; index += 1) {
      if (!matches(range[index] as ScalarValue)) continue;
      const item = target[index];
      if (typeof item === 'number') total += item;
    }
    return total;
  }),
  define('AVERAGEIF', 2, 3, (args) => {
    const range = flatten(args[0] ?? BLANK);
    const matches = makeCriterion(scalarArgument(args, 1));
    const target = args.length > 2 ? flatten(args[2] as Value) : range;
    let total = 0;
    let count = 0;
    for (let index = 0; index < range.length; index += 1) {
      if (!matches(range[index] as ScalarValue)) continue;
      const item = target[index];
      if (typeof item === 'number') {
        total += item;
        count += 1;
      }
    }
    return count === 0 ? DIV_ZERO : total / count;
  }),
  define('COUNTIFS', 2, Infinity, (args) => conditionalPairs(args).count),
  define('SUMIFS', 3, Infinity, (args) => {
    const target = flatten(args[0] ?? BLANK);
    const result = conditionalPairs(args.slice(1));
    let total = 0;
    for (const index of result.indices) {
      const item = target[index];
      if (typeof item === 'number') total += item;
    }
    return total;
  }),

  // --------------------------------------------------------------- logical --
  define(
    'IF',
    2,
    3,
    (_args, context) => {
      // Lazy. Evaluating the untaken branch would make every guard people
      // write against division by zero fail anyway.
      const condition = toBoolean(toScalar(context.evaluate(0)));
      if (isError(condition)) return condition;
      if (condition) return context.evaluate(1);
      return context.argumentCount > 2 ? context.evaluate(2) : false;
    },
    true,
  ),
  define(
    'IFERROR',
    2,
    2,
    (_args, context) => {
      const attempted = context.evaluate(0);
      const propagated = firstError([attempted]);
      return propagated ? context.evaluate(1) : attempted;
    },
    true,
  ),
  define(
    'IFNA',
    2,
    2,
    (_args, context) => {
      const attempted = context.evaluate(0);
      const scalar = toScalar(attempted);
      if (isError(scalar) && scalar.error === 'N/A') return context.evaluate(1);
      return attempted;
    },
    true,
  ),
  define(
    'AND',
    1,
    Infinity,
    (_args, context) => {
      // Short-circuits. A later argument that would error is never reached
      // once an earlier one is false, which is what people expect from a
      // guard chain.
      for (let index = 0; index < context.argumentCount; index += 1) {
        const value = toBoolean(toScalar(context.evaluate(index)));
        if (isError(value)) return value;
        if (!value) return false;
      }
      return true;
    },
    true,
  ),
  define(
    'OR',
    1,
    Infinity,
    (_args, context) => {
      for (let index = 0; index < context.argumentCount; index += 1) {
        const value = toBoolean(toScalar(context.evaluate(index)));
        if (isError(value)) return value;
        if (value) return true;
      }
      return false;
    },
    true,
  ),
  define('NOT', 1, 1, (args) => {
    const value = toBoolean(scalarArgument(args, 0));
    return isError(value) ? value : !value;
  }),
  define('XOR', 1, Infinity, (args) => {
    let odd = false;
    for (const argument of args) {
      for (const item of flatten(argument)) {
        const value = toBoolean(item);
        if (isError(value)) return value;
        if (value) odd = !odd;
      }
    }
    return odd;
  }),
  define('TRUE', 0, 0, () => true),
  define('FALSE', 0, 0, () => false),
  define(
    'IFS',
    2,
    Infinity,
    (_args, context) => {
      for (let index = 0; index + 1 < context.argumentCount; index += 2) {
        const condition = toBoolean(toScalar(context.evaluate(index)));
        if (isError(condition)) return condition;
        if (condition) return context.evaluate(index + 1);
      }
      // No condition matched. Not-available rather than false, so the absence
      // is visible instead of masquerading as an answer.
      return NOT_AVAILABLE;
    },
    true,
  ),

  // ------------------------------------------------------------------ text --
  define('CONCAT', 1, Infinity, (args) => {
    let text = '';
    for (const argument of args) {
      for (const item of flatten(argument)) {
        const part = toText(item);
        if (isError(part)) return part;
        text += part;
      }
    }
    return text;
  }),
  define('CONCATENATE', 1, Infinity, (args) => {
    let text = '';
    for (const argument of args) {
      const part = toText(toScalar(argument));
      if (isError(part)) return part;
      text += part;
    }
    return text;
  }),
  define('TEXTJOIN', 3, Infinity, (args) => {
    const separator = textArgument(args, 0);
    if (isError(separator)) return separator;
    const skipEmpty = toBoolean(scalarArgument(args, 1));
    if (isError(skipEmpty)) return skipEmpty;
    const parts: string[] = [];
    for (const argument of args.slice(2)) {
      for (const item of flatten(argument)) {
        if (skipEmpty && (isBlank(item) || item === '')) continue;
        const part = toText(item);
        if (isError(part)) return part;
        parts.push(part);
      }
    }
    return parts.join(separator);
  }),
  define('LEN', 1, 1, (args) => {
    const text = textArgument(args, 0);
    // Counts UTF-16 code units, matching every mainstream spreadsheet. An
    // astral character therefore counts as two, which is compatible rather
    // than correct, and the choice is deliberate.
    return isError(text) ? text : text.length;
  }),
  define('UPPER', 1, 1, (args) => {
    const text = textArgument(args, 0);
    return isError(text) ? text : text.toUpperCase();
  }),
  define('LOWER', 1, 1, (args) => {
    const text = textArgument(args, 0);
    return isError(text) ? text : text.toLowerCase();
  }),
  define('PROPER', 1, 1, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    return text.replace(
      /[A-Za-z]+/g,
      (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    );
  }),
  define('TRIM', 1, 1, (args) => {
    const text = textArgument(args, 0);
    // Collapses interior runs of spaces as well as trimming the ends, which
    // is what makes it useful on imported data and is not what trim() does.
    return isError(text) ? text : text.replace(/\s+/g, ' ').trim();
  }),
  define('LEFT', 1, 2, (args) => sidePiece(args, 'left')),
  define('RIGHT', 1, 2, (args) => sidePiece(args, 'right')),
  define('MID', 3, 3, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    const start = numberArgument(args, 1);
    if (isError(start)) return start;
    const count = numberArgument(args, 2);
    if (isError(count)) return count;
    if (start < 1 || count < 0) return VALUE_ERROR;
    return text.slice(start - 1, start - 1 + Math.floor(count));
  }),
  define('FIND', 2, 3, (args) => findIn(args, true)),
  define('SEARCH', 2, 3, (args) => findIn(args, false)),
  define('SUBSTITUTE', 3, 4, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    const target = textArgument(args, 1);
    if (isError(target)) return target;
    const replacement = textArgument(args, 2);
    if (isError(replacement)) return replacement;
    if (target === '') return text;
    if (args.length < 4) return text.split(target).join(replacement);
    const which = numberArgument(args, 3);
    if (isError(which)) return which;
    if (which < 1) return VALUE_ERROR;
    let index = -1;
    for (let seen = 0; seen < which; seen += 1) {
      index = text.indexOf(target, index + 1);
      if (index < 0) return text;
    }
    return text.slice(0, index) + replacement + text.slice(index + target.length);
  }),
  define('REPLACE', 4, 4, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    const start = numberArgument(args, 1);
    if (isError(start)) return start;
    const count = numberArgument(args, 2);
    if (isError(count)) return count;
    const replacement = textArgument(args, 3);
    if (isError(replacement)) return replacement;
    if (start < 1 || count < 0) return VALUE_ERROR;
    return text.slice(0, start - 1) + replacement + text.slice(start - 1 + count);
  }),
  define('REPT', 2, 2, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    const times = numberArgument(args, 1);
    if (isError(times)) return times;
    const count = Math.floor(times);
    if (count < 0) return VALUE_ERROR;
    // Bounded. Without this a single cell can ask for a gigabyte of string
    // and take the whole application down with it.
    if (text.length * count > 32767) return VALUE_ERROR;
    return text.repeat(count);
  }),
  define('EXACT', 2, 2, (args) => {
    const left = textArgument(args, 0);
    if (isError(left)) return left;
    const right = textArgument(args, 1);
    if (isError(right)) return right;
    // Case-SENSITIVE, unlike the equals operator. That is the whole point of
    // this function existing.
    return left === right;
  }),
  define('VALUE', 1, 1, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    const parsed = toNumber(text);
    return isError(parsed) ? VALUE_ERROR : parsed;
  }),
  define('CHAR', 1, 1, (args) => {
    const code = numberArgument(args, 0);
    if (isError(code)) return code;
    if (code < 1 || code > 65535) return VALUE_ERROR;
    return String.fromCharCode(Math.floor(code));
  }),
  define('CODE', 1, 1, (args) => {
    const text = textArgument(args, 0);
    if (isError(text)) return text;
    if (text.length === 0) return VALUE_ERROR;
    return text.charCodeAt(0);
  }),

  // ------------------------------------------------------------- reference --
  define('ROWS', 1, 1, (args) => {
    const value = args[0];
    return value !== undefined && isMatrix(value) ? value.rows : 1;
  }),
  define('COLUMNS', 1, 1, (args) => {
    const value = args[0];
    return value !== undefined && isMatrix(value) ? value.columns : 1;
  }),
  define('INDEX', 2, 3, (args) => {
    const source = args[0];
    if (source === undefined) return VALUE_ERROR;
    if (!isMatrix(source)) return source;
    const row = numberArgument(args, 1);
    if (isError(row)) return row;
    const column = args.length > 2 ? numberArgument(args, 2) : 1;
    if (isError(column)) return column;
    // One-based, and out of range is a reference error rather than a blank.
    // A blank would read as an empty cell, which is a different fact.
    const rowIndex = Math.floor(row) - 1;
    const columnIndex = Math.floor(column) - 1;
    if (rowIndex < 0 || rowIndex >= source.rows) return NOT_AVAILABLE;
    if (columnIndex < 0 || columnIndex >= source.columns) return NOT_AVAILABLE;
    return matrixAt(source, rowIndex, columnIndex);
  }),
  define('MATCH', 2, 3, (args) => {
    const needle = scalarArgument(args, 0);
    const haystack = flatten(args[1] ?? BLANK);
    const mode = args.length > 2 ? numberArgument(args, 2) : 1;
    if (isError(mode)) return mode;
    if (mode === 0) {
      const matches = makeCriterion(needle);
      const index = haystack.findIndex((item) => matches(item));
      return index < 0 ? NOT_AVAILABLE : index + 1;
    }
    // Ordered modes walk rather than binary-search. The data is not verified
    // to be sorted, and a binary search over unsorted data returns a wrong
    // answer confidently instead of failing.
    let best = -1;
    for (let index = 0; index < haystack.length; index += 1) {
      const comparison = compareValues(haystack[index] as ScalarValue, needle);
      if (isError(comparison)) continue;
      if (mode > 0 ? comparison <= 0 : comparison >= 0) best = index;
      else if (mode > 0) break;
    }
    return best < 0 ? NOT_AVAILABLE : best + 1;
  }),
  define('VLOOKUP', 3, 4, (args) => lookup(args, 'vertical')),
  define('HLOOKUP', 3, 4, (args) => lookup(args, 'horizontal')),
  define('CHOOSE', 2, Infinity, (args) => {
    const index = numberArgument(args, 0);
    if (isError(index)) return index;
    const position = Math.floor(index);
    if (position < 1 || position >= args.length) return VALUE_ERROR;
    return args[position] as Value;
  }),
  define('TRANSPOSE', 1, 1, (args) => {
    const source = args[0];
    if (source === undefined || !isMatrix(source)) return source ?? BLANK;
    const values: ScalarValue[] = [];
    for (let column = 0; column < source.columns; column += 1) {
      for (let row = 0; row < source.rows; row += 1) {
        values.push(matrixAt(source, row, column));
      }
    }
    return matrix(source.columns, source.rows, values);
  }),

  // ---------------------------------------------------------- information --
  define('ISBLANK', 1, 1, (args) => isBlank(scalarArgument(args, 0))),
  define('ISNUMBER', 1, 1, (args) => typeof scalarArgument(args, 0) === 'number'),
  define('ISTEXT', 1, 1, (args) => typeof scalarArgument(args, 0) === 'string'),
  define('ISLOGICAL', 1, 1, (args) => typeof scalarArgument(args, 0) === 'boolean'),
  define('ISERROR', 1, 1, (args) => isError(scalarArgument(args, 0))),
  define('ISERR', 1, 1, (args) => {
    const value = scalarArgument(args, 0);
    // Every error EXCEPT not-available, which is the difference from ISERROR.
    return isError(value) && value.error !== 'N/A';
  }),
  define('ISNA', 1, 1, (args) => {
    const value = scalarArgument(args, 0);
    return isError(value) && value.error === 'N/A';
  }),
  define('NA', 0, 0, () => NOT_AVAILABLE),
  define('N', 1, 1, (args) => {
    const value = scalarArgument(args, 0);
    if (isError(value)) return value;
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return 0;
  }),
  define('T', 1, 1, (args) => {
    const value = scalarArgument(args, 0);
    if (isError(value)) return value;
    return typeof value === 'string' ? value : '';
  }),
  define('TYPE', 1, 1, (args) => {
    const value = scalarArgument(args, 0);
    if (isError(value)) return 16;
    if (typeof value === 'number' || isBlank(value)) return 1;
    if (typeof value === 'string') return 2;
    if (typeof value === 'boolean') return 4;
    return 64;
  }),
];

function roundTo(
  args: readonly Value[],
  mode: 'half-away' | 'up' | 'down',
): number | CellError {
  const value = numberArgument(args, 0);
  if (isError(value)) return value;
  const places = args.length > 1 ? numberArgument(args, 1) : 0;
  if (isError(places)) return places;
  const factor = Math.pow(10, Math.floor(places));

  // Correct the scaling BEFORE rounding, not after.
  //
  // 1.005 is stored as 1.00499999999999989, so 1.005 * 100 is
  // 100.49999999999999 and rounding that gives 100 — making ROUND(1.005, 2)
  // return 1 instead of 1.01. Rounding first and cleaning up afterwards
  // cannot recover the lost digit, because by then the wrong side of the
  // boundary has already been chosen.
  //
  // Fifteen significant digits is the precision a double genuinely carries,
  // so this discards the representation artefact without discarding data.
  const scaled = Number((value * factor).toPrecision(15));
  let rounded: number;
  if (mode === 'up') rounded = scaled < 0 ? Math.floor(scaled) : Math.ceil(scaled);
  else if (mode === 'down') rounded = Math.trunc(scaled);
  else {
    // Half away from zero, NOT the banker's rounding that Math.round does for
    // negatives. Math.round(-0.5) is -0; the spreadsheet answer is -1.
    rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  }
  const result = rounded / factor;
  // Re-round through a string at a sane precision. Otherwise dividing by the
  // factor reintroduces the binary representation error the rounding just
  // removed, and ROUND(1.005, 2) comes back as 1.0000000000000002.
  return Number(result.toPrecision(15));
}

function variance(args: readonly Value[], sample: boolean): number | CellError {
  const numbers = numericOperands(args);
  if (isError(numbers)) return numbers;
  const divisor = sample ? numbers.length - 1 : numbers.length;
  if (divisor <= 0) return DIV_ZERO;
  const mean = numbers.reduce((total, value) => total + value, 0) / numbers.length;
  const sum = numbers.reduce((total, value) => total + (value - mean) * (value - mean), 0);
  return sum / divisor;
}

function deviation(args: readonly Value[], sample: boolean): number | CellError {
  const result = variance(args, sample);
  return isError(result) ? result : Math.sqrt(result);
}

function nth(args: readonly Value[], which: 'largest' | 'smallest'): number | CellError {
  const numbers = numericOperands([args[0] ?? BLANK]);
  if (isError(numbers)) return numbers;
  const position = numberArgument(args, 1);
  if (isError(position)) return position;
  const index = Math.floor(position);
  if (index < 1 || index > numbers.length) return NUMBER_ERROR;
  const sorted = [...numbers].sort((a, b) => (which === 'largest' ? b - a : a - b));
  return sorted[index - 1] as number;
}

function sidePiece(args: readonly Value[], side: 'left' | 'right'): string | CellError {
  const text = textArgument(args, 0);
  if (isError(text)) return text;
  const count = args.length > 1 ? numberArgument(args, 1) : 1;
  if (isError(count)) return count;
  const size = Math.floor(count);
  if (size < 0) return VALUE_ERROR;
  if (size === 0) return '';
  return side === 'left' ? text.slice(0, size) : text.slice(Math.max(0, text.length - size));
}

function findIn(args: readonly Value[], caseSensitive: boolean): number | CellError {
  const needle = textArgument(args, 0);
  if (isError(needle)) return needle;
  const haystack = textArgument(args, 1);
  if (isError(haystack)) return haystack;
  const start = args.length > 2 ? numberArgument(args, 2) : 1;
  if (isError(start)) return start;
  if (start < 1) return VALUE_ERROR;
  const from = Math.floor(start) - 1;
  const index = caseSensitive
    ? haystack.indexOf(needle, from)
    : haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
  // Not found is an error, not zero. Zero is a valid position in some
  // languages and would be indistinguishable from a real answer here.
  return index < 0 ? VALUE_ERROR : index + 1;
}

function conditionalPairs(args: readonly Value[]): {
  readonly count: number;
  readonly indices: number[];
} {
  const ranges: (readonly ScalarValue[])[] = [];
  const tests: ((candidate: ScalarValue) => boolean)[] = [];
  for (let index = 0; index + 1 < args.length; index += 2) {
    ranges.push(flatten(args[index] as Value));
    tests.push(makeCriterion(toScalar(args[index + 1] as Value)));
  }
  const length = ranges[0]?.length ?? 0;
  const indices: number[] = [];
  for (let position = 0; position < length; position += 1) {
    let all = true;
    for (let pair = 0; pair < ranges.length; pair += 1) {
      const range = ranges[pair] as readonly ScalarValue[];
      const test = tests[pair] as (candidate: ScalarValue) => boolean;
      if (range.length !== length || !test(range[position] as ScalarValue)) {
        all = false;
        break;
      }
    }
    if (all) indices.push(position);
  }
  return { count: indices.length, indices };
}

function lookup(args: readonly Value[], axis: 'vertical' | 'horizontal'): Value {
  const needle = scalarArgument(args, 0);
  const table = args[1];
  if (table === undefined || !isMatrix(table)) return NOT_AVAILABLE;
  const offset = numberArgument(args, 2);
  if (isError(offset)) return offset;
  const target = Math.floor(offset) - 1;
  // Approximate is the DEFAULT, which is the single most surprising thing
  // about these two functions and the source of most wrong lookups. It is
  // preserved for compatibility rather than improved.
  const approximate = args.length > 3 ? toBoolean(scalarArgument(args, 3)) : true;
  if (isError(approximate)) return approximate;

  const limit = axis === 'vertical' ? table.rows : table.columns;
  const span = axis === 'vertical' ? table.columns : table.rows;
  if (target < 0 || target >= span) return VALUE_ERROR;

  const read = (index: number): ScalarValue =>
    axis === 'vertical' ? matrixAt(table, index, 0) : matrixAt(table, 0, index);
  const result = (index: number): ScalarValue =>
    axis === 'vertical' ? matrixAt(table, index, target) : matrixAt(table, target, index);

  if (!approximate) {
    const matches = makeCriterion(needle);
    for (let index = 0; index < limit; index += 1) {
      if (matches(read(index))) return result(index);
    }
    return NOT_AVAILABLE;
  }

  let best = -1;
  for (let index = 0; index < limit; index += 1) {
    const comparison = compareValues(read(index), needle);
    if (isError(comparison)) continue;
    if (comparison <= 0) best = index;
    else break;
  }
  return best < 0 ? NOT_AVAILABLE : result(best);
}

export const FUNCTIONS: ReadonlyMap<string, SheetFunction> = new Map(
  LIST.map((entry) => [entry.name, entry]),
);

export function lookupFunction(name: string): SheetFunction | undefined {
  return FUNCTIONS.get(name.toUpperCase());
}
