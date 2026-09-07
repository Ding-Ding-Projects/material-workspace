/**
 * School mode.
 *
 * The tests are weighted towards the two rules most easily half-implemented:
 * that a suppressed capability is ABSENT rather than disabled, and that a
 * rename means the shipped name stops appearing everywhere rather than only on
 * the button.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Capability,
  DEFAULT_STATE,
  SHIPPED_NAME,
  SUPPRESSED,
  type SchoolState,
  checkName,
  dimSumAllowed,
  effectiveFunnyLevel,
  effectiveMode,
  isSuppressed,
  judgeAttempt,
  leaksShippedName,
  nameOf,
  recoveryAdvice,
} from '../../app/shared/school';

const OFF: SchoolState = DEFAULT_STATE;
const ON: SchoolState = { enabled: true, displayName: null };
const RENAMED: SchoolState = { enabled: true, displayName: 'Exam time' };

// ------------------------------------------------------------- defaults --

test('it ships off', () => {
  assert.equal(DEFAULT_STATE.enabled, false);
  assert.equal(DEFAULT_STATE.displayName, null);
});

test('the shipped name is used until somebody renames it', () => {
  assert.equal(nameOf(OFF), SHIPPED_NAME);
  assert.equal(nameOf(RENAMED), 'Exam time');
});

test('a blank or whitespace rename falls back rather than leaving it unnamed', () => {
  assert.equal(nameOf({ enabled: true, displayName: '   ' }), SHIPPED_NAME);
  assert.equal(nameOf({ enabled: true, displayName: '' }), SHIPPED_NAME);
});

// ---------------------------------------------------------- suppression --

test('every listed capability is suppressed while it is on', () => {
  // A hand-written list rather than a rule over what happens to be present. A
  // rule-shaped check passes cleanly on a capability nobody remembered to
  // suppress; this fails when one is missing, which is the direction that
  // matters.
  for (const capability of SUPPRESSED) {
    assert.equal(isSuppressed(capability, ON), true, capability + ' was not suppressed');
    assert.equal(isSuppressed(capability, OFF), false, capability + ' was suppressed while off');
  }
});

test('the list names every dim sum capability, not only the surprise', () => {
  // The surprise is the obvious one and the imagery and code names are the two
  // that get forgotten, because they live in the release notes and the About
  // screen rather than on the main surface.
  const names: readonly Capability[] = SUPPRESSED;
  for (const required of ['dimSumSurprise', 'dimSumImagery', 'dimSumCodeNames'] as const) {
    assert.ok(names.includes(required), required + ' is missing from the suppression list');
  }
});

test('language is forced to English while on, and the choice is kept underneath', () => {
  // Overwriting the stored preference would mean a term of School mode
  // silently costs somebody the language they read in.
  assert.equal(effectiveMode('yue', ON), 'en');
  assert.equal(effectiveMode('bilingual', ON), 'en');
  // The moment it is off, the stored value returns untouched.
  assert.equal(effectiveMode('yue', OFF), 'yue');
  assert.equal(effectiveMode('bilingual', OFF), 'bilingual');
});

test('the funny level is forced fully professional, and kept underneath', () => {
  assert.equal(effectiveFunnyLevel(5, ON), 1);
  assert.equal(effectiveFunnyLevel(5, OFF), 5);
  assert.equal(effectiveFunnyLevel(3, OFF), 3);
});

test('the dim sum draw does not happen while it is on', () => {
  assert.equal(dimSumAllowed(ON), false);
  assert.equal(dimSumAllowed(OFF), true);
});

// -------------------------------------------------------------- rename --

test('after a rename the shipped name must not appear anywhere', () => {
  // The rule most easily half-implemented: the button gets the new name and a
  // search result, a notification or an accessible name keeps the old one.
  assert.equal(leaksShippedName('Turn off School mode', RENAMED), true);
  assert.equal(leaksShippedName('Turn off school mode', RENAMED), true, 'case slipped through');
  assert.equal(leaksShippedName('Turn off Exam time', RENAMED), false);
});

test('nothing leaks when it has not been renamed', () => {
  // The shipped name appearing IS correct when no rename has happened, so the
  // check must not fire there or it would be useless noise.
  assert.equal(leaksShippedName('Turn off School mode', OFF), false);
  assert.equal(leaksShippedName('Turn off School mode', ON), false);
});

test('a rename is refused only when it would break something', () => {
  assert.equal(checkName('Exam time').ok, true);
  assert.equal(checkName('  Quiet  ').ok, true);
  assert.equal(checkName('').ok, false);
  assert.equal(checkName('   ').ok, false);
  assert.equal(checkName('x'.repeat(100)).ok, false);
});

// -------------------------------------------------------------- unlock --

test('a wrong attempt says nothing about the real value', () => {
  // The refusal rules apply to a toy lock exactly as to a real credential:
  // never how close it was, never how long the real one is, never a prefix.
  const result = judgeAttempt(false, ON, 'C:/data/folder');
  assert.equal(result.ok, false);
  if (result.ok) return;

  for (const forbidden of ['character', 'length', 'digit', 'close', 'almost']) {
    assert.ok(
      !result.reason.toLowerCase().includes(forbidden),
      'the refusal mentioned ' + forbidden,
    );
  }
});

test('a wrong attempt always names the way out', () => {
  // A lock must never be the only thing between somebody and their own
  // content, so recovery is stated at the point of failure rather than buried.
  const result = judgeAttempt(false, ON, 'C:/data/folder');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.recovery, /C:\/data\/folder/);
  assert.match(result.recovery, /not security/);
});

test('the refusal uses the chosen name, never the shipped one', () => {
  const result = judgeAttempt(false, RENAMED, 'C:/data/folder');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /Exam time/);
  assert.equal(leaksShippedName(result.reason, RENAMED), false);
});

test('a correct attempt simply succeeds', () => {
  assert.deepEqual(judgeAttempt(true, ON, 'C:/data/folder'), { ok: true });
});

test('the recovery advice names the real folder and admits what this is', () => {
  const advice = recoveryAdvice('/home/someone/.config/thing');
  assert.match(advice, /\/home\/someone\/\.config\/thing/);
  // Never described as securing or protecting anything.
  assert.ok(!/\bsecure\b|\bprotect(s|ed)?\b|\bencrypt/i.test(advice), advice);
  assert.match(advice, /meant to be undoable/);
});
