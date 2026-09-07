/**
 * Formula.
 *
 * Type mathematics on the left, see it typeset on the right, and read the
 * plain-language version underneath.
 *
 * THE SPOKEN DESCRIPTION IS SHOWN, not hidden in an attribute. Two reasons:
 * it is how somebody checks that what they typed means what they intended
 * before pasting it anywhere, and it is the only part of an equation editor
 * that a person who cannot see the rendering can verify at all. Hiding it
 * would make the accessible path the unverifiable one.
 *
 * The preview is inserted as parsed MathML, not as raw markup assigned to
 * innerHTML. That is a deliberate boundary: the input is user text, and
 * building a DOM from a string is how user text becomes markup.
 */

import { clear, el } from '../../dom.js';
import {
  FormulaError,
  describe,
  parseFormula,
  toMathml,
} from '../../../engines/formula/model.js';

export interface FormulaOptions {
  source?: string;
  onChange?: (source: string) => void;
}

/** Palette entries, grouped so the list is scannable rather than a wall. */
const PALETTE: readonly { group: string; items: readonly { insert: string; label: string }[] }[] = [
  {
    group: 'Structure',
    items: [
      { insert: '\\frac{a}{b}', label: 'Fraction' },
      { insert: '\\sqrt{x}', label: 'Square root' },
      { insert: 'x^{2}', label: 'Power' },
      { insert: 'x_{i}', label: 'Subscript' },
      { insert: '\\left( x \\right)', label: 'Brackets' },
    ],
  },
  {
    group: 'Operators',
    items: [
      { insert: '\\sum_{i=1}^{n}', label: 'Sum' },
      { insert: '\\prod_{i=1}^{n}', label: 'Product' },
      { insert: '\\int_{a}^{b}', label: 'Integral' },
      { insert: '\\lim_{x \\rightarrow 0}', label: 'Limit' },
    ],
  },
  {
    group: 'Relations',
    items: [
      { insert: '\\leq', label: 'Less or equal' },
      { insert: '\\geq', label: 'Greater or equal' },
      { insert: '\\neq', label: 'Not equal' },
      { insert: '\\approx', label: 'Approximately' },
      { insert: '\\in', label: 'Element of' },
    ],
  },
  {
    group: 'Greek',
    items: [
      { insert: '\\alpha', label: 'alpha' },
      { insert: '\\beta', label: 'beta' },
      { insert: '\\theta', label: 'theta' },
      { insert: '\\lambda', label: 'lambda' },
      { insert: '\\pi', label: 'pi' },
      { insert: '\\sigma', label: 'sigma' },
      { insert: '\\omega', label: 'omega' },
    ],
  },
];

const EXAMPLES: readonly { label: string; source: string }[] = [
  { label: 'Quadratic formula', source: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
  { label: 'Sum of a series', source: '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}' },
  { label: 'Euler identity', source: 'e^{i\\pi} + 1 = 0' },
];

export class Formula {
  readonly element: HTMLElement;

  private source: string;
  private readonly options: FormulaOptions;
  private display = false;

  private readonly input: HTMLTextAreaElement;
  private readonly preview: HTMLElement;
  private readonly spoken: HTMLElement;
  private readonly problem: HTMLElement;
  private readonly palette: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly statusLine: HTMLElement;

  constructor(options: FormulaOptions = {}) {
    this.options = options;
    this.source = options.source ?? '';

    this.input = el('textarea', {
      class: 'formula__input',
      'aria-label': 'Formula source, in TeX-like notation',
      placeholder: 'Type mathematics. For example  \\frac{a}{b}  or  x^2 + y^2 = r^2',
      spellcheck: 'false',
      rows: '4',
    }) as HTMLTextAreaElement;

    this.preview = el('div', {
      class: 'formula__preview',
      // The rendering itself is decorative for assistive technology, because
      // the spoken description below carries the same content in words. Two
      // readings of one formula is worse than one.
      role: 'img',
      'aria-label': 'Typeset formula',
    });

    this.spoken = el('p', {
      class: 'formula__spoken',
      role: 'status',
      'aria-live': 'polite',
    });

    this.problem = el('p', {
      class: 'formula__problem',
      role: 'alert',
      'data-shown': 'false',
    });

    this.palette = el('div', { class: 'formula__palette' });
    this.toolbar = el('div', {
      class: 'formula__toolbar',
      role: 'toolbar',
      'aria-label': 'Formula',
    });
    this.statusLine = el('div', {
      class: 'formula__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.element = el('div', { class: 'formula' }, [
      this.toolbar,
      el('div', { class: 'formula__body' }, [
        el('div', { class: 'formula__left' }, [
          el('label', { class: 'formula__label', for: 'formula-input' }, ['Source']),
          this.input,
          this.problem,
          this.palette,
        ]),
        el('div', { class: 'formula__right' }, [
          el('span', { class: 'formula__label' }, ['Typeset']),
          this.preview,
          el('span', { class: 'formula__label' }, ['Read aloud as']),
          this.spoken,
        ]),
      ]),
      this.statusLine,
    ]);

    this.input.id = 'formula-input';
    this.input.value = this.source;

    this.buildToolbar();
    this.buildPalette();
    this.wire();
    this.render();
  }

  private buildToolbar(): void {
    clear(this.toolbar);

    const select = el('select', {
      class: 'formula__examples',
      'aria-label': 'Insert an example',
    }) as HTMLSelectElement;
    select.append(el('option', { value: '', text: 'Examples...' }));
    for (const example of EXAMPLES) {
      select.append(el('option', { value: example.source, text: example.label }));
    }
    this.toolbar.append(select);

    this.toolbar.append(
      el(
        'button',
        {
          class: 'formula__action',
          type: 'button',
          'data-action': 'display',
          'aria-pressed': this.display ? 'true' : 'false',
          title: 'Block display centres the formula and puts limits above and below',
        },
        ['Block display'],
      ),
      el('button', { class: 'formula__action', type: 'button', 'data-action': 'copy-mathml' }, [
        'Copy MathML',
      ]),
      el('button', { class: 'formula__action', type: 'button', 'data-action': 'export' }, [
        'Export as MathML',
      ]),
    );
  }

  private buildPalette(): void {
    clear(this.palette);
    for (const group of PALETTE) {
      this.palette.append(
        el('div', { class: 'formula__group' }, [
          el('span', { class: 'formula__group-label' }, [group.group]),
          ...group.items.map((item) =>
            el(
              'button',
              {
                class: 'formula__insert',
                type: 'button',
                'data-insert': item.insert,
                // The label is the accessible name; the source is the tooltip.
                // A button labelled only with backslash-frac is unreadable
                // aloud and meaningless to anybody who does not know TeX.
                'aria-label': 'Insert ' + item.label,
                title: item.insert,
              },
              [item.label],
            ),
          ),
        ]),
      );
    }
  }

  private wire(): void {
    this.input.addEventListener('input', () => {
      this.source = this.input.value;
      this.options.onChange?.(this.source);
      this.render();
    });

    this.palette.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.formula__insert');
      if (!target) return;
      this.insert(target.getAttribute('data-insert') ?? '');
    });

    this.toolbar.addEventListener('change', (event) => {
      const target = event.target as HTMLSelectElement;
      if (!target.classList.contains('formula__examples')) return;
      if (target.value === '') return;
      this.source = target.value;
      this.input.value = this.source;
      // Reset, so choosing the same example twice works.
      target.value = '';
      this.options.onChange?.(this.source);
      this.render();
    });

    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.formula__action');
      if (!target) return;
      const action = target.getAttribute('data-action');
      if (action === 'display') {
        this.display = !this.display;
        this.buildToolbar();
        this.render();
      } else if (action === 'copy-mathml') {
        void this.copyMathml();
      } else if (action === 'export') {
        this.exportMathml();
      }
    });
  }

  /**
   * Insert at the caret, not at the end.
   *
   * Appending is what a palette usually does and it is wrong: somebody who has
   * put the caret in the middle of a fraction wants the symbol there. The
   * caret is placed after the insertion so typing continues naturally.
   */
  private insert(text: string): void {
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    const before = this.input.value.slice(0, start);
    const after = this.input.value.slice(end);

    this.input.value = before + text + after;
    this.source = this.input.value;
    this.input.focus();
    this.input.setSelectionRange(start + text.length, start + text.length);

    this.options.onChange?.(this.source);
    this.render();
  }

  private currentMathml(): string | undefined {
    if (this.source.trim().length === 0) return undefined;
    try {
      const node = parseFormula(this.source);
      return toMathml(node, { display: this.display, label: describe(node) });
    } catch {
      return undefined;
    }
  }

  private async copyMathml(): Promise<void> {
    const mathml = this.currentMathml();
    if (mathml === undefined) {
      this.setStatus('Nothing to copy: the formula is empty or not valid yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(mathml);
      this.setStatus('Copied ' + mathml.length + ' characters of MathML to the clipboard.');
    } catch {
      // Reported rather than swallowed: a copy button that silently does
      // nothing is the decorative-control defect in miniature.
      this.setStatus('The clipboard refused the copy. Use Export instead.');
    }
  }

  private exportMathml(): void {
    const mathml = this.currentMathml();
    if (mathml === undefined) {
      this.setStatus('Nothing to export: the formula is empty or not valid yet.');
      return;
    }
    const blob = new Blob([mathml], { type: 'application/mathml+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: 'formula.mml' }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.setStatus('Exported as MathML. Nothing was lost: MathML is the source of truth here.');
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    if (this.source.trim().length === 0) {
      clear(this.preview);
      clear(this.spoken);
      this.setProblem('');
      this.preview.append(
        el('span', { class: 'formula__empty' }, ['Nothing typed yet.']),
      );
      this.spoken.append('Nothing typed yet.');
      this.setStatus('0 characters');
      return;
    }

    // PARSED BEFORE ANYTHING IS CLEARED.
    //
    // The first version cleared the preview at the top of this method and then
    // returned early on a parse failure, so the panel went blank on nearly
    // every keystroke — most partial input is invalid on its way to being
    // valid. The comment said the previous rendering was left in place; the
    // code did the opposite, and only driving it showed which was true.
    let node;
    try {
      node = parseFormula(this.source);
    } catch (error) {
      this.setProblem(
        error instanceof FormulaError ? error.message : String(error),
      );
      this.setStatus(this.source.length + ' characters   not valid yet');
      return;
    }

    clear(this.preview);
    clear(this.spoken);
    this.setProblem('');

    const mathml = toMathml(node, { display: this.display, label: describe(node) });

    // Parsed as XML and imported, rather than assigned as innerHTML. The input
    // is user text, and building a DOM from a string is precisely how user
    // text becomes markup.
    const parsed = new DOMParser().parseFromString(mathml, 'application/xhtml+xml');
    const root = parsed.documentElement;
    if (root.nodeName === 'parsererror' || parsed.getElementsByTagName('parsererror').length > 0) {
      this.setProblem('The formula produced markup this browser could not parse.');
      return;
    }
    this.preview.append(document.importNode(root, true));

    const spoken = describe(node);
    this.spoken.append(spoken);
    this.setStatus(
      this.source.length +
        ' characters   ' +
        mathml.length +
        ' of MathML   ' +
        (this.display ? 'block display' : 'inline'),
    );
  }

  private setProblem(message: string): void {
    clear(this.problem);
    if (message === '') {
      this.problem.setAttribute('data-shown', 'false');
      return;
    }
    // Said in words, not shown by turning the field red. A colour alone tells
    // a screen-reader user nothing and tells everybody else only that
    // something is wrong, not what.
    this.problem.append(message);
    this.problem.setAttribute('data-shown', 'true');
  }

  private setStatus(message: string): void {
    clear(this.statusLine);
    this.statusLine.append(message);
  }
}
