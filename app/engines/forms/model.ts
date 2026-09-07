/**
 * Forms.
 *
 * A form is a list of fields plus the rules for reading them back. It leans on
 * the data engine's coercion rather than reimplementing it, because a form
 * that validates differently from the table it writes into is a form that
 * accepts data the table then refuses.
 *
 * Two decisions shape everything:
 *
 *   - A FIELD'S HELP TEXT IS PART OF THE FIELD, not decoration added later.
 *     Somebody who does not know what a field wants fills it in wrongly and
 *     then blames themselves, so the format, the range and the reason are
 *     declared where the field is declared and always rendered.
 *   - VALIDATION REPORTS EVERYTHING AT ONCE. One problem per attempt turns a
 *     form into a guessing game, and the person filling it in has no way to
 *     know how many rounds are left.
 */

import { type CellValue, type Coerced, coerce } from '../data/model';

export type FieldKind =
  | 'text'
  | 'longText'
  | 'number'
  | 'boolean'
  | 'date'
  | 'choice'
  | 'email';

export interface Field {
  readonly id: string;
  readonly kind: FieldKind;
  readonly label: string;
  /** Always rendered. See the note at the top of this file. */
  readonly help?: string;
  readonly required?: boolean;
  /** For choice fields. An empty list makes the field unanswerable. */
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** Shown in the field before anything is typed. Never a substitute for a label. */
  readonly placeholder?: string;
}

export interface FormDefinition {
  readonly schema: 'material-workspace/forms@1';
  readonly title: string;
  readonly description: string;
  readonly fields: readonly Field[];
}

export interface Submission {
  readonly at: string;
  readonly values: Readonly<Record<string, CellValue>>;
}

export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

let counter = 0;

export function newFieldId(): string {
  counter += 1;
  return 'f' + counter.toString(36);
}

export function emptyForm(): FormDefinition {
  return {
    schema: 'material-workspace/forms@1',
    title: 'Untitled form',
    description: '',
    fields: [],
  };
}

export function newField(kind: FieldKind): Field {
  return {
    id: newFieldId(),
    kind,
    label: defaultLabel(kind),
    ...(kind === 'choice' ? { options: ['First choice', 'Second choice'] } : {}),
  };
}

function defaultLabel(kind: FieldKind): string {
  switch (kind) {
    case 'longText':
      return 'Longer answer';
    case 'number':
      return 'A number';
    case 'boolean':
      return 'Yes or no';
    case 'date':
      return 'A date';
    case 'choice':
      return 'Choose one';
    case 'email':
      return 'Email address';
    default:
      return 'Short answer';
  }
}

/**
 * The data-engine column a field validates against.
 *
 * Reusing the same coercion is the point: a form that validates differently
 * from the table it writes into accepts data the table then refuses, and the
 * person who filled it in is told nothing useful about why.
 */
function columnFor(field: Field): { name: string; type: 'text' | 'number' | 'boolean' | 'date'; required?: boolean } {
  const type =
    field.kind === 'number'
      ? 'number'
      : field.kind === 'boolean'
        ? 'boolean'
        : field.kind === 'date'
          ? 'date'
          : 'text';
  return {
    name: field.label,
    type,
    ...(field.required === true ? { required: true } : {}),
  };
}

/**
 * Deliberately not the full specification.
 *
 * The real grammar for an address permits things nobody types and rejects
 * nothing anybody does. This checks the shape people actually get wrong — a
 * missing at-sign, a missing dot, whitespace — and leaves the rest to the fact
 * that a wrong address bounces. Refusing a valid unusual address is worse than
 * accepting an invalid ordinary one.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateField(field: Field, value: CellValue): FieldProblem | undefined {
  const coerced: Coerced = coerce(columnFor(field), value);
  if (!coerced.ok) return { field: field.id, message: coerced.message };

  const result = coerced.value;
  if (result === null || result === '') return undefined;

  if (field.kind === 'email' && typeof result === 'string' && !EMAIL_SHAPE.test(result.trim())) {
    return {
      field: field.id,
      message: field.label + ' does not look like an email address',
    };
  }

  if (field.kind === 'choice') {
    const options = field.options ?? [];
    if (options.length === 0) {
      // A choice field with no options cannot be answered at all, so it is a
      // fault in the FORM rather than in the answer — and saying so points at
      // whoever can fix it.
      return { field: field.id, message: field.label + ' has no options to choose from' };
    }
    if (!options.includes(String(result))) {
      return { field: field.id, message: field.label + ' must be one of the listed choices' };
    }
  }

  if (typeof result === 'number') {
    if (field.min !== undefined && result < field.min) {
      return { field: field.id, message: field.label + ' must be at least ' + field.min };
    }
    if (field.max !== undefined && result > field.max) {
      return { field: field.id, message: field.label + ' must be at most ' + field.max };
    }
  }

  return undefined;
}

/**
 * Validate a whole answer set.
 *
 * Returns the coerced values or every problem. Never a mixture: a caller that
 * receives half-validated values will use them.
 */
export function validateSubmission(
  form: FormDefinition,
  answers: Readonly<Record<string, CellValue>>,
):
  | { readonly values: Readonly<Record<string, CellValue>> }
  | { readonly problems: readonly FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const values: Record<string, CellValue> = {};

  for (const field of form.fields) {
    const raw = field.id in answers ? (answers[field.id] ?? null) : null;
    const problem = validateField(field, raw);
    if (problem !== undefined) {
      problems.push(problem);
      continue;
    }
    const coerced = coerce(columnFor(field), raw);
    values[field.id] = coerced.ok ? coerced.value : null;
  }

  return problems.length > 0 ? { problems } : { values };
}

/**
 * A form with no fields cannot be submitted, and a form with a broken field
 * cannot be filled in correctly. Reported to whoever is BUILDING it, which is
 * a different audience from whoever is filling it in.
 */
export function checkDefinition(form: FormDefinition): string[] {
  const problems: string[] = [];

  if (form.fields.length === 0) {
    problems.push('This form has no fields yet, so there is nothing to fill in.');
  }

  const labels = new Map<string, number>();
  for (const field of form.fields) {
    if (field.label.trim().length === 0) {
      problems.push('A field has no label, so nobody can tell what it is asking for.');
    }
    const key = field.label.trim().toLowerCase();
    labels.set(key, (labels.get(key) ?? 0) + 1);

    if (field.kind === 'choice' && (field.options ?? []).length === 0) {
      problems.push(field.label + ' is a choice with no options, so it cannot be answered.');
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      problems.push(
        field.label + ' has a minimum larger than its maximum, so no answer can be valid.',
      );
    }
  }

  for (const [label, count] of labels) {
    if (count > 1 && label.length > 0) {
      // Two fields with the same label are indistinguishable in the results
      // and to a screen reader, which reads the label and nothing else.
      problems.push(
        'Two fields are both labelled "' + label + '", so their answers cannot be told apart.',
      );
    }
  }

  return problems;
}

/**
 * Submissions as CSV.
 *
 * The header uses the field LABELS, because that is what the answers mean to
 * whoever reads them. Using the internal identifiers would produce a file
 * nobody can interpret without the form beside it.
 */
export function submissionsToCsv(
  form: FormDefinition,
  submissions: readonly Submission[],
): string {
  const quote = String.fromCharCode(34);
  const escape = (value: CellValue): string => {
    if (value === null) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? quote + text.split(quote).join(quote + quote) + quote : text;
  };

  const header = ['Submitted at', ...form.fields.map((field) => field.label)];
  const lines = [header.map((value) => escape(value)).join(',')];

  for (const submission of submissions) {
    lines.push(
      [
        escape(submission.at),
        ...form.fields.map((field) => escape(submission.values[field.id] ?? null)),
      ].join(','),
    );
  }

  return lines.join('\r\n');
}

/** How many submissions answered each field, for a summary. */
export function answerCounts(
  form: FormDefinition,
  submissions: readonly Submission[],
): { readonly field: Field; readonly answered: number }[] {
  return form.fields.map((field) => ({
    field,
    answered: submissions.filter((submission) => {
      const value = submission.values[field.id];
      return value !== null && value !== undefined && value !== '';
    }).length,
  }));
}
