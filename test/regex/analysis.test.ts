/**
 * The regular-expression analysis core.
 *
 * These assertions are written to fail when the analysis is WRONG, not merely
 * when it is absent. A scanner that returns an empty array for everything would
 * pass a test that only checks "no exception was thrown", so every case here
 * pins a specific expected finding, and the negative cases pin the ABSENCE of a
 * finding on input that must not trigger one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyseSafety,
  runMatches,
  runReplacement,
  EVALUATION_LIMITS,
} from '../../app/renderer/components/regex/safety.js';
import { compile, tokenize } from '../../app/renderer/components/regex/tokenize.js';
import {
  capabilities,
  engineIdentity,
  flagConflicts,
} from '../../app/renderer/components/regex/engine.js';

/**
 * Built by concatenation rather than written as a literal.
 *
 * A dollar sign adjacent to a quote is the single most fragile character to move
 * through a shell into source, and it corrupted this file once already. Building
 * the anchor separately makes the test immune to however it is edited next.
 */
const END_ANCHOR = String.fromCharCode(36);
const CATASTROPHIC = '(a+)+' + END_ANCHOR;

describe('tokenizer', () => {
  it('describes each construct rather than restating it', () => {
    const tokens = tokenize('^(?<year>\\d{4})-(\\d{2})' + END_ANCHOR);
    const kinds = tokens.map((token) => token.kind);

    assert.ok(kinds.includes('anchor'), 'the ^ must be recognised as an anchor');
    assert.ok(kinds.includes('group-open'), 'the group must be recognised');
    assert.ok(kinds.includes('escape'), 'the \\d must be recognised as an escape');
    assert.ok(kinds.includes('quantifier'), 'the {4} must be recognised as a quantifier');

    const named = tokens.find((token) => token.text.startsWith('(?<year>'));
    assert.ok(named, 'the named group must be one token');
    assert.match(named.explanation, /named "year"/);

    const quantifier = tokens.find((token) => token.text === '{4}');
    assert.ok(quantifier);
    assert.match(quantifier.explanation, /exactly 4 times/);
  });

  it('distinguishes greedy from lazy', () => {
    const greedy = tokenize('a+').find((token) => token.kind === 'quantifier');
    const lazy = tokenize('a+?').find((token) => token.kind === 'quantifier');
    assert.ok(greedy && lazy);
    assert.match(greedy.explanation, /Greedy/);
    assert.match(lazy.explanation, /Lazy/);
    assert.equal(lazy.text, '+?', 'the lazy marker belongs to the quantifier token');
  });

  it('treats a character class as ONE token, including a bracket inside it', () => {
    const tokens = tokenize('[]a-z]x');
    const cls = tokens.find((token) => token.kind === 'class');
    assert.ok(cls, 'a class must be produced');
    assert.equal(cls.text, '[]a-z]', 'a leading bracket is a literal, not the terminator');
  });

  it('does not mistake a brace that is not a quantifier for one', () => {
    const tokens = tokenize('a{hello}');
    assert.ok(
      !tokens.some((token) => token.kind === 'quantifier'),
      'a brace run that is not a repetition must not be reported as one',
    );
  });

  it('reports an unterminated construct as an error rather than throwing', () => {
    const unterminatedClass = tokenize('[abc');
    assert.ok(unterminatedClass.some((token) => token.kind === 'error'));

    const unclosedGroup = tokenize('(abc');
    assert.ok(
      unclosedGroup.some(
        (token) => token.kind === 'error' && /never closed/.test(token.explanation),
      ),
    );
  });

  it('coalesces plain literals so the annotation reads as words', () => {
    const tokens = tokenize('hello');
    assert.equal(tokens.length, 1, 'five letters must not become five rows');
    assert.equal(tokens[0]?.text, 'hello');
  });

  it('returns the engine error verbatim rather than a paraphrase', () => {
    const bad = compile('(', '');
    assert.equal(bad.regex, null);
    assert.ok(typeof bad.error === 'string' && bad.error.length > 0);

    const good = compile('a', 'g');
    assert.ok(good.regex instanceof RegExp);
    assert.equal(good.error, null);
  });
});

describe('safety analysis', () => {
  it('flags the classic catastrophic-backtracking shape', () => {
    const warnings = analyseSafety(CATASTROPHIC);
    const danger = warnings.find((warning) => warning.severity === 'danger');
    assert.ok(danger, 'a repeated group that itself repeats must be flagged as dangerous');
    assert.match(danger.title, /repeated group/i);
  });

  it('flags a quantified group containing alternation', () => {
    const warnings = analyseSafety('(a|b)*c');
    assert.ok(
      warnings.some((warning) => /alternation/i.test(warning.title)),
      'a repeated alternation must at least raise a caution',
    );
  });

  it('does NOT flag an ordinary safe pattern', () => {
    // The negative case matters most. A scanner that warns about everything is
    // as useless as one that warns about nothing, and it trains people to
    // ignore it.
    assert.deepEqual(analyseSafety('^\\d{4}-\\d{2}-\\d{2}' + END_ANCHOR), []);
    assert.deepEqual(analyseSafety('[a-z]+@[a-z]+\\.[a-z]{2,}'), []);
  });

  it('refuses a pattern longer than it will evaluate', () => {
    const huge = 'a'.repeat(EVALUATION_LIMITS.maxPatternLength + 1);
    const warnings = analyseSafety(huge);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.severity, 'danger');
  });
});

describe('bounded evaluation', () => {
  it('finds every match with positions and groups', () => {
    const { regex } = compile('(\\w+)@(\\w+)', 'g');
    assert.ok(regex);
    const result = runMatches(regex, 'a@b and cc@dd');
    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0]?.text, 'a@b');
    assert.equal(result.matches[0]?.index, 0);
    assert.equal(result.matches[1]?.text, 'cc@dd');
    assert.equal(result.matches[1]?.groups[0]?.value, 'cc');
    assert.equal(result.error, null);
  });

  it('terminates on a zero-width match instead of spinning forever', () => {
    // Without the explicit lastIndex advance this loops until the deadline and
    // looks exactly like catastrophic backtracking, which is a different bug
    // with a completely different fix.
    const { regex } = compile('a*', 'g');
    assert.ok(regex);
    const result = runMatches(regex, 'bbb');
    assert.ok(result.matches.length > 0, 'zero-width matches are still matches');
    assert.ok(result.matches.length <= 10, 'it must not run away on a three-character sample');
    assert.equal(result.error, null);
  });

  /**
   * Documents a REAL limitation rather than asserting a bound that does not
   * exist.
   *
   * An earlier version of this test expected runMatches to honour its
   * wall-clock deadline on a catastrophic pattern. It does not, and cannot: the
   * check runs between matches, and exec() never returns control for it to run.
   * Measured here at 94 SECONDS against a stated 750ms limit.
   *
   * The in-thread protection is therefore the static scanner refusing to let a
   * dangerous shape through unflagged, and termination of a worker for anything
   * that does run. Both are proved — this test, and termination.test.ts.
   */
  it('cannot bound backtracking in-thread, so the static scanner must catch it first', () => {
    const warnings = analyseSafety(CATASTROPHIC);
    assert.ok(
      warnings.some((warning) => warning.severity === 'danger'),
      'the only in-thread protection is flagging it, so it must be flagged',
    );

    // A short input still completes, proving the function itself is correct. It
    // is the ADVERSARIAL input that cannot be bounded here.
    const { regex } = compile(CATASTROPHIC, '');
    assert.ok(regex);
    const result = runMatches(regex, 'aaaa');
    assert.equal(result.error, null);
    assert.equal(result.matches.length, 1);
  });

  it('reports truncation rather than presenting partial results as complete', () => {
    const { regex } = compile('a', 'g');
    assert.ok(regex);
    const result = runMatches(regex, 'a'.repeat(EVALUATION_LIMITS.maxMatches + 500));
    assert.equal(result.truncated, true);
    assert.ok(result.truncatedReason && result.truncatedReason.length > 0);
    assert.equal(result.matches.length, EVALUATION_LIMITS.maxMatches);
  });

  it('applies a replacement template', () => {
    const { regex } = compile('(\\d+)', 'g');
    assert.ok(regex);
    const replaced = runReplacement(regex, 'a1 b22', '[$1]');
    assert.equal(replaced.output, 'a[1] b[22]');
    assert.equal(replaced.error, null);
  });
});

describe('engine capabilities', () => {
  it('detects capabilities rather than asserting them', () => {
    const detected = capabilities();
    const named = detected.find((capability) => capability.id === 'named-groups');
    assert.ok(named, 'named groups must be in the matrix');
    assert.equal(named.supported, true, 'this runtime does support named groups');
  });

  it('keeps genuinely absent constructs VISIBLE with an explanation', () => {
    const detected = capabilities();
    const atomic = detected.find((capability) => capability.id === 'atomic-groups');
    assert.ok(atomic, 'an unsupported construct must still be listed');
    assert.equal(atomic.supported, false);
    assert.ok(atomic.note.length > 20, 'it must explain, not merely say no');
  });

  it('names the flags it detected', () => {
    const identity = engineIdentity();
    const insensitive = identity.flags.find((flag) => flag.flag === 'i');
    assert.ok(insensitive?.supported);
  });

  it('reports mutually exclusive flags instead of silently dropping one', () => {
    assert.equal(flagConflicts('gi').length, 0);
    assert.equal(flagConflicts('uv').length, 1);
  });
});
