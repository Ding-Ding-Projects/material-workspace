/**
 * Forms.
 *
 * Three modes over one definition: Design, Fill, and Results.
 *
 * They are MODES rather than three separate surfaces, because the whole value
 * of a form builder is that what you designed is what people see. A preview
 * that renders differently from the real thing is worse than no preview: it
 * tells you the form is fine right up until somebody uses it.
 *
 * So Fill renders from the same definition the designer edits, through the
 * same code. There is no second rendering path to disagree.
 */

import { clear, el } from '../../dom.js';
import { type CellValue } from '../../../engines/data/model.js';
import {
  type Field,
  type FieldKind,
  type FieldProblem,
  type FormDefinition,
  type Submission,
  answerCounts,
  checkDefinition,
  emptyForm,
  newField,
  submissionsToCsv,
  validateSubmission,
} from '../../../engines/forms/model.js';

export interface FormsOptions {
  form?: FormDefinition;
  onChange?: (form: FormDefinition) => void;
  now?: () => Date;
}

type Mode = 'design' | 'fill' | 'results';

const KINDS: readonly { kind: FieldKind; label: string }[] = [
  { kind: 'text', label: 'Short answer' },
  { kind: 'longText', label: 'Longer answer' },
  { kind: 'number', label: 'Number' },
  { kind: 'boolean', label: 'Yes or no' },
  { kind: 'date', label: 'Date' },
  { kind: 'choice', label: 'Choose one' },
  { kind: 'email', label: 'Email' },
];

function sampleForm(): FormDefinition {
  return {
    schema: 'material-workspace/forms@1',
    title: 'Tea house feedback',
    description: 'Three questions. It takes about a minute.',
    fields: [
      {
        id: 'name',
        kind: 'text',
        label: 'Your name',
        help: 'Optional. Leave it blank if you would rather not say.',
      },
      {
        id: 'rating',
        kind: 'number',
        label: 'Rating out of five',
        help: 'A whole number from 1 to 5.',
        required: true,
        min: 1,
        max: 5,
      },
      {
        id: 'dish',
        kind: 'choice',
        label: 'Best dish',
        help: 'Pick the one you would order again.',
        options: ['Har gow', 'Siu mai', 'Char siu bao', 'Egg tart'],
      },
    ],
  };
}

export class Forms {
  readonly element: HTMLElement;

  private form: FormDefinition;
  private submissions: Submission[] = [];
  private answers: Record<string, CellValue> = {};
  private problems: readonly FieldProblem[] = [];
  private mode: Mode = 'design';
  private selected: string | null = null;
  /**
   * A transient message, shown BESIDE the counts rather than instead of them.
   *
   * setStatus after render replaces the field and response counts outright, so
   * the moment somebody submits, the numbers they were watching vanish. Same
   * defect the Database surface had, and for the same reason: the confirmation
   * is written after the thing that draws the counts.
   */
  private note = '';

  private readonly options: FormsOptions;
  private readonly now: () => Date;

  private readonly modeBar: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly warnings: HTMLElement;
  private readonly statusLine: HTMLElement;

  constructor(options: FormsOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.form = options.form ?? sampleForm();

    this.modeBar = el('div', {
      class: 'forms__modes',
      role: 'tablist',
      'aria-label': 'Form mode',
    });
    this.toolbar = el('div', { class: 'forms__toolbar', role: 'toolbar', 'aria-label': 'Form' });
    this.panel = el('div', { class: 'forms__panel' });
    this.warnings = el('ul', {
      class: 'forms__warnings',
      role: 'status',
      'aria-live': 'polite',
      'data-shown': 'false',
    });
    this.statusLine = el('div', {
      class: 'forms__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.element = el('div', { class: 'forms' }, [
      this.modeBar,
      this.toolbar,
      this.warnings,
      this.panel,
      this.statusLine,
    ]);

    this.wire();
    this.render();
  }

  private wire(): void {
    this.modeBar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-mode]');
      if (!target) return;
      this.mode = target.getAttribute('data-mode') as Mode;
      this.problems = [];
      this.render();
    });

    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-action]');
      if (!target) return;
      this.runAction(target.getAttribute('data-action') ?? '');
    });

    this.panel.addEventListener('click', (event) => {
      const remove = (event.target as HTMLElement).closest('[data-remove-field]');
      if (remove !== null) {
        const id = remove.getAttribute('data-remove-field');
        this.form = {
          ...this.form,
          fields: this.form.fields.filter((field) => field.id !== id),
        };
        this.commit();
        return;
      }

      const move = (event.target as HTMLElement).closest('[data-move]');
      if (move !== null) {
        this.moveField(
          move.getAttribute('data-field') ?? '',
          move.getAttribute('data-move') === 'up' ? -1 : 1,
        );
        return;
      }

      const select = (event.target as HTMLElement).closest('[data-field-card]');
      if (select !== null) {
        this.selected = select.getAttribute('data-field-card');
        this.render();
      }
    });

    this.panel.addEventListener('input', (event) => this.onFieldInput(event));
    this.panel.addEventListener('change', (event) => this.onFieldInput(event));

    this.panel.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
  }

  private onFieldInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

    // Editing the definition, in Design mode.
    const property = target.getAttribute('data-property');
    const fieldId = target.getAttribute('data-field');
    if (property !== null && fieldId !== null) {
      this.updateField(fieldId, property, target);
      return;
    }

    // Editing the form's own title or description.
    const formProperty = target.getAttribute('data-form-property');
    if (formProperty !== null) {
      this.form = { ...this.form, [formProperty]: target.value };
      this.options.onChange?.(this.form);
      // Not a full render: this input is being typed into.
      this.renderWarnings();
      this.renderStatus();
      return;
    }

    // Answering, in Fill mode.
    const answerId = target.getAttribute('data-answer');
    if (answerId !== null) {
      this.answers[answerId] =
        (target as HTMLInputElement).type === 'checkbox'
          ? (target as HTMLInputElement).checked
          : target.value;
    }
  }

  private updateField(id: string, property: string, control: HTMLElement): void {
    const value = (control as HTMLInputElement).value;
    const checked = (control as HTMLInputElement).checked;

    this.form = {
      ...this.form,
      fields: this.form.fields.map((field) => {
        if (field.id !== id) return field;
        switch (property) {
          case 'label':
            return { ...field, label: value };
          case 'help':
            return { ...field, help: value };
          case 'required':
            return { ...field, required: checked };
          case 'kind':
            return { ...field, kind: value as FieldKind };
          case 'options':
            // One per line, blanks dropped. A trailing newline while typing
            // would otherwise add an unanswerable empty choice.
            return {
              ...field,
              options: value
                .split('\n')
                .map((option) => option.trim())
                .filter((option) => option.length > 0),
            };
          case 'min':
            return { ...field, min: value === '' ? undefined : Number(value) };
          case 'max':
            return { ...field, max: value === '' ? undefined : Number(value) };
          default:
            return field;
        }
      }),
    };

    this.options.onChange?.(this.form);
    // The definition changed, so the warnings and the preview must follow —
    // but not the whole panel, or the control being typed into is rebuilt and
    // loses its caret.
    this.renderWarnings();
    this.renderStatus();
  }

  private moveField(id: string, direction: number): void {
    const index = this.form.fields.findIndex((field) => field.id === id);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= this.form.fields.length) return;

    const fields = [...this.form.fields];
    const [moved] = fields.splice(index, 1);
    if (moved === undefined) return;
    fields.splice(target, 0, moved);
    this.form = { ...this.form, fields };
    this.commit();
  }

  private runAction(action: string): void {
    if (action.startsWith('add:')) {
      const kind = action.slice(4) as FieldKind;
      const field = newField(kind);
      this.form = { ...this.form, fields: [...this.form.fields, field] };
      this.selected = field.id;
      this.commit();
      return;
    }
    if (action === 'clear-answers') {
      this.answers = {};
      this.problems = [];
      this.render();
      return;
    }
    if (action === 'export') this.exportResults();
  }

  private submit(): void {
    const result = validateSubmission(this.form, this.answers);
    if ('problems' in result) {
      this.problems = result.problems;
      this.note =
        result.problems.length +
        (result.problems.length === 1 ? ' answer needs' : ' answers need') +
        ' fixing. Nothing was submitted.';
      this.render();
      return;
    }

    this.submissions.push({ at: this.now().toISOString(), values: result.values });
    this.answers = {};
    this.problems = [];
    this.note = 'Submitted.';
    this.render();
  }

  private exportResults(): void {
    if (this.submissions.length === 0) {
      this.note = 'Nothing to export: no responses yet.';
      this.renderStatus();
      return;
    }
    const csv = submissionsToCsv(this.form, this.submissions);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: 'responses.csv' }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.note =
      'Exported ' +
      this.submissions.length +
      ' responses as CSV, with the field labels as the header. Nothing was lost.';
    this.renderStatus();
  }

  private commit(): void {
    this.options.onChange?.(this.form);
    this.render();
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    this.renderModes();
    this.renderToolbar();
    this.renderWarnings();
    clear(this.panel);

    if (this.mode === 'design') this.renderDesign();
    else if (this.mode === 'fill') this.renderFill();
    else this.renderResults();

    this.renderStatus();
  }

  private renderModes(): void {
    clear(this.modeBar);
    for (const [mode, label] of [
      ['design', 'Design'],
      ['fill', 'Fill in'],
      ['results', 'Responses'],
    ] as const) {
      this.modeBar.append(
        el(
          'button',
          {
            class: 'forms__mode',
            type: 'button',
            role: 'tab',
            'data-mode': mode,
            'aria-selected': this.mode === mode ? 'true' : 'false',
          },
          [label + (mode === 'results' ? ' (' + this.submissions.length + ')' : '')],
        ),
      );
    }
  }

  private renderToolbar(): void {
    clear(this.toolbar);

    if (this.mode === 'design') {
      this.toolbar.append(el('span', { class: 'forms__toolbar-label' }, ['Add a field']));
      for (const entry of KINDS) {
        this.toolbar.append(
          el(
            'button',
            { class: 'forms__action', type: 'button', 'data-action': 'add:' + entry.kind },
            [entry.label],
          ),
        );
      }
      return;
    }

    if (this.mode === 'fill') {
      this.toolbar.append(
        el('button', { class: 'forms__action', type: 'button', 'data-action': 'clear-answers' }, [
          'Clear answers',
        ]),
      );
      return;
    }

    this.toolbar.append(
      el('button', { class: 'forms__action', type: 'button', 'data-action': 'export' }, [
        'Export responses as CSV',
      ]),
    );
  }

  /** Problems with the DEFINITION, addressed to whoever is building it. */
  private renderWarnings(): void {
    clear(this.warnings);
    const problems = this.mode === 'design' ? checkDefinition(this.form) : [];
    this.warnings.setAttribute('data-shown', problems.length > 0 ? 'true' : 'false');
    for (const problem of problems) {
      this.warnings.append(el('li', {}, [problem]));
    }
  }

  private renderDesign(): void {
    const title = el('input', {
      class: 'forms__title',
      type: 'text',
      'data-form-property': 'title',
      'aria-label': 'Form title',
    }) as HTMLInputElement;
    title.value = this.form.title;

    const description = el('input', {
      class: 'forms__description',
      type: 'text',
      'data-form-property': 'description',
      'aria-label': 'Form description',
      placeholder: 'A sentence about what this is for',
    }) as HTMLInputElement;
    description.value = this.form.description;

    this.panel.append(title, description);

    if (this.form.fields.length === 0) {
      this.panel.append(
        el('p', { class: 'forms__empty' }, [
          'No fields yet. Add one from the toolbar above.',
        ]),
      );
      return;
    }

    this.form.fields.forEach((field, index) => {
      this.panel.append(this.fieldEditor(field, index));
    });
  }

  private fieldEditor(field: Field, index: number): HTMLElement {
    const id = 'design-' + field.id;

    const label = el('input', {
      class: 'forms__input',
      type: 'text',
      id: id + '-label',
      'data-field': field.id,
      'data-property': 'label',
      'aria-label': 'Label for field ' + (index + 1),
    }) as HTMLInputElement;
    label.value = field.label;

    const help = el('input', {
      class: 'forms__input',
      type: 'text',
      id: id + '-help',
      'data-field': field.id,
      'data-property': 'help',
      'aria-label': 'Help text for field ' + (index + 1),
      placeholder: 'What should somebody know before answering?',
    }) as HTMLInputElement;
    help.value = field.help ?? '';

    const kind = el('select', {
      class: 'forms__input',
      'data-field': field.id,
      'data-property': 'kind',
      'aria-label': 'Kind of field ' + (index + 1),
    }) as HTMLSelectElement;
    for (const entry of KINDS) {
      kind.append(el('option', { value: entry.kind, text: entry.label }));
    }
    kind.value = field.kind;

    const required = el('input', {
      class: 'forms__checkbox',
      type: 'checkbox',
      id: id + '-required',
      'data-field': field.id,
      'data-property': 'required',
    }) as HTMLInputElement;
    required.checked = field.required === true;

    const extras: HTMLElement[] = [];

    if (field.kind === 'choice') {
      const options = el('textarea', {
        class: 'forms__input',
        rows: '3',
        'data-field': field.id,
        'data-property': 'options',
        'aria-label': 'Options for field ' + (index + 1) + ', one per line',
        placeholder: 'One option per line',
      }) as HTMLTextAreaElement;
      options.value = (field.options ?? []).join('\n');
      extras.push(el('label', { class: 'forms__sub-label' }, ['Options, one per line']), options);
    }

    if (field.kind === 'number') {
      const min = el('input', {
        class: 'forms__input forms__input--narrow',
        type: 'number',
        'data-field': field.id,
        'data-property': 'min',
        'aria-label': 'Smallest allowed value for field ' + (index + 1),
      }) as HTMLInputElement;
      min.value = field.min === undefined ? '' : String(field.min);

      const max = el('input', {
        class: 'forms__input forms__input--narrow',
        type: 'number',
        'data-field': field.id,
        'data-property': 'max',
        'aria-label': 'Largest allowed value for field ' + (index + 1),
      }) as HTMLInputElement;
      max.value = field.max === undefined ? '' : String(field.max);

      extras.push(
        el('div', { class: 'forms__range' }, [
          el('label', { class: 'forms__sub-label' }, ['Smallest']),
          min,
          el('label', { class: 'forms__sub-label' }, ['Largest']),
          max,
        ]),
      );
    }

    return el(
      'div',
      {
        class: 'forms__field-card',
        'data-field-card': field.id,
        'data-current': this.selected === field.id ? 'true' : 'false',
      },
      [
        el('div', { class: 'forms__field-head' }, [
          el('span', { class: 'forms__field-number' }, [String(index + 1)]),
          kind,
          el(
            'button',
            {
              class: 'forms__small',
              type: 'button',
              'data-move': 'up',
              'data-field': field.id,
              'aria-label': 'Move field ' + (index + 1) + ' up',
              ...(index === 0 ? { disabled: 'disabled' } : {}),
            },
            ['Up'],
          ),
          el(
            'button',
            {
              class: 'forms__small',
              type: 'button',
              'data-move': 'down',
              'data-field': field.id,
              'aria-label': 'Move field ' + (index + 1) + ' down',
              ...(index === this.form.fields.length - 1 ? { disabled: 'disabled' } : {}),
            },
            ['Down'],
          ),
          el(
            'button',
            {
              class: 'forms__small forms__small--danger',
              type: 'button',
              'data-remove-field': field.id,
              'aria-label': 'Remove field ' + (index + 1),
            },
            ['Remove'],
          ),
        ]),
        el('label', { class: 'forms__sub-label', for: id + '-label' }, ['Label']),
        label,
        el('label', { class: 'forms__sub-label', for: id + '-help' }, ['Help text']),
        help,
        el('label', { class: 'forms__inline', for: id + '-required' }, [
          required,
          el('span', {}, ['Required']),
        ]),
        ...extras,
      ],
    );
  }

  /**
   * Fill mode.
   *
   * Rendered from the same definition the designer edits. A preview that
   * differs from the real thing tells you the form is fine right up until
   * somebody uses it.
   */
  private renderFill(): void {
    const form = el('form', {
      class: 'forms__fill',
      // The engine's validation reports everything at once, beside each field;
      // the native one blocks submit and shows a single bubble that vanishes.
      novalidate: 'novalidate',
    });

    form.append(
      el('h2', { class: 'forms__fill-title' }, [this.form.title]),
      ...(this.form.description.trim().length > 0
        ? [el('p', { class: 'forms__fill-description' }, [this.form.description])]
        : []),
    );

    if (this.form.fields.length === 0) {
      form.append(
        el('p', { class: 'forms__empty' }, ['This form has no fields to fill in yet.']),
      );
      this.panel.append(form);
      return;
    }

    for (const field of this.form.fields) {
      form.append(this.fillField(field));
    }

    form.append(el('button', { class: 'forms__action', type: 'submit' }, ['Submit']));
    this.panel.append(form);
  }

  private fillField(field: Field): HTMLElement {
    const id = 'fill-' + field.id;
    const problem = this.problems.find((candidate) => candidate.field === field.id);
    const helpId = id + '-help';
    const problemId = id + '-problem';

    // Both the help text and the problem are referenced, so a screen reader
    // reads the guidance AND what went wrong rather than one or the other.
    const described = [
      ...(field.help !== undefined && field.help.length > 0 ? [helpId] : []),
      ...(problem === undefined ? [] : [problemId]),
    ].join(' ');

    const common = {
      id,
      'data-answer': field.id,
      class: 'forms__input',
      ...(field.required === true ? { 'aria-required': 'true' } : {}),
      ...(problem === undefined ? {} : { 'aria-invalid': 'true' }),
      ...(described.length > 0 ? { 'aria-describedby': described } : {}),
    };

    let control: HTMLElement;
    if (field.kind === 'longText') {
      control = el('textarea', { ...common, rows: '4' });
      (control as HTMLTextAreaElement).value = String(this.answers[field.id] ?? '');
    } else if (field.kind === 'boolean') {
      control = el('input', { ...common, type: 'checkbox', class: 'forms__checkbox' });
      (control as HTMLInputElement).checked = this.answers[field.id] === true;
    } else if (field.kind === 'choice') {
      const select = el('select', common) as HTMLSelectElement;
      // An explicit empty option, so an optional choice can be left
      // unanswered. Without it the first option is silently pre-selected and
      // becomes an answer nobody gave.
      select.append(el('option', { value: '', text: 'No answer' }));
      for (const option of field.options ?? []) {
        select.append(el('option', { value: option, text: option }));
      }
      select.value = String(this.answers[field.id] ?? '');
      control = select;
    } else {
      control = el('input', {
        ...common,
        // A number field is text with a numeric input mode: a number input
        // discards non-numeric text before any script sees it, so the engine's
        // message naming the field could never be shown.
        type: field.kind === 'date' ? 'date' : field.kind === 'email' ? 'email' : 'text',
        ...(field.kind === 'number' ? { inputmode: 'decimal' } : {}),
        ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      });
      (control as HTMLInputElement).value = String(this.answers[field.id] ?? '');
    }

    return el('div', { class: 'forms__fill-field' }, [
      el('label', { class: 'forms__fill-label', for: id }, [
        field.label,
        ...(field.required === true
          ? [el('span', { class: 'forms__required' }, ['required'])]
          : []),
      ]),
      // Always rendered when present. Somebody who does not know what a field
      // wants fills it in wrongly and then blames themselves.
      ...(field.help !== undefined && field.help.length > 0
        ? [el('p', { class: 'forms__help', id: helpId }, [field.help])]
        : []),
      control,
      ...(problem === undefined
        ? []
        : [el('p', { class: 'forms__problem', id: problemId }, [problem.message])]),
    ]);
  }

  private renderResults(): void {
    if (this.submissions.length === 0) {
      this.panel.append(
        el('p', { class: 'forms__empty' }, [
          'No responses yet. Switch to Fill in and submit one.',
        ]),
      );
      return;
    }

    this.panel.append(
      el(
        'div',
        { class: 'forms__summary' },
        answerCounts(this.form, this.submissions).map((entry) =>
          el('div', { class: 'forms__summary-row' }, [
            el('span', { class: 'forms__summary-label' }, [entry.field.label]),
            el('span', { class: 'forms__summary-count' }, [
              entry.answered +
                ' of ' +
                this.submissions.length +
                (entry.answered === this.submissions.length ? '' : '   skipped by some'),
            ]),
          ]),
        ),
      ),
    );

    const table = el('div', { class: 'forms__results', role: 'table' });
    table.append(
      el(
        'div',
        { class: 'forms__results-row forms__results-row--header', role: 'row' },
        [
          el('span', { class: 'forms__results-cell', role: 'columnheader' }, ['Submitted']),
          ...this.form.fields.map((field) =>
            el('span', { class: 'forms__results-cell', role: 'columnheader' }, [field.label]),
          ),
        ],
      ),
    );

    for (const submission of this.submissions) {
      table.append(
        el('div', { class: 'forms__results-row', role: 'row' }, [
          el('span', { class: 'forms__results-cell', role: 'cell' }, [
            submission.at.slice(0, 19).replace('T', ' ') + ' UTC',
          ]),
          ...this.form.fields.map((field) => {
            const value = submission.values[field.id];
            const skipped = value === null || value === undefined || value === '';
            return el(
              'span',
              {
                class: 'forms__results-cell',
                role: 'cell',
                // Skipped is shown, not left blank: a blank cell and an
                // answered-with-nothing cell are different facts.
                'data-skipped': skipped ? 'true' : 'false',
              },
              [skipped ? 'not answered' : formatAnswer(value)],
            );
          }),
        ]),
      );
    }

    this.panel.append(table);
  }

  private renderStatus(): void {
    const parts = [
      this.form.fields.length + (this.form.fields.length === 1 ? ' field' : ' fields'),
      this.submissions.length +
        (this.submissions.length === 1 ? ' response' : ' responses'),
    ];
    const required = this.form.fields.filter((field) => field.required === true).length;
    if (required > 0) parts.push(required + ' required');
    if (this.note !== '') parts.push(this.note);
    this.setStatus(parts.join('   '));
    // Cleared after showing, so it does not follow the user around.
    this.note = '';
  }

  private setStatus(message: string): void {
    clear(this.statusLine);
    this.statusLine.append(message);
  }
}

function formatAnswer(value: CellValue): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
