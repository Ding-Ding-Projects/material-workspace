/**
 * The regular-expression workbench.
 *
 * Anchored to the field it belongs to, never a distant global dialog: the
 * builder belongs to the search bar the user is already typing in, and one
 * shared builder that silently applies to whichever field was last touched is
 * the exact confusion this design avoids.
 *
 * Everything it reports is measured rather than asserted. The engine's own error
 * text is shown verbatim, capabilities are probed at run time, evaluation runs
 * in a terminable worker, and timing is real.
 */

import { el, clear } from '../../dom.js';
import { Overlay } from '../overlay.js';
import { capabilities, engineIdentity, flagConflicts } from './engine.js';
import { analyseSafety, EVALUATION_LIMITS, type SafetyWarning } from './safety.js';
import { tokenize, type Token } from './tokenize.js';
import { RegexEvaluator, type EvaluationOutcome } from './evaluator.js';

export interface RegexState {
  pattern: string;
  flags: string;
  replacement: string;
  sample: string;
}

export interface RegexBuilderOptions {
  anchor: HTMLElement;
  initial: RegexState;
  /** Called whenever the pattern, flags or replacement change, so the owning
   *  field stays in step. Synchronisation is bidirectional by design. */
  onChange: (state: RegexState) => void;
  onClose?: () => void;
}

const SAMPLE_PLACEHOLDER =
  'Paste text here to test the pattern against it. Nothing you type leaves this machine.';

/** Guided inserts, so the builder is usable without knowing the syntax. */
const INSERTS: { group: string; items: { label: string; snippet: string; hint: string }[] }[] = [
  {
    group: 'Characters',
    items: [
      { label: 'Any digit', snippet: '\\d', hint: '0 to 9' },
      { label: 'Any letter or digit', snippet: '\\w', hint: 'letters, digits, underscore' },
      { label: 'Whitespace', snippet: '\\s', hint: 'space, tab, line break' },
      { label: 'Any character', snippet: '.', hint: 'anything except a line break' },
      { label: 'One of these', snippet: '[abc]', hint: 'a character class' },
      { label: 'None of these', snippet: '[^abc]', hint: 'a negated class' },
    ],
  },
  {
    group: 'Repetition',
    items: [
      { label: 'Optional', snippet: '?', hint: 'zero or one' },
      { label: 'Any number', snippet: '*', hint: 'zero or more' },
      { label: 'At least one', snippet: '+', hint: 'one or more' },
      { label: 'Exactly n', snippet: '{3}', hint: 'exactly three' },
      { label: 'Between n and m', snippet: '{2,5}', hint: 'two to five' },
      { label: 'Lazy', snippet: '?', hint: 'add after a repetition to take as few as possible' },
    ],
  },
  {
    group: 'Position',
    items: [
      { label: 'Start', snippet: '^', hint: 'start of text, or of a line with m' },
      { label: 'End', snippet: String.fromCharCode(36), hint: 'end of text, or of a line with m' },
      { label: 'Word boundary', snippet: '\\b', hint: 'the edge of a word' },
    ],
  },
  {
    group: 'Grouping',
    items: [
      { label: 'Capture', snippet: '()', hint: 'keep what this matches' },
      { label: 'Group only', snippet: '(?:)', hint: 'group without capturing' },
      { label: 'Named capture', snippet: '(?<name>)', hint: 'capture under a name' },
      { label: 'Either / or', snippet: '|', hint: 'alternation' },
      { label: 'Followed by', snippet: '(?=)', hint: 'lookahead' },
      { label: 'Not followed by', snippet: '(?!)', hint: 'negative lookahead' },
      { label: 'Preceded by', snippet: '(?<=)', hint: 'lookbehind' },
      { label: 'Not preceded by', snippet: '(?<!)', hint: 'negative lookbehind' },
    ],
  },
];

export class RegexBuilder {
  private readonly overlay: Overlay;
  private readonly evaluator = new RegexEvaluator();
  private readonly options: RegexBuilderOptions;
  private state: RegexState;

  private patternInput!: HTMLInputElement;
  private replacementInput!: HTMLInputElement;
  private sampleInput!: HTMLTextAreaElement;
  private annotationRegion!: HTMLElement;
  private warningRegion!: HTMLElement;
  private resultRegion!: HTMLElement;
  private flagRegion!: HTMLElement;

  private evaluationToken = 0;

  constructor(options: RegexBuilderOptions) {
    this.options = options;
    this.state = { ...options.initial };
    this.overlay = new Overlay({
      anchor: options.anchor,
      label: 'Regular expression builder',
      onClose: () => {
        this.evaluator.dispose();
        options.onClose?.();
      },
    });
  }

  get isOpen(): boolean {
    return this.overlay.isOpen;
  }

  toggle(): void {
    if (this.overlay.isOpen) this.overlay.close();
    else this.open();
  }

  open(): void {
    this.overlay.show(this.render());
    this.refresh();
  }

  close(): void {
    this.overlay.close();
  }

  /** Keep the builder in step when the owning field is edited directly. */
  setState(state: Partial<RegexState>): void {
    this.state = { ...this.state, ...state };
    if (!this.overlay.isOpen) return;
    if (this.patternInput.value !== this.state.pattern) {
      this.patternInput.value = this.state.pattern;
    }
    this.refresh();
  }

  private emit(): void {
    this.options.onChange({ ...this.state });
  }

  /* --------------------------------------------------------------- render */

  private render(): HTMLElement {
    const root = el('div', { class: 'regex' });

    // ---- pattern -----------------------------------------------------------
    this.patternInput = el('input', {
      class: 'regex__pattern',
      type: 'text',
      id: 'regex-pattern',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Type a pattern, or use the inserts below',
      value: this.state.pattern,
      'aria-describedby': 'regex-annotation regex-warnings',
    }) as HTMLInputElement;
    this.patternInput.addEventListener('input', () => {
      this.state.pattern = this.patternInput.value;
      this.emit();
      this.refresh();
    });

    root.append(
      el('div', { class: 'regex__row' }, [
        el('label', { class: 'regex__label', for: 'regex-pattern', text: 'Pattern' }),
        this.patternInput,
      ]),
    );

    // ---- flags -------------------------------------------------------------
    this.flagRegion = el('div', { class: 'regex__flags', role: 'group', 'aria-label': 'Flags' });
    root.append(this.flagRegion);
    this.renderFlags();

    // ---- guided inserts ----------------------------------------------------
    const inserts = el('details', { class: 'regex__section' }, [
      el('summary', { text: 'Insert' }),
    ]);
    for (const group of INSERTS) {
      const row = el('div', { class: 'regex__insert-group' }, [
        el('span', { class: 'regex__insert-heading', text: group.group }),
      ]);
      for (const item of group.items) {
        const button = el('button', {
          class: 'regex__insert',
          type: 'button',
          title: item.hint,
          'aria-label': item.label + ' — ' + item.hint,
        });
        button.textContent = item.label;
        button.addEventListener('click', () => this.insert(item.snippet));
        row.append(button);
      }
      inserts.append(row);
    }
    root.append(inserts);

    // ---- annotation --------------------------------------------------------
    this.annotationRegion = el('div', {
      class: 'regex__annotation',
      id: 'regex-annotation',
      role: 'region',
      'aria-label': 'What this pattern means',
    });
    root.append(
      el('details', { class: 'regex__section', open: true }, [
        el('summary', { text: 'What this pattern means' }),
        this.annotationRegion,
      ]),
    );

    // ---- warnings ----------------------------------------------------------
    this.warningRegion = el('div', {
      class: 'regex__warnings',
      id: 'regex-warnings',
      role: 'region',
      'aria-live': 'polite',
      'aria-label': 'Safety warnings',
    });
    root.append(this.warningRegion);

    // ---- sample and replacement -------------------------------------------
    this.sampleInput = el('textarea', {
      class: 'regex__sample',
      id: 'regex-sample',
      rows: '5',
      spellcheck: 'false',
      placeholder: SAMPLE_PLACEHOLDER,
    }) as HTMLTextAreaElement;
    this.sampleInput.value = this.state.sample;
    this.sampleInput.addEventListener('input', () => {
      this.state.sample = this.sampleInput.value;
      this.refresh();
    });

    this.replacementInput = el('input', {
      class: 'regex__replacement',
      type: 'text',
      id: 'regex-replacement',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Replacement, using $1 or $<name>',
      value: this.state.replacement,
    }) as HTMLInputElement;
    this.replacementInput.addEventListener('input', () => {
      this.state.replacement = this.replacementInput.value;
      this.emit();
      this.refresh();
    });

    root.append(
      el('details', { class: 'regex__section', open: true }, [
        el('summary', { text: 'Try it' }),
        el('label', { class: 'regex__label', for: 'regex-sample', text: 'Sample text' }),
        this.sampleInput,
        el('label', { class: 'regex__label', for: 'regex-replacement', text: 'Replacement' }),
        this.replacementInput,
      ]),
    );

    // ---- results -----------------------------------------------------------
    this.resultRegion = el('div', {
      class: 'regex__results',
      role: 'region',
      'aria-live': 'polite',
      'aria-label': 'Matches',
    });
    root.append(this.resultRegion);

    // ---- engine ------------------------------------------------------------
    root.append(this.renderEngine());

    return root;
  }

  private renderFlags(): void {
    clear(this.flagRegion);
    const identity = engineIdentity();
    for (const flag of identity.flags) {
      const id = 'regex-flag-' + flag.flag;
      const checkbox = el('input', {
        type: 'checkbox',
        id,
        // An unsupported flag stays VISIBLE and disabled with a reason, rather
        // than vanishing and leaving the user wondering where it went.
        disabled: !flag.supported,
      }) as HTMLInputElement;
      checkbox.checked = this.state.flags.includes(flag.flag);
      checkbox.addEventListener('change', () => {
        const set = new Set(this.state.flags.split(''));
        if (checkbox.checked) set.add(flag.flag);
        else set.delete(flag.flag);
        this.state.flags = [...set].join('');
        this.emit();
        this.refresh();
      });

      this.flagRegion.append(
        el('label', { class: 'regex__flag', for: id, title: flag.label }, [
          checkbox,
          el('code', { text: flag.flag }),
          el('span', { class: 'regex__flag-label', text: flag.label }),
          flag.supported ? null : el('span', { class: 'regex__unsupported', text: 'unavailable' }),
        ]),
      );
    }
  }

  private renderEngine(): HTMLElement {
    const identity = engineIdentity();
    const list = el('div', { class: 'regex__capabilities' });
    for (const capability of capabilities()) {
      list.append(
        el('div', { class: 'regex__capability', 'data-supported': String(capability.supported) }, [
          el('span', {
            class: 'regex__capability-state',
            'aria-hidden': 'true',
            text: capability.supported ? '✓' : '✗',
          }),
          el('span', { class: 'regex__capability-label', text: capability.label }),
          el('span', { class: 'regex__capability-note', text: capability.note }),
        ]),
      );
    }
    return el('details', { class: 'regex__section' }, [
      el('summary', { text: 'Engine and what it supports' }),
      el('p', { class: 'regex__engine-name', text: identity.name }),
      el('p', { class: 'regex__engine-dialect', text: identity.dialect }),
      list,
      el('p', {
        class: 'regex__limits',
        text:
          'Evaluation is bounded: samples up to ' +
          EVALUATION_LIMITS.maxSampleBytes.toLocaleString('en-GB') +
          ' characters, up to ' +
          EVALUATION_LIMITS.maxMatches.toLocaleString('en-GB') +
          ' matches, and ' +
          EVALUATION_LIMITS.deadlineMs +
          'ms before the run is stopped. Patterns run in a separate thread that can be stopped; nothing here can freeze the window.',
      }),
    ]);
  }

  private insert(snippet: string): void {
    const input = this.patternInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + snippet + input.value.slice(end);

    // Place the caret INSIDE a bracketed insert, which is where the next thing
    // the user types belongs.
    const inside = /[)\]>]$/.test(snippet) ? snippet.length - 1 : snippet.length;
    input.setSelectionRange(start + inside, start + inside);
    input.focus();

    this.state.pattern = input.value;
    this.emit();
    this.refresh();
  }

  /* -------------------------------------------------------------- refresh */

  private refresh(): void {
    this.renderAnnotation(tokenize(this.state.pattern));
    this.renderWarnings(analyseSafety(this.state.pattern), flagConflicts(this.state.flags));
    void this.evaluate();
  }

  private renderAnnotation(tokens: Token[]): void {
    clear(this.annotationRegion);
    if (this.state.pattern.length === 0) {
      this.annotationRegion.append(
        el('p', { class: 'regex__empty', text: 'Nothing to explain yet.' }),
      );
      return;
    }
    const list = el('ol', { class: 'regex__tokens' });
    for (const token of tokens) {
      list.append(
        el('li', { class: 'regex__token', 'data-kind': token.kind }, [
          el('code', { class: 'regex__token-text', text: token.text || '—' }),
          el('span', { class: 'regex__token-explanation', text: token.explanation }),
        ]),
      );
    }
    this.annotationRegion.append(list);
  }

  private renderWarnings(warnings: SafetyWarning[], conflicts: string[]): void {
    clear(this.warningRegion);
    for (const conflict of conflicts) {
      this.warningRegion.append(
        el('p', { class: 'regex__warning', 'data-severity': 'danger' }, [
          el('strong', { text: 'Flags conflict. ' }),
          document.createTextNode(conflict),
        ]),
      );
    }
    for (const warning of warnings) {
      this.warningRegion.append(
        el('p', { class: 'regex__warning', 'data-severity': warning.severity }, [
          el('strong', { text: warning.title + '. ' }),
          document.createTextNode(warning.detail),
        ]),
      );
    }
    if (warnings.length > 0) {
      this.warningRegion.append(
        el('p', {
          class: 'regex__warning-note',
          text:
            'These are heuristics. A warning is not proof of a problem, and no warning is not proof of safety.',
        }),
      );
    }
  }

  private async evaluate(): Promise<void> {
    const token = ++this.evaluationToken;
    if (this.state.pattern.length === 0) {
      clear(this.resultRegion);
      return;
    }

    const outcome = await this.evaluator.evaluate(
      this.state.pattern,
      this.state.flags,
      this.state.sample,
      this.state.replacement.length > 0 ? this.state.replacement : null,
    );

    // A superseded run must not overwrite a newer one's results.
    if (token !== this.evaluationToken) return;
    this.renderResults(outcome);
  }

  private renderResults(outcome: EvaluationOutcome): void {
    clear(this.resultRegion);

    if (outcome.status === 'invalid-pattern' || outcome.status === 'unavailable') {
      this.resultRegion.append(
        el('p', { class: 'regex__error', role: 'alert' }, [
          el('strong', {
            text:
              outcome.status === 'invalid-pattern'
                ? 'This pattern will not compile. '
                : 'Cannot evaluate. ',
          }),
          // The engine's own words, not a paraphrase that loses the detail.
          document.createTextNode(outcome.message ?? 'No reason was reported.'),
        ]),
      );
      return;
    }

    if (outcome.status === 'timed-out') {
      this.resultRegion.append(
        el('p', { class: 'regex__error', role: 'alert' }, [
          el('strong', { text: 'Stopped. ' }),
          document.createTextNode(outcome.message ?? ''),
        ]),
      );
      return;
    }

    const response = outcome.response;
    if (!response?.matches) return;
    const matches = response.matches;

    this.resultRegion.append(
      el('p', { class: 'regex__count' }, [
        document.createTextNode(
          matches.matches.length === 1
            ? '1 match'
            : matches.matches.length.toLocaleString('en-GB') + ' matches',
        ),
        el('span', {
          class: 'regex__timing',
          text: ' in ' + matches.elapsedMs.toFixed(1) + 'ms',
        }),
      ]),
    );

    if (matches.truncated && matches.truncatedReason) {
      this.resultRegion.append(
        el('p', { class: 'regex__warning', 'data-severity': 'caution', text: matches.truncatedReason }),
      );
    }

    if (matches.matches.length > 0) {
      const table = el('table', { class: 'regex__matches' });
      table.append(
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: '#' }),
            el('th', { scope: 'col', text: 'At' }),
            el('th', { scope: 'col', text: 'Match' }),
            el('th', { scope: 'col', text: 'Groups' }),
          ]),
        ]),
      );
      const body = el('tbody');
      // Only the first 200 rows are rendered; the count above is the real
      // total, and the note says which is which.
      for (const [position, match] of matches.matches.slice(0, 200).entries()) {
        body.append(
          el('tr', {}, [
            el('td', { text: String(position + 1) }),
            el('td', { text: String(match.index) }),
            el('td', {}, [
              el('code', {
                text: match.text.length === 0 ? '(empty match)' : match.text,
              }),
            ]),
            el('td', {
              text: match.groups.map((group, i) => (group.name ?? i + 1) + '=' + (group.value ?? '')).join('  '),
            }),
          ]),
        );
      }
      table.append(body);
      this.resultRegion.append(table);

      if (matches.matches.length > 200) {
        this.resultRegion.append(
          el('p', {
            class: 'regex__warning-note',
            text:
              'Showing the first 200 of ' +
              matches.matches.length.toLocaleString('en-GB') +
              ' matches. The count above is the real total.',
          }),
        );
      }
    }

    if (response.replacement) {
      this.resultRegion.append(
        el('div', { class: 'regex__replacement-preview' }, [
          el('h4', { text: 'After replacement' }),
          response.replacement.error
            ? el('p', { class: 'regex__error', text: response.replacement.error })
            : el('pre', { text: response.replacement.output }),
        ]),
      );
    }
  }
}
