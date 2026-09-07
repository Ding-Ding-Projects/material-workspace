/**
 * Toy locks and the unlock ladder.
 *
 * The ladder tests are the important ones, and each corresponds to a way the
 * feature turns into a second, far weaker password if it is got wrong.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AttemptBudget,
  POLICIES,
  type Policy,
  elementState,
  factorsOf,
  progress,
  recoveryAdvice,
  searchAppearance,
  stillUnlocked,
} from '../../app/shared/locks';
import {
  BUDGET_WINDOW_MS,
  type Challenge,
  REWARD,
  RUNGS,
  SKIP_BUDGET,
  type SkipRecord,
  fallTo,
  grade,
  grantSkip,
  initialState,
  lockoutWaitMs,
  skipsRemaining,
  startingRung,
} from '../../app/shared/ladder';

const FOLDER = 'C:/Users/someone/AppData/Local/thing';

// -------------------------------------------------------------- policies --

test('all six policies exist and every one names real factors', () => {
  assert.equal(POLICIES.length, 6);
  for (const policy of POLICIES) {
    const factors = factorsOf(policy);
    assert.ok(factors.length >= 1, policy + ' asks for nothing');
    for (const factor of factors) {
      assert.ok(['pin', 'password', 'totp'].includes(factor), policy + ' names ' + factor);
    }
  }
});

test('a multi-factor policy asks for each factor in order', () => {
  const policy: Policy = 'password+pin+totp';
  assert.deepEqual(factorsOf(policy), ['password', 'pin', 'totp']);

  const first = progress(policy, [], FOLDER);
  assert.deepEqual(first, { kind: 'need', factor: 'password', step: 1, of: 3 });

  const second = progress(policy, [{ factor: 'password', matched: true }], FOLDER);
  assert.deepEqual(second, { kind: 'need', factor: 'pin', step: 2, of: 3 });
});

test('every factor must be right, and one wrong one refuses the whole thing', () => {
  const policy: Policy = 'pin+password';
  assert.equal(
    progress(policy, [{ factor: 'pin', matched: true }, { factor: 'password', matched: true }], FOLDER)
      .kind,
    'unlocked',
  );
  assert.equal(
    progress(policy, [{ factor: 'pin', matched: true }, { factor: 'password', matched: false }], FOLDER)
      .kind,
    'refused',
  );
});

test('a factor given out of order is refused rather than accepted late', () => {
  // Otherwise a two-factor policy is satisfied by giving the easy factor twice.
  const out = progress('pin+password', [{ factor: 'password', matched: true }], FOLDER);
  assert.equal(out.kind, 'refused');
});

test('a refusal says nothing about the real value and always names the way out', () => {
  const refused = progress('pin', [{ factor: 'pin', matched: false }], FOLDER);
  assert.equal(refused.kind, 'refused');
  if (refused.kind !== 'refused') return;

  for (const forbidden of ['length', 'character', 'digit', 'close', 'almost', 'starts']) {
    assert.ok(!refused.message.toLowerCase().includes(forbidden), 'leaked: ' + forbidden);
  }
  assert.match(refused.recovery, /AppData/);
});

test('the recovery advice never claims to secure or protect anything', () => {
  const advice = recoveryAdvice(FOLDER);
  assert.ok(!/\bsecure\b|\bprotect(s|ed)?\b|\bencrypt/i.test(advice), advice);
  assert.match(advice, /meant to be undoable/);
});

// --------------------------------------------------------------- budget --

test('the attempt budget slows things down and never escalates or wipes', () => {
  const budget = new AttemptBudget(3, 10_000);
  for (let index = 0; index < 3; index += 1) budget.record('a');
  assert.equal(budget.waitFor('a'), 0, 'it made somebody wait too early');

  budget.record('a');
  assert.equal(budget.waitFor('a'), 10_000);
  budget.record('a');
  // Deliberately NOT longer. A toy lock that locks somebody out harder each
  // time has become the obstacle it was pretending to be.
  assert.equal(budget.waitFor('a'), 10_000, 'the cooldown escalated');
  assert.match(budget.describe('a'), /nothing was deleted/);
});

test('budgets are per target, and a correct answer clears the slate', () => {
  const budget = new AttemptBudget(1, 5000);
  budget.record('a');
  budget.record('a');
  assert.ok(budget.waitFor('a') > 0);
  assert.equal(budget.waitFor('b'), 0, 'one target penalised another');

  budget.clear('a');
  assert.equal(budget.waitFor('a'), 0);
});

// ------------------------------------------------------------- duration --

test('a surface unlock ends when the surface is left', () => {
  const record = {
    target: 't',
    policy: 'pin' as Policy,
    duration: { kind: 'surface' } as const,
    lockedOnLaunch: true,
  };
  assert.equal(stillUnlocked(record, 0, 1000, true), true);
  assert.equal(stillUnlocked(record, 0, 1000, false), false);
});

test('a timed unlock expires, and a session unlock does not', () => {
  const timed = {
    target: 't',
    policy: 'pin' as Policy,
    duration: { kind: 'minutes', minutes: 5 } as const,
    lockedOnLaunch: true,
  };
  assert.equal(stillUnlocked(timed, 0, 4 * 60_000, false), true);
  assert.equal(stillUnlocked(timed, 0, 6 * 60_000, false), false);

  const session = { ...timed, duration: { kind: 'session' } as const };
  assert.equal(stillUnlocked(session, 0, 10 * 60 * 60_000, false), true);
});

// --------------------------------------------------------- element state --

test('a locked element refuses its action but stays an unlock target', () => {
  // A plainly disabled control swallows every event, so clicking a locked
  // thing would do nothing at all and leave somebody with no way in.
  const locked = elementState(true, 'Delete everything');
  assert.equal(locked.actionAllowed, false);
  assert.match(locked.accessibleSuffix, /locked/);
  assert.match(locked.accessibleSuffix, /Activate to unlock/);

  const open = elementState(false, 'Delete everything');
  assert.equal(open.actionAllowed, true);
  assert.equal(open.accessibleSuffix, 'Delete everything');
});

test('a locked item stays in search, labelled, and prompts rather than teleporting past', () => {
  // Hiding it means somebody searching for a thing they locked concludes it is
  // gone; teleporting past the lock makes the lock decorative.
  const found = searchAppearance('Appearance', true, false);
  assert.equal(found.listed, true);
  assert.match(found.label, /locked/);
  assert.equal(found.action, 'prompt-to-unlock');

  // Excluding locked items is the user's own choice, stated where it applies.
  assert.equal(searchAppearance('Appearance', true, true).listed, false);
  assert.equal(searchAppearance('Appearance', false, true).listed, true);
});

// --------------------------------------------------------------- ladder --

test('the ladder starts at dim sum, and at the sums under School mode', () => {
  // Rung one IS a dim sum question, and School mode requires every dim sum
  // capability to behave as though it is not installed - so the rung is absent
  // rather than skipped with a message naming the hidden thing.
  assert.equal(startingRung(false), 'dimsum');
  assert.equal(startingRung(true), 'sums');
  assert.equal(initialState(true).rung, 'sums');
});

test('the rungs fall in order and the bottom is the clock', () => {
  assert.deepEqual(RUNGS, ['dimsum', 'sums', 'moles', 'clock']);
  assert.equal(fallTo('dimsum'), 'sums');
  assert.equal(fallTo('sums'), 'moles');
  assert.equal(fallTo('moles'), 'clock');
  assert.equal(fallTo('clock'), null, 'there is something below the clock');
});

test('winning clears the WAIT and nothing else', () => {
  // "Guess a dumpling" is not an authentication factor and must never be
  // reachable as one. And the budget is never refunded: the moment solving
  // beats waiting, brute force gets cheaper.
  assert.equal(REWARD.clearsWait, true);
  assert.equal(REWARD.grantsSession, false);
  assert.equal(REWARD.extraAttempts, 0);
  assert.equal(REWARD.resetsEscalation, false);
});

test('the skip budget is capped per rolling hour', () => {
  // Four choices is one-in-four and ten small sums are trivial to compute, so
  // a machine can play this. Without the cap the lockout is gone.
  let record: SkipRecord = { grantedAt: [] };
  assert.equal(skipsRemaining(record, 0), SKIP_BUDGET);

  for (let index = 0; index < SKIP_BUDGET; index += 1) record = grantSkip(record, index * 1000);
  assert.equal(skipsRemaining(record, 3000), 0, 'the cap was not enforced');

  // And it frees up again once the window has passed.
  assert.equal(skipsRemaining(record, BUDGET_WINDOW_MS + 10_000), SKIP_BUDGET);
});

test('the underlying lockout still lengthens, whatever the ladder did', () => {
  assert.equal(lockoutWaitMs(1), 30_000);
  assert.equal(lockoutWaitMs(2), 60_000);
  assert.equal(lockoutWaitMs(3), 120_000);
  assert.equal(lockoutWaitMs(99), 30 * 60_000, 'the cap was not applied');
});

// ------------------------------------------------------------- grading --

const dish = (now: number): Challenge => ({
  rung: 'dimsum',
  nonce: 'n1',
  expiresAt: now + 60_000,
  payload: { kind: 'dimsum', imageId: 'har-gow', choices: ['a', 'b', 'c', 'd'], answerIndex: 2 },
});

test('a dish is graded against its own answer', () => {
  assert.equal(grade(dish(0), 2, 0).ok, true);
  assert.equal(grade(dish(0), 1, 0).ok, false);
  assert.equal(grade(dish(0), 'two', 0).ok, false);
});

test('an expired challenge is refused rather than banked', () => {
  const challenge = dish(0);
  assert.equal(grade(challenge, 2, 999_999).ok, false);
});

test('the sums are all-or-nothing, and never say which one was wrong', () => {
  // Saying which would turn ten questions into ten independent one-question
  // challenges.
  const challenge: Challenge = {
    rung: 'sums',
    nonce: 'n',
    expiresAt: 60_000,
    payload: {
      kind: 'sums',
      questions: [
        { a: 3, b: 4, op: '+' },
        { a: 9, b: 2, op: '-' },
      ],
    },
  };
  assert.equal(grade(challenge, [7, 7], 0).ok, true);

  const wrong = grade(challenge, [7, 8], 0);
  assert.equal(wrong.ok, false);
  if (wrong.ok) return;
  assert.ok(!/second|two|2nd/i.test(wrong.reason), 'it named which one: ' + wrong.reason);

  assert.equal(grade(challenge, [7], 0).ok, false, 'a short answer was accepted');
});

// ----------------------------------------------------------------- moles --

const moles = (): Challenge => ({
  rung: 'moles',
  nonce: 'n',
  expiresAt: 10_000,
  payload: {
    kind: 'moles',
    durationMs: 10_000,
    needed: 2,
    schedule: [
      { cell: 1, atMs: 1000, forMs: 800 },
      { cell: 4, atMs: 3000, forMs: 800 },
      { cell: 7, atMs: 5000, forMs: 800 },
    ],
  },
});

test('a timed round cannot be won faster than it lasts', () => {
  // Otherwise a script returns a perfect score the instant it receives the
  // schedule, and the last rung costs nothing.
  const early = grade(moles(), [{ cell: 1, atMs: 1200 }, { cell: 4, atMs: 3200 }], 500);
  assert.equal(early.ok, false);
  if (early.ok) return;
  assert.match(early.reason, /not finished/);
});

test('a hit only counts against a mole that was really there, then', () => {
  const challenge = moles();
  const good = grade(challenge, [{ cell: 1, atMs: 1200 }, { cell: 4, atMs: 3200 }], 10_000);
  assert.equal(good.ok, true);

  // Right cell, wrong moment.
  assert.equal(
    grade(challenge, [{ cell: 1, atMs: 9000 }, { cell: 4, atMs: 3200 }], 10_000).ok,
    false,
  );
  // Empty cell.
  assert.equal(
    grade(challenge, [{ cell: 2, atMs: 1200 }, { cell: 4, atMs: 3200 }], 10_000).ok,
    false,
  );
});

test('one mole cannot be hit twice, so spamming taps does not win', () => {
  // Otherwise "hit the moles" degrades into "send enough taps".
  const spam = Array.from({ length: 50 }, () => ({ cell: 1, atMs: 1200 }));
  const result = grade(moles(), spam, 10_000);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /1 of 2/);
});

test('malformed hits are ignored rather than crashing or counting', () => {
  const rubbish = [null, 'x', { cell: 'one', atMs: 1200 }, { cell: 1 }, { atMs: 1200 }];
  const result = grade(moles(), rubbish, 10_000);
  assert.equal(result.ok, false);
});

test('a non-array answer is refused', () => {
  assert.equal(grade(moles(), 'all of them', 10_000).ok, false);
});
