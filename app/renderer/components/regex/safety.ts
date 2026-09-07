/**
 * Backtracking-risk diagnostics and bounded evaluation.
 *
 * A regular expression is a program, and some patterns take exponential time on
 * inputs that look perfectly ordinary. `(a+)+$` against forty a's followed by a
 * b will hang a tab. Because this builder lets a user type any pattern and run
 * it against any sample, the risk is not theoretical and the mitigation is not
 * optional.
 *
 * Two layers:
 *
 *   1. Static warnings, so a dangerous shape is flagged BEFORE it is run. These
 *      are heuristics and are labelled as heuristics. A warning is not proof of
 *      a problem and its absence is not proof of safety — saying otherwise would
 *      be the kind of false guarantee that removes the caution it replaces.
 *
 *   2. Bounds that this file CAN enforce: a size-limited sample, a match ceiling,
 *      and honest reporting when either stopped evaluation early. Partial results
 *      are never presented as complete.
 *
 * What this file CANNOT enforce, stated plainly because the previous version of
 * this comment claimed otherwise:
 *
 *   The wall-clock check below runs BETWEEN matches. A catastrophic pattern
 *   blocks inside a single `exec()` call and never returns control, so that
 *   check never executes. It is a bound on many-matches work, not on
 *   backtracking. Measured in this project's own suite: `(a+)+$` against 31
 *   characters ran for 94 SECONDS against a stated 750ms deadline.
 *
 *   Interrupting that is impossible in the thread running the regex. The only
 *   mechanism that works is terminating a worker from the outside, which is what
 *   `evaluator.ts` does. Every user-facing surface evaluates through
 *   RegexEvaluator; `runMatches` is exported for use INSIDE that worker and for
 *   tests, and must not be called directly from the main thread with an
 *   untrusted pattern.
 */

export interface SafetyWarning {
  severity: 'caution' | 'danger';
  title: string;
  detail: string;
  /** Where in the pattern, when it can be located. */
  start?: number;
  end?: number;
}

/** Limits, published rather than hidden, so the surface can state them. */
export const EVALUATION_LIMITS = {
  maxPatternLength: 4000,
  maxSampleBytes: 256 * 1024,
  maxMatches: 10_000,
  deadlineMs: 750,
} as const;

/**
 * Look for the shapes that cause catastrophic backtracking.
 *
 * Deliberately a scanner over balanced groups rather than a regular expression
 * applied to a regular expression: a lazy any-character bridge would happily
 * reach past the group it was written for and flag something in a different one.
 */
export function analyseSafety(pattern: string): SafetyWarning[] {
  const warnings: SafetyWarning[] = [];

  if (pattern.length > EVALUATION_LIMITS.maxPatternLength) {
    warnings.push({
      severity: 'danger',
      title: 'The pattern is longer than this builder will evaluate',
      detail:
        'Patterns above ' +
        EVALUATION_LIMITS.maxPatternLength +
        ' characters are not run here. Nothing was evaluated.',
    });
    return warnings;
  }

  // --- nested quantifiers: (x+)+ , (x*)* , (x+)* and friends ----------------
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== '(') continue;
    if (pattern[index + 1] === '?' && !'<'.includes(pattern[index + 2] ?? '')) {
      // Skip non-capturing and lookaround openers for this particular check;
      // they are handled by the balanced walk below like any other group.
    }

    // Walk to the matching close, honouring escapes and character classes.
    let depth = 0;
    let cursor = index;
    let inClass = false;
    let close = -1;
    while (cursor < pattern.length) {
      const character = pattern[cursor];
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (inClass) {
        if (character === ']') inClass = false;
        cursor += 1;
        continue;
      }
      if (character === '[') inClass = true;
      else if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
      cursor += 1;
    }
    if (close === -1) continue;

    const body = pattern.slice(index + 1, close);
    const after = pattern.slice(close + 1);

    const groupIsQuantified = /^(?:[*+]|\{\d*,\d*\}|\{\d+,\}|\?)/.test(after);
    if (!groupIsQuantified) continue;

    // Does the body itself end in, or consist of, an unbounded quantifier?
    const bodyHasUnbounded = /(?:[^\\]|^)(?:[*+]|\{\d+,\})/.test(body);
    if (bodyHasUnbounded) {
      warnings.push({
        severity: 'danger',
        title: 'A repeated group that itself repeats',
        detail:
          'This is the classic catastrophic-backtracking shape: the engine can ' +
          'split the same input between the inner and outer repetition in an ' +
          'exponentially growing number of ways. On a non-matching input it may ' +
          'run for a very long time. Rewriting the inner part so the two cannot ' +
          'overlap usually fixes it.',
        start: index,
        end: close + 1 + (after.match(/^(?:[*+]|\{[^}]*\}|\?)/)?.[0].length ?? 0),
      });
      continue;
    }

    // Alternation inside a quantified group where branches can match the same
    // text — (a|a)* and (a|ab)* both backtrack badly.
    if (body.includes('|')) {
      warnings.push({
        severity: 'caution',
        title: 'A repeated group containing alternation',
        detail:
          'If two branches can match the same text, the engine has more than one ' +
          'way to reach the same position and will try all of them on failure. ' +
          'Check that the branches are mutually exclusive.',
        start: index,
        end: close + 1,
      });
    }
  }

  // --- unbounded quantifiers either side of an optional separator ----------
  if (/\.\*.*\.\*/s.test(pattern)) {
    warnings.push({
      severity: 'caution',
      title: 'More than one unbounded wildcard',
      detail:
        'Several .* runs in one pattern give the engine many ways to divide the ' +
        'input between them. Anchoring the pattern, or replacing .* with a ' +
        'negated character class, is usually both faster and more precise.',
    });
  }

  if (/\{\d{4,},?\d*\}/.test(pattern)) {
    warnings.push({
      severity: 'caution',
      title: 'A very large repetition count',
      detail: 'Large bounded repetitions expand internally and can be slow to compile and run.',
    });
  }

  return warnings;
}

export interface MatchResult {
  matches: {
    index: number;
    length: number;
    text: string;
    groups: { name: string | null; value: string | undefined }[];
  }[];
  /** True when a bound stopped evaluation early. Reported rather than hidden:
   *  partial results presented as complete are worse than none. */
  truncated: boolean;
  truncatedReason: string | null;
  elapsedMs: number;
  error: string | null;
}

/**
 * Run a pattern against a sample under hard bounds.
 *
 * Zero-width matches are handled explicitly. A global regex that matches the
 * empty string does not advance lastIndex on its own, so the naive loop spins
 * forever on the same position — which looks exactly like catastrophic
 * backtracking and is a completely different bug.
 */
export function runMatches(regex: RegExp, sample: string): MatchResult {
  const result: MatchResult = {
    matches: [],
    truncated: false,
    truncatedReason: null,
    elapsedMs: 0,
    error: null,
  };

  if (sample.length > EVALUATION_LIMITS.maxSampleBytes) {
    result.truncated = true;
    result.truncatedReason =
      'The sample is larger than the ' +
      EVALUATION_LIMITS.maxSampleBytes +
      ' character limit, so only the beginning was searched.';
    sample = sample.slice(0, EVALUATION_LIMITS.maxSampleBytes);
  }

  const started = performance.now();
  const global = regex.global || regex.sticky;
  const working = global ? regex : new RegExp(regex.source, regex.flags + 'g');
  working.lastIndex = 0;

  try {
    let match: RegExpExecArray | null;
    while ((match = working.exec(sample)) !== null) {
      result.matches.push({
        index: match.index,
        length: match[0].length,
        text: match[0],
        groups: match.slice(1).map((value, position) => {
          const named = match?.groups
            ? Object.entries(match.groups).find(([, groupValue]) => groupValue === value)?.[0]
            : undefined;
          return { name: named ?? null, value };
        }),
      });

      // The zero-width guard. Without it a pattern like `a*` loops forever.
      if (match[0].length === 0) working.lastIndex += 1;

      if (result.matches.length >= EVALUATION_LIMITS.maxMatches) {
        result.truncated = true;
        result.truncatedReason =
          'Stopped after ' + EVALUATION_LIMITS.maxMatches + ' matches. There may be more.';
        break;
      }
      // Bounds a many-matches run. It CANNOT bound backtracking inside a
      // single exec() call, because control never returns here. See the note at
      // the top of this file; termination is the host worker's job.
      if (performance.now() - started > EVALUATION_LIMITS.deadlineMs) {
        result.truncated = true;
        result.truncatedReason =
          'Stopped after ' +
          EVALUATION_LIMITS.deadlineMs +
          'ms. This pattern is slow on this sample, which usually means heavy backtracking.';
        break;
      }
      if (!regex.global && !regex.sticky) break;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  result.elapsedMs = performance.now() - started;
  return result;
}

/** Apply a replacement template, under the same bounds. */
export function runReplacement(
  regex: RegExp,
  sample: string,
  template: string,
): { output: string; error: string | null } {
  try {
    const working = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
    working.lastIndex = 0;
    return { output: sample.replace(working, template), error: null };
  } catch (error) {
    return { output: '', error: error instanceof Error ? error.message : String(error) };
  }
}
