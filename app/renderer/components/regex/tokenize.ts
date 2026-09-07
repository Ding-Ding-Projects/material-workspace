/**
 * Tokenise and explain a regular expression, one construct at a time.
 *
 * This is a real scanner rather than a set of regular expressions applied to a
 * regular expression. Patterns nest, escape, and contain the very characters a
 * matcher would use as anchors, so a pattern-based "parser" reliably reaches
 * past the construct it was written for and annotates something in an entirely
 * different one. A depth-counting scanner cannot do that.
 *
 * The output drives both the token-by-token annotation and the structured
 * explanation, so the two can never describe different things.
 */

export type TokenKind =
  | 'literal'
  | 'escape'
  | 'class'
  | 'anchor'
  | 'group-open'
  | 'group-close'
  | 'quantifier'
  | 'alternation'
  | 'backreference'
  | 'dot'
  | 'error';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** Plain-language description, written for somebody who does not already
   *  know the syntax. Never a restatement of the token itself. */
  explanation: string;
  /** Nesting depth at this token, for the structured view. */
  depth: number;
}

const CLASS_ESCAPES: Record<string, string> = {
  d: 'any digit, 0 to 9',
  D: 'anything that is not a digit',
  w: 'any letter, digit or underscore',
  W: 'anything that is not a letter, digit or underscore',
  s: 'any whitespace, including spaces, tabs and line breaks',
  S: 'anything that is not whitespace',
  b: 'a word boundary — the edge between a word character and something else',
  B: 'a position that is NOT a word boundary',
  n: 'a line feed',
  r: 'a carriage return',
  t: 'a tab',
  f: 'a form feed',
  v: 'a vertical tab',
  0: 'a NUL character',
};

function describeQuantifier(text: string): string {
  const lazy = text.endsWith('?') && text.length > 1;
  const base = lazy ? text.slice(0, -1) : text;
  const greed = lazy
    ? ' Lazy: takes as FEW as it can while still allowing an overall match.'
    : ' Greedy: takes as MANY as it can, giving back only if the rest fails.';

  if (base === '*') return 'Repeat the previous item zero or more times.' + greed;
  if (base === '+') return 'Repeat the previous item one or more times.' + greed;
  if (base === '?') return 'The previous item is optional — zero or one.' + greed;

  const braced = /^\{(\d*)(,?)(\d*)\}$/.exec(base);
  if (braced) {
    const [, min = '', comma = '', max = ''] = braced;
    if (comma === '' ) return 'Repeat the previous item exactly ' + min + ' times.' + greed;
    if (max === '') return 'Repeat the previous item at least ' + min + ' times.' + greed;
    return 'Repeat the previous item between ' + min + ' and ' + max + ' times.' + greed;
  }
  return 'A repetition.' + greed;
}

function describeGroup(text: string): string {
  if (text === '(') return 'Start a capture group. What it matches is kept and numbered.';
  if (text === '(?:') return 'Start a group that does NOT capture. Useful purely for grouping.';
  if (text.startsWith('(?<') && !text.startsWith('(?<=') && !text.startsWith('(?<!')) {
    const name = text.slice(3, -1);
    return 'Start a capture group named "' + name + '". Refer back to it with \\k<' + name + '>.';
  }
  if (text === '(?=') return 'Look ahead: the following must match here, but is not consumed.';
  if (text === '(?!') return 'Negative look ahead: the following must NOT match here.';
  if (text === '(?<=') return 'Look behind: the preceding text must match, but is not consumed.';
  if (text === '(?<!') return 'Negative look behind: the preceding text must NOT match.';
  if (/^\(\?[a-z]+[:-]/.test(text)) {
    return 'Start a group with modified flags applied only inside it.';
  }
  return 'Start a group.';
}

/**
 * Scan a pattern. Never throws: an unterminated construct is reported as an
 * error TOKEN, so the annotation still shows everything up to the problem and
 * points at it, rather than showing nothing at all.
 */
export function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let depth = 0;

  const push = (kind: TokenKind, start: number, end: number, explanation: string): void => {
    tokens.push({ kind, text: pattern.slice(start, end), start, end, explanation, depth });
  };

  while (index < pattern.length) {
    const character = pattern[index];

    // --- escape -----------------------------------------------------------
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        push('error', index, index + 1, 'A trailing backslash escapes nothing.');
        index += 1;
        continue;
      }

      // Named backreference
      if (next === 'k' && pattern[index + 2] === '<') {
        const close = pattern.indexOf('>', index + 3);
        if (close === -1) {
          push('error', index, pattern.length, 'An unterminated named backreference.');
          index = pattern.length;
          continue;
        }
        push(
          'backreference',
          index,
          close + 1,
          'Match the same text that the group named "' +
            pattern.slice(index + 3, close) +
            '" matched earlier.',
        );
        index = close + 1;
        continue;
      }

      // Unicode property
      if ((next === 'p' || next === 'P') && pattern[index + 2] === '{') {
        const close = pattern.indexOf('}', index + 3);
        if (close === -1) {
          push('error', index, pattern.length, 'An unterminated Unicode property escape.');
          index = pattern.length;
          continue;
        }
        const property = pattern.slice(index + 3, close);
        push(
          'escape',
          index,
          close + 1,
          (next === 'p' ? 'Any character with the Unicode property ' : 'Any character WITHOUT the Unicode property ') +
            property +
            '. Needs the u or v flag.',
        );
        index = close + 1;
        continue;
      }

      // Numeric backreference
      if (/[1-9]/.test(next)) {
        let end = index + 1;
        while (end < pattern.length && /\d/.test(pattern[end] ?? '')) end += 1;
        push(
          'backreference',
          index,
          end,
          'Match the same text that group ' + pattern.slice(index + 1, end) + ' matched earlier.',
        );
        index = end;
        continue;
      }

      const described = CLASS_ESCAPES[next];
      push(
        'escape',
        index,
        index + 2,
        described ? 'Match ' + described + '.' : 'Match a literal "' + next + '".',
      );
      index += 2;
      continue;
    }

    // --- character class --------------------------------------------------
    if (character === '[') {
      let end = index + 1;
      if (pattern[end] === '^') end += 1;
      if (pattern[end] === ']') end += 1; // a ] first is a literal
      while (end < pattern.length && pattern[end] !== ']') {
        if (pattern[end] === '\\') end += 1;
        end += 1;
      }
      if (end >= pattern.length) {
        push('error', index, pattern.length, 'An unterminated character class — the ] is missing.');
        index = pattern.length;
        continue;
      }
      const negated = pattern[index + 1] === '^';
      push(
        'class',
        index,
        end + 1,
        negated
          ? 'Match any ONE character that is NOT listed here.'
          : 'Match any ONE of the characters listed here.',
      );
      index = end + 1;
      continue;
    }

    // --- group open -------------------------------------------------------
    if (character === '(') {
      let end = index + 1;
      if (pattern[end] === '?') {
        if (pattern[index + 2] === '<' && !'=!'.includes(pattern[index + 3] ?? '')) {
          const close = pattern.indexOf('>', index + 3);
          end = close === -1 ? pattern.length : close + 1;
        } else if (pattern[index + 2] === '<') {
          end = index + 4;
        } else if ('=!:'.includes(pattern[index + 2] ?? '')) {
          end = index + 3;
        } else {
          // inline modifiers, e.g. (?i: or (?i-m:
          const close = pattern.indexOf(':', index + 2);
          end = close === -1 ? index + 2 : close + 1;
        }
      }
      push('group-open', index, end, describeGroup(pattern.slice(index, end)));
      depth += 1;
      index = end;
      continue;
    }

    if (character === ')') {
      depth = Math.max(0, depth - 1);
      push('group-close', index, index + 1, 'End of the group.');
      index += 1;
      continue;
    }

    // --- quantifier -------------------------------------------------------
    if (character === '{') {
      const close = pattern.indexOf('}', index);
      const body = close === -1 ? '' : pattern.slice(index, close + 1);
      if (close !== -1 && /^\{\d*,?\d*\}$/.test(body) && body !== '{}') {
        let end = close + 1;
        if (pattern[end] === '?') end += 1;
        push('quantifier', index, end, describeQuantifier(pattern.slice(index, end)));
        index = end;
        continue;
      }
      // Not a valid quantifier, so it is a literal brace.
      push('literal', index, index + 1, 'A literal { character.');
      index += 1;
      continue;
    }

    if (character === '*' || character === '+' || character === '?') {
      let end = index + 1;
      if (pattern[end] === '?') end += 1;
      push('quantifier', index, end, describeQuantifier(pattern.slice(index, end)));
      index = end;
      continue;
    }

    // --- anchors and the rest ---------------------------------------------
    if (character === '^') {
      push(
        'anchor',
        index,
        index + 1,
        'The start of the text — or the start of any line, with the m flag.',
      );
      index += 1;
      continue;
    }

    if (character === '$') {
      push(
        'anchor',
        index,
        index + 1,
        'The end of the text — or the end of any line, with the m flag.',
      );
      index += 1;
      continue;
    }

    if (character === '.') {
      push(
        'dot',
        index,
        index + 1,
        'Any single character except a line break — unless the s flag is set, when it matches those too.',
      );
      index += 1;
      continue;
    }

    if (character === '|') {
      push('alternation', index, index + 1, 'Either what comes before this, or what comes after.');
      index += 1;
      continue;
    }

    // Coalesce a run of plain literals into one token, so the annotation reads
    // as words rather than as one row per character.
    let end = index;
    while (end < pattern.length && !'\\[](){}*+?^$.|'.includes(pattern[end] ?? '')) end += 1;
    if (end === index) end = index + 1;
    push('literal', index, end, 'Match this text exactly.');
    index = end;
  }

  if (depth > 0) {
    tokens.push({
      kind: 'error',
      text: '',
      start: pattern.length,
      end: pattern.length,
      explanation: depth + ' group' + (depth === 1 ? ' is' : 's are') + ' never closed.',
      depth,
    });
  }

  return tokens;
}

/** Compile, returning the engine's own error rather than a paraphrase of it. */
export function compile(
  pattern: string,
  flags: string,
): { regex: RegExp; error: null } | { regex: null; error: string } {
  try {
    return { regex: new RegExp(pattern, flags), error: null };
  } catch (error) {
    return { regex: null, error: error instanceof Error ? error.message : String(error) };
  }
}
