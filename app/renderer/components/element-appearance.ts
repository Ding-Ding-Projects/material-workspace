/**
 * The per-element appearance editor.
 *
 * Opened from an element's own right-click menu, anchored beside that element,
 * non-modal, and returning focus to it on close. Anchored rather than modal
 * because the whole point is watching the element change while the control
 * moves: a dialog in the middle of the screen covering the thing being styled
 * makes every adjustment a guess.
 *
 * The model behind it is `app/shared/element-style.ts`, which owns what a
 * property accepts and how it becomes CSS. This file is the surface only, so a
 * value the model refuses is reported here and never written anywhere.
 *
 * WHAT IS NOT HERE, SAID OUT LOUD. Layer stacks, masks, blend modes and the
 * rest of the Photoshop-depth contract are not built. The editor does not
 * pretend otherwise: it shows the properties it really applies, and the
 * documentation article names the gap rather than leaving it to be discovered.
 */

import {
  type PropertyDefinition,
  type PropertyGroup,
  type StyleBook,
  PROPERTIES,
  accept,
  countOverrides,
  resetElement,
  resetProperty,
  setProperty,
} from '../../shared/element-style.js';
import { el } from '../dom.js';
import { ColourPicker } from './colour-picker.js';
import { Overlay } from './overlay.js';
import { SearchField, type SearchPredicate } from './search-field.js';

export interface ElementAppearanceOptions {
  readonly anchor: HTMLElement;
  /** The stable id this element's overrides are stored under. */
  readonly elementId: string;
  /** What to call the element in the editor's own heading. */
  readonly elementLabel: string;
  readonly book: StyleBook;
  /** Fonts the machine actually has. Empty is honest, not a bug. */
  readonly fonts?: readonly string[];
  readonly onChange: (book: StyleBook) => void;
  readonly onClose?: () => void;
}

const GROUPS: readonly PropertyGroup[] = [
  'Typography',
  'Text',
  'Colour',
  'Spacing',
  'Shape',
  'Effects',
];

export class ElementAppearance {
  private readonly overlay: Overlay;
  private readonly body: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly problem: HTMLElement;
  private readonly search: SearchField;
  private predicate: SearchPredicate | null = null;
  private book: StyleBook;

  constructor(private readonly options: ElementAppearanceOptions) {
    this.book = options.book;

    this.summary = el('p', { class: 'element-appearance__summary', role: 'status' });
    this.problem = el('p', {
      class: 'element-appearance__problem',
      role: 'alert',
      hidden: true,
    });
    this.rows = el('div', { class: 'element-appearance__rows' });

    this.search = new SearchField({
      id: 'element-appearance-search',
      label: 'Find a property',
      placeholder: 'Find a property',
      onChange: (predicate) => {
        this.predicate = predicate;
        this.renderRows();
      },
    });

    this.overlay = new Overlay({
      anchor: options.anchor,
      label: 'Appearance of ' + options.elementLabel,
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    });
    this.overlay.element.classList.add('element-appearance');

    this.body = el('div', { class: 'element-appearance__body' }, [
      el('header', { class: 'element-appearance__head' }, [
        el('h2', {
          class: 'element-appearance__title',
          // Names the exact element, so a popover that drifted from its anchor
          // still says what it is editing.
          text: 'Appearance of ' + options.elementLabel,
        }),
        this.summary,
      ]),
      this.search.element,
      this.problem,
      this.rows,
      el('footer', { class: 'element-appearance__foot' }, [
        this.resetElementButton(),
        el('p', {
          class: 'element-appearance__note',
          text:
            'Changes apply straight away and are stored beside the shipped values, ' +
            'so every reset really returns to what shipped.',
        }),
      ]),
    ]);

    this.renderRows();
  }

  open(): void {
    this.overlay.show(this.body);
  }

  close(): void {
    this.overlay.close();
  }

  private resetElementButton(): HTMLElement {
    const button = el(
      'button',
      { class: 'element-appearance__reset-all', type: 'button', 'data-reset': 'element' },
      ['Reset this element'],
    );
    button.addEventListener('click', () => {
      this.commit(resetElement(this.book, this.options.elementId));
    });
    return button;
  }

  private commit(book: StyleBook): void {
    this.book = book;
    this.options.onChange(book);
    this.renderRows();
  }

  private say(problem: string | null): void {
    this.problem.hidden = problem === null;
    this.problem.textContent = problem ?? '';
  }

  private visible(): readonly PropertyDefinition[] {
    const predicate = this.predicate;
    if (predicate === null || predicate.empty) return PROPERTIES;
    // An invalid pattern matches nothing rather than falling back to plain
    // text, exactly as every other search here.
    if (predicate.test === null) return [];
    const test = predicate.test;
    return PROPERTIES.filter(
      (property) => test(property.label) || test(property.group),
    );
  }

  private renderRows(): void {
    while (this.rows.firstChild) this.rows.firstChild.remove();

    const overrides = countOverrides(this.book, this.options.elementId);
    this.summary.textContent =
      overrides === 0
        ? 'Nothing on this element is customized yet.'
        : overrides +
          (overrides === 1 ? ' property is customized.' : ' properties are customized.');

    const shown = this.visible();
    if (shown.length === 0) {
      this.rows.append(
        el('p', { class: 'element-appearance__empty', role: 'status' }, [
          'No property matches that.',
        ]),
      );
      return;
    }

    for (const group of GROUPS) {
      const inGroup = shown.filter((property) => property.group === group);
      if (inGroup.length === 0) continue;

      this.rows.append(
        el('h3', { class: 'element-appearance__group', 'data-group': group }, [group]),
      );
      for (const property of inGroup) this.rows.append(this.renderRow(property));
    }
  }

  private storedValue(property: PropertyDefinition): string | null {
    return this.book[this.options.elementId]?.[property.id] ?? null;
  }

  private renderRow(property: PropertyDefinition): HTMLElement {
    const stored = this.storedValue(property);
    const control = this.renderControl(property, stored);

    const reset = el(
      'button',
      {
        class: 'element-appearance__reset',
        type: 'button',
        'data-reset-property': property.id,
        'aria-label': 'Reset ' + property.label,
        // Always present, never only when set. A control that appears and
        // disappears as a value changes is a control nobody finds twice.
        ...(stored === null ? { disabled: true, title: 'Nothing to reset' } : {}),
      },
      ['Reset'],
    );
    reset.addEventListener('click', () => {
      this.say(null);
      this.commit(resetProperty(this.book, this.options.elementId, property.id));
    });

    return el(
      'div',
      {
        class: 'element-appearance__row',
        'data-property': property.id,
        'data-set': stored === null ? 'no' : 'yes',
      },
      [
        el('label', { class: 'element-appearance__label', for: 'prop-' + property.id }, [
          property.label,
        ]),
        control,
        reset,
        // The provenance line every settings element carries: whether this is
        // the user's value or the shipped one, naming the real value rather
        // than the word "default".
        el('p', { class: 'element-appearance__origin' }, [
          stored === null
            ? 'Not set here, so this element uses whatever the theme gives it.'
            : 'Set here to ' + stored + (property.unit ?? '') + '.',
        ]),
        property.unsupported === undefined
          ? null
          : el('p', { class: 'element-appearance__limit' }, [property.unsupported]),
      ],
    );
  }

  private renderControl(property: PropertyDefinition, stored: string | null): HTMLElement {
    const id = 'prop-' + property.id;

    if (property.kind === 'colour') {
      const picker = new ColourPicker({
        value: stored ?? '#000000',
        onChange: (value) => this.write(property, value),
      });
      picker.element.classList.add('element-appearance__colour');
      return picker.element;
    }

    if (property.kind === 'toggle') {
      const input = el('input', {
        class: 'element-appearance__toggle',
        id,
        type: 'checkbox',
        ...(stored === property.on ? { checked: true } : {}),
      }) as HTMLInputElement;
      input.addEventListener('change', () => {
        this.write(property, input.checked ? (property.on ?? '') : (property.off ?? ''));
      });
      return input;
    }

    if (property.kind === 'choice') {
      const options =
        property.options !== undefined && property.options.length > 0
          ? property.options
          : (this.options.fonts ?? []).map((font) => ({ value: font, label: font }));

      if (options.length === 0) {
        // Honest rather than an empty select that looks broken. This happens
        // when the platform gave us no font list, which is a real state.
        return el('p', { class: 'element-appearance__unavailable', id }, [
          'This machine reported no installed fonts, so there is nothing to choose from yet.',
        ]);
      }

      const select = el('select', { class: 'element-appearance__select', id }) as HTMLSelectElement;
      for (const option of options) {
        const node = el('option', { value: option.value }, [option.label]) as HTMLOptionElement;
        // Each font name rendered in its own face, so the list is a preview
        // rather than a column of identical words.
        if (property.id === 'fontFamily') node.style.fontFamily = option.value;
        if (option.value === stored) node.selected = true;
        select.append(node);
      }
      select.addEventListener('change', () => this.write(property, select.value));
      return select;
    }

    // A length or a number: a stepper AND free entry, because a slider alone
    // cannot hit an exact value and a box alone is tedious to nudge.
    const input = el('input', {
      class: 'element-appearance__number',
      id,
      type: 'number',
      min: property.min ?? 0,
      max: property.max ?? 100,
      step: property.step ?? 1,
      value: stored ?? '',
    }) as HTMLInputElement;
    input.addEventListener('change', () => this.write(property, input.value));
    return input;
  }

  private write(property: PropertyDefinition, raw: string): void {
    const checked = accept(property.id, raw);
    if (!checked.ok) {
      // Reported inline, in words, without discarding what was typed. A red
      // border alone says something is wrong and never what.
      this.say(property.label + ': ' + checked.reason);
      return;
    }
    this.say(null);

    const result = setProperty(this.book, this.options.elementId, property.id, raw);
    if ('ok' in result) {
      this.say(property.label + ': ' + result.reason);
      return;
    }
    this.commit(result.book);
  }
}
