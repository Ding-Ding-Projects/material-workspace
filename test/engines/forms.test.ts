/**
 * Forms engine conformance.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Field,
  type FormDefinition,
  type Submission,
  answerCounts,
  checkDefinition,
  emptyForm,
  newField,
  submissionsToCsv,
  validateField,
  validateSubmission,
} from '../../app/engines/forms/model';

function form(fields: Field[]): FormDefinition {
  return { ...emptyForm(), title: 'Test', fields };
}

function field(overrides: Partial<Field> = {}): Field {
  return { ...newField('text'), ...overrides };
}

// ----------------------------------------------------------- single field --

test('a required field refuses an empty answer', () => {
  const problem = validateField(field({ label: 'Name', required: true }), '');
  assert.ok(problem?.message.includes('is required'));
});

test('an optional field accepts an empty answer', () => {
  assert.equal(validateField(field({ label: 'Nickname' }), ''), undefined);
  assert.equal(validateField(field({ label: 'Nickname' }), null), undefined);
});

test('a number field refuses text, quoting what was typed', () => {
  const problem = validateField(field({ kind: 'number', label: 'Age' }), 'twelve');
  assert.ok(problem?.message.includes('must be a number'));
  assert.ok(problem?.message.includes('twelve'));
});

test('a range is enforced at both ends', () => {
  const bounded = field({ kind: 'number', label: 'Rating', min: 1, max: 5 });
  assert.ok(validateField(bounded, 0)?.message.includes('at least 1'));
  assert.ok(validateField(bounded, 6)?.message.includes('at most 5'));
  assert.equal(validateField(bounded, 3), undefined);
});

test('an email is checked for shape, not against the full specification', () => {
  // The real grammar permits things nobody types and rejects nothing anybody
  // does. Refusing a valid unusual address is worse than accepting an invalid
  // ordinary one, which will simply bounce.
  const email = field({ kind: 'email', label: 'Email' });
  assert.equal(validateField(email, 'someone@example.com'), undefined);
  assert.ok(validateField(email, 'not an address')?.message.includes('email address'));
  assert.ok(validateField(email, 'missing@dot')?.message.includes('email address'));
});

test('a choice must be one of the listed options', () => {
  const choice = field({ kind: 'choice', label: 'Size', options: ['Small', 'Large'] });
  assert.equal(validateField(choice, 'Small'), undefined);
  assert.ok(validateField(choice, 'Medium')?.message.includes('one of the listed choices'));
});

test('a choice with NO options blames the form, not the answer', () => {
  // It cannot be answered at all, so saying so points at whoever can fix it.
  const broken = field({ kind: 'choice', label: 'Size', options: [] });
  assert.ok(validateField(broken, 'anything')?.message.includes('no options'));
});

test('a date that does not exist is refused', () => {
  const when = field({ kind: 'date', label: 'When' });
  assert.equal(validateField(when, '2026-03-15'), undefined);
  assert.ok(validateField(when, '2026-02-30')?.message.includes('no such date'));
});

// -------------------------------------------------------------- the whole --

test('every problem is reported at once, not one per attempt', () => {
  // One per attempt turns a form into a guessing game with no way to know how
  // many rounds are left.
  const definition = form([
    field({ id: 'a', label: 'Name', required: true }),
    field({ id: 'b', kind: 'number', label: 'Age' }),
    field({ id: 'c', kind: 'email', label: 'Email' }),
  ]);
  const result = validateSubmission(definition, { a: '', b: 'old', c: 'nope' });
  assert.ok('problems' in result);
  assert.equal(result.problems.length, 3);
});

test('a valid submission returns coerced values, and never a mixture', () => {
  // A caller that receives half-validated values will use them.
  const definition = form([
    field({ id: 'a', label: 'Name', required: true }),
    field({ id: 'b', kind: 'number', label: 'Age' }),
    field({ id: 'c', kind: 'boolean', label: 'Member' }),
  ]);
  const result = validateSubmission(definition, { a: 'Ada', b: '36', c: 'yes' });
  assert.ok('values' in result);
  assert.deepEqual(result.values, { a: 'Ada', b: 36, c: true });
});

test('a field left out entirely is treated as unanswered', () => {
  const definition = form([field({ id: 'a', label: 'Optional' })]);
  const result = validateSubmission(definition, {});
  assert.ok('values' in result);
  assert.equal(result.values['a'], null);
});

// ---------------------------------------------------------- the definition --

test('a form with no fields is reported to whoever is building it', () => {
  assert.ok(checkDefinition(emptyForm())[0]?.includes('no fields'));
});

test('two fields with the same label are refused', () => {
  // They are indistinguishable in the results and to a screen reader, which
  // reads the label and nothing else.
  const problems = checkDefinition(
    form([field({ id: 'a', label: 'Name' }), field({ id: 'b', label: 'name' })]),
  );
  assert.ok(problems.some((problem) => problem.includes('both labelled')));
});

test('a range that cannot be satisfied is reported', () => {
  const problems = checkDefinition(
    form([field({ kind: 'number', label: 'Rating', min: 10, max: 1 })]),
  );
  assert.ok(problems.some((problem) => problem.includes('minimum larger than its maximum')));
});

test('an unlabelled field is reported', () => {
  const problems = checkDefinition(form([field({ label: '   ' })]));
  assert.ok(problems.some((problem) => problem.includes('no label')));
});

test('a sound form reports nothing', () => {
  assert.deepEqual(
    checkDefinition(form([field({ id: 'a', label: 'Name', required: true })])),
    [],
  );
});

// ---------------------------------------------------------------- results --

test('submissions export with the field LABELS as the header', () => {
  // Internal identifiers would produce a file nobody can interpret without the
  // form beside it.
  const definition = form([
    field({ id: 'a', label: 'Name' }),
    field({ id: 'b', kind: 'number', label: 'Age' }),
  ]);
  const submissions: Submission[] = [
    { at: '2026-01-01T00:00:00.000Z', values: { a: 'Ada', b: 36 } },
    { at: '2026-01-02T00:00:00.000Z', values: { a: 'Bob', b: null } },
  ];
  const csv = submissionsToCsv(definition, submissions);
  assert.ok(csv.startsWith('Submitted at,Name,Age'));
  assert.ok(csv.includes('Ada,36'));
  // An unanswered field is empty, not the word null.
  assert.ok(csv.includes('Bob,'));
  assert.ok(!csv.includes('null'));
});

test('an answer containing a comma or a quote survives the export', () => {
  const quote = String.fromCharCode(34);
  const definition = form([field({ id: 'a', label: 'Note' })]);
  const csv = submissionsToCsv(definition, [
    { at: 'x', values: { a: 'has, a comma and a ' + quote + 'quote' + quote } },
  ]);
  assert.ok(csv.includes(quote + 'has, a comma and a ' + quote + quote + 'quote' + quote + quote + quote));
});

test('answer counts distinguish answered from skipped', () => {
  const definition = form([
    field({ id: 'a', label: 'Name' }),
    field({ id: 'b', label: 'Note' }),
  ]);
  const counts = answerCounts(definition, [
    { at: 'x', values: { a: 'Ada', b: '' } },
    { at: 'y', values: { a: 'Bob', b: 'something' } },
    { at: 'z', values: { a: null, b: null } },
  ]);
  assert.deepEqual(
    counts.map((entry) => [entry.field.label, entry.answered]),
    [
      ['Name', 2],
      ['Note', 1],
    ],
  );
});
