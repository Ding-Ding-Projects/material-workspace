/**
 * Governance conformance.
 *
 * These are the rules where getting it wrong is not a bug report — it is a
 * disclosure, a destroyed record, or a scanner people switch off. So each one
 * is asserted against the case it exists to prevent rather than the happy path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Label,
  decideExport,
  decideLabelChange,
  highest,
  inheritLabel,
  isMoreSensitive,
} from '../../app/main/governance/classification';
import {
  type Finding,
  hkidCheckDigit,
  luhn,
  preview,
  scan,
  summarise as summariseFindings,
} from '../../app/main/governance/dlp';
import {
  type HeldRecord,
  type RetentionPolicy,
  actionable,
  addMonths,
  assess,
  summarise as summariseRetention,
} from '../../app/main/governance/retention';

// --------------------------------------------------------- classification --

test('an unlabelled document is UNKNOWN, which outranks public', () => {
  // Treating "nobody looked" as "least sensitive" is how a gap in process
  // becomes a disclosure.
  assert.equal(isMoreSensitive('unknown', 'public'), true);
  assert.equal(isMoreSensitive('internal', 'unknown'), true);
});

test('raising a label is always allowed and needs no justification', () => {
  const decision = decideLabelChange({
    from: { sensitivity: 'internal', by: 'ada', at: '2026-01-01T00:00:00Z' },
    to: 'restricted',
    by: 'bob',
    at: '2026-02-01T00:00:00Z',
  });
  assert.ok(decision.allowed && decision.raised);
});

test('lowering a label without authority is refused, naming who lacks it', () => {
  const decision = decideLabelChange({
    from: { sensitivity: 'restricted', by: 'ada', at: '2026-01-01T00:00:00Z' },
    to: 'public',
    by: 'bob',
    at: '2026-02-01T00:00:00Z',
    justification: 'this is a long enough justification',
  });
  assert.ok(!decision.allowed);
  assert.ok(decision.reason.includes('bob'));
});

test('lowering WITH authority still needs a written reason', () => {
  const tooShort = decideLabelChange({
    from: { sensitivity: 'confidential', by: 'ada', at: '2026-01-01T00:00:00Z' },
    to: 'internal',
    by: 'ada',
    at: '2026-02-01T00:00:00Z',
    mayLower: true,
    justification: 'ok',
  });
  assert.ok(!tooShort.allowed);
  assert.ok(tooShort.reason.includes('justification'));

  const proper = decideLabelChange({
    from: { sensitivity: 'confidential', by: 'ada', at: '2026-01-01T00:00:00Z' },
    to: 'internal',
    by: 'ada',
    at: '2026-02-01T00:00:00Z',
    mayLower: true,
    justification: 'The contract completed and the commercial terms are now published.',
  });
  assert.ok(proper.allowed);
  assert.ok(proper.label.justification !== undefined);
});

test('a derived document inherits the HIGHEST label of its sources', () => {
  // Pasting from a restricted document into an unlabelled one and keeping the
  // unlabelled label is the most common way classified material escapes.
  const sources: Label[] = [
    { sensitivity: 'public', by: 'ada', at: '2026-01-01T00:00:00Z' },
    { sensitivity: 'restricted', by: 'bob', at: '2026-01-01T00:00:00Z' },
    { sensitivity: 'internal', by: 'cheung', at: '2026-01-01T00:00:00Z' },
  ];
  const derived = inheritLabel(sources, 'ada', '2026-02-01T00:00:00Z');
  assert.equal(derived.sensitivity, 'restricted');
  assert.deepEqual(derived.derivedFrom, ['public', 'restricted', 'internal']);
});

test('the highest of nothing is unknown, not public', () => {
  assert.equal(highest([]), 'unknown');
});

test('an export beyond what a destination may receive is REFUSED, not warned', () => {
  // A warning that can be clicked past is a warning that will be, and the
  // person clicking past it is usually in a hurry for the reason that makes it
  // a bad idea.
  const decision = decideExport(
    { sensitivity: 'restricted', by: 'ada', at: '2026-01-01T00:00:00Z' },
    { description: 'A public website', maximum: 'public', external: true },
  );
  assert.ok(!decision.allowed);
  assert.ok(decision.reason.includes('restricted'));
});

test('an unlabelled export is allowed but says nobody has assessed it', () => {
  const decision = decideExport(undefined, {
    description: 'An internal share',
    maximum: 'internal',
    external: false,
  });
  assert.ok(decision.allowed);
  assert.ok(decision.warnings.some((warning) => warning.includes('not the same as it being public')));
});

test('sending internal material outside the organisation warns, without blocking', () => {
  const decision = decideExport(
    { sensitivity: 'internal', by: 'ada', at: '2026-01-01T00:00:00Z' },
    { description: 'A supplier', maximum: 'confidential', external: true },
  );
  assert.ok(decision.allowed);
  assert.ok(decision.warnings.some((warning) => warning.includes('outside the organisation')));
});

// ------------------------------------------------------------------- DLP --

test('the Luhn check rejects sixteen arbitrary digits', () => {
  // Without it, any sixteen digits look like a card number: a phone number, an
  // order reference, a row of measurements.
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('1234567812345678'), false);
  assert.equal(luhn('4111 1111 1111 1111'), true);
});

test('the Hong Kong identity check digit is verified', () => {
  // A123456(3) is the example published with the algorithm, so this is an
  // independent confirmation rather than a test of the code against itself.
  assert.equal(hkidCheckDigit('A123456(3)'), true);
  assert.equal(hkidCheckDigit('A123456(4)'), false);

  // Two-letter prefixes take a different weighting. The expected digits here
  // were computed from the published algorithm, not guessed — the first
  // version of this test asserted (2) and was simply wrong.
  assert.equal(hkidCheckDigit('AB987654(3)'), true);
  assert.equal(hkidCheckDigit('AB987654(2)'), false);

  // And a single-letter prefix that is not A, to prove the padding is applied
  // rather than the letter being special-cased.
  assert.equal(hkidCheckDigit('C123456(9)'), true);
});

test('a card number is found, and a plain sixteen-digit run is not', () => {
  const findings = scan('card 4111 1111 1111 1111 and reference 1234567812345678');
  const cards = findings.filter((finding) => finding.kind === 'card');
  assert.equal(cards.length, 1);
});

test('a preview never discloses the match', () => {
  // The whole point is that the matched text is sensitive; a log or a report
  // carrying it moves the secret somewhere with weaker protection.
  const shown = preview('4111111111111111');
  assert.ok(!shown.includes('111111111111'));
  assert.ok(shown.startsWith('41'));
  assert.ok(shown.endsWith('11'));
  assert.equal(preview('abc'), '···');
});

test('a private key header and an API token are found', () => {
  const findings = scan(
    '-----BEGIN RSA PRIVATE KEY-----\nand ghp_abcdefghijklmnopqrstuvwxyz012345',
  );
  const kinds = new Set(findings.map((finding) => finding.kind));
  assert.ok(kinds.has('privateKey'));
  assert.ok(kinds.has('apiToken'));
});

test('a long random string is NOT reported as a token', () => {
  // Base64 data, hashes and identifiers all look the same. Matching them makes
  // the scanner useless, and a useless scanner gets switched off.
  const findings = scan('hash 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a');
  assert.equal(findings.filter((finding) => finding.kind === 'apiToken').length, 0);
});

test('every finding that can be a false positive says so', () => {
  const findings = scan('card 4111 1111 1111 1111');
  const card = findings.find((finding) => finding.kind === 'card');
  assert.ok(card?.caveat !== undefined);
  assert.ok(card.caveat.includes('test number'));
});

test('scanning twice gives the same answer', () => {
  // A shared global regular expression carries lastIndex between calls, so the
  // second scan silently starts partway through and finds less.
  const text = 'card 4111 1111 1111 1111 and card 4111 1111 1111 1111';
  const first = scan(text);
  const second = scan(text);
  assert.equal(first.length, second.length);
  assert.ok(first.length >= 2);
});

test('findings are bounded, so a huge document cannot stall the process', () => {
  const text = ('someone@example.com ').repeat(2000);
  assert.ok(scan(text, { maxFindings: 50 }).length <= 50);
});

test('ignored kinds are skipped', () => {
  const text = 'write to someone@example.com';
  assert.ok(scan(text).some((finding) => finding.kind === 'email'));
  assert.equal(scan(text, { ignoring: ['email'] }).length, 0);
});

test('a summary counts by kind and reports the highest confidence', () => {
  const findings: Finding[] = scan(
    'someone@example.com and -----BEGIN PRIVATE KEY-----',
  );
  const summary = summariseFindings(findings);
  assert.equal(summary.highest, 'high');
  assert.ok(summary.byKind.some((entry) => entry.kind === 'privateKey'));
  assert.equal(summariseFindings([]).highest, 'none');
});

// ------------------------------------------------------------- retention --

test('adding months clamps the day rather than rolling over', () => {
  // 31 January plus one month is 28 February, not 3 March. Rolling over means
  // destroying a record a month early or keeping it a month late, every time.
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(addMonths('2026-01-15', 12), '2027-01-15');
});

const sevenYears: RetentionPolicy = {
  id: 'contracts',
  name: 'Contracts',
  trigger: 'closed',
  months: 84,
  action: 'review',
  reason: 'Statutory minimum for commercial contracts.',
};

function record(overrides: Partial<HeldRecord> = {}): HeldRecord {
  return {
    id: 'r1',
    policyId: 'contracts',
    created: '2015-01-01',
    modified: '2016-01-01',
    ...overrides,
  };
}

test('a legal hold outranks every policy, and says so', () => {
  const assessment = assess(
    record({
      closed: '2000-01-01',
      hold: { by: 'legal', at: '2026-01-01', reason: 'Pending litigation.' },
    }),
    [sevenYears],
    '2026-06-01',
  );
  assert.equal(assessment.state, 'held');
  assert.ok(assessment.explanation.includes('outranks every retention policy'));
});

test('a clock that has not started means NOT due, not immediately due', () => {
  // Treating a missing start date as "now" would make an open contract
  // instantly expired.
  const assessment = assess(record(), [sevenYears], '2030-01-01');
  assert.equal(assessment.state, 'noStart');
  assert.ok(assessment.explanation.includes('has not happened yet'));
});

test('the clock starts at the EVENT, not at creation', () => {
  // "Seven years after the contract ends" and "seven years after the file was
  // made" are different dates, and the wrong one destroys records early.
  const assessment = assess(record({ closed: '2020-06-15' }), [sevenYears], '2026-01-01');
  assert.equal(assessment.startedAt, '2020-06-15');
  assert.equal(assessment.dueAt, '2027-06-15');
  assert.equal(assessment.state, 'notDue');
});

test('a due record is reported as due, with the action and the reason', () => {
  const assessment = assess(record({ closed: '2018-01-01' }), [sevenYears], '2025-02-01');
  assert.equal(assessment.state, 'due');
  assert.ok(assessment.explanation.includes('review'));
  assert.ok(assessment.explanation.includes('Statutory minimum'));
  // And nothing was done.
  assert.ok(assessment.explanation.includes('Nothing has been done automatically'));
});

test('a record long past its date is overdue, not merely due', () => {
  const assessment = assess(record({ closed: '2010-01-01' }), [sevenYears], '2026-01-01');
  assert.equal(assessment.state, 'overdue');
});

test('a record whose policy does not exist is KEPT', () => {
  const assessment = assess(record({ policyId: 'nope', closed: '2000-01-01' }), [sevenYears], '2026-01-01');
  assert.equal(assessment.state, 'noStart');
  assert.ok(assessment.explanation.includes('It is kept'));
});

test('the actionable list excludes held records entirely', () => {
  // Not sorted to the bottom: they are not actionable, and putting them in a
  // list of things to do is how somebody deletes one.
  const assessments = [
    assess(record({ id: 'a', closed: '2010-01-01' }), [sevenYears], '2026-01-01'),
    assess(
      record({
        id: 'b',
        closed: '2010-01-01',
        hold: { by: 'legal', at: '2026-01-01', reason: 'Litigation.' },
      }),
      [sevenYears],
      '2026-01-01',
    ),
  ];
  const list = actionable(assessments);
  assert.deepEqual(list.map((assessment) => assessment.record.id), ['a']);
});

test('overdue records sort above merely due ones', () => {
  const assessments = [
    assess(record({ id: 'due', closed: '2018-01-01' }), [sevenYears], '2025-02-01'),
    assess(record({ id: 'overdue', closed: '2010-01-01' }), [sevenYears], '2025-02-01'),
  ];
  assert.deepEqual(
    actionable(assessments).map((assessment) => assessment.record.id),
    ['overdue', 'due'],
  );
});

test('a summary counts every state', () => {
  const assessments = [
    assess(record({ id: 'a', closed: '2010-01-01' }), [sevenYears], '2026-01-01'),
    assess(record({ id: 'b' }), [sevenYears], '2026-01-01'),
    assess(
      record({ id: 'c', closed: '2010-01-01', hold: { by: 'legal', at: '2026-01-01', reason: 'x' } }),
      [sevenYears],
      '2026-01-01',
    ),
  ];
  const summary = summariseRetention(assessments);
  assert.equal(summary.total, 3);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.held, 1);
  assert.equal(summary.unknown, 1);
});
