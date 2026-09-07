/**
 * A search field with its own anchored regular-expression builder.
 *
 * This is the component every searchable surface uses — lists, tables, settings
 * pages, dropdowns and right-click menus alike. Centralising it is what makes
 * "every search field has a builder" true by construction rather than true only
 * where somebody remembered.
 *
 * Rules encoded here:
 *
 *   - Plain text is the DEFAULT. Regular expressions are an explicit opt-in, so
 *     a user typing `a.b` into a filter matches the literal text they typed.
 *   - The builder is ANCHORED to this field. Each field owns its own, so several
 *     search bars on one surface never share hidden state — one shared builder
 *     silently applying to whichever field was last touched is the confusion
 *     this design exists to avoid.
 *   - Query, pattern, flags and mode synchronise BOTH ways, so typing in the
 *     field updates the builder and building updates the field.
 *   - An invalid pattern reports inline and matches NOTHING rather than falling
 *     back to plain text. A silent fallback would return results the user did
 *     not ask for, which is worse than an empty list with a reason.
 */

import { el } from '../dom.js';
import { RegexBuilder, type RegexState } from './regex/builder.js';
import { compile } from './regex/tokenize.js';

export type SearchMode = 'text' | 'regex';

export interface SearchFieldOptions {
  /** Unique within the surface. Used for label association and persistence. */
  id: string;
  label: string;
  placeholder?: string;
  /** Called whenever the effective filter changes. */
  onChange: (predicate: SearchPredicate) => void;
}

export interface SearchPredicate {
  mode: SearchMode;
  query: string;
  /** Null when the query is empty, or when a regex query does not compile. */
  test: ((value: string) => boolean) | null;
  error: string | null;
  /** True when nothing is being filtered, so a caller can skip the work. */
  empty: boolean;
}

export class SearchField {
  readonly element: HTMLElement;

  private readonly input: HTMLInputElement;
  private readonly builderButton: HTMLButtonElement;
  private readonly modeToggle: HTMLInputElement;
  private readonly errorRegion: HTMLElement;
  private readonly options: SearchFieldOptions;

  private builder: RegexBuilder | null = null;
  private state: RegexState = { pattern: '', flags: '', replacement: '', sample: '' };
  private mode: SearchMode = 'text';

  constructor(options: SearchFieldOptions) {
    this.options = options;

    this.input = el('input', {
      class: 'search-field__input',
      type: 'search',
      id: options.id,
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: options.placeholder ?? 'Search',
      'aria-describedby': options.id + '-error',
    }) as HTMLInputElement;
    this.input.addEventListener('input', () => {
      this.state.pattern = this.input.value;
      this.builder?.setState({ pattern: this.input.value });
      this.notify();
    });

    const modeId = options.id + '-mode';
    this.modeToggle = el('input', { type: 'checkbox', id: modeId }) as HTMLInputElement;
    this.modeToggle.addEventListener('change', () => {
      this.mode = this.modeToggle.checked ? 'regex' : 'text';
      this.notify();
    });

    this.builderButton = el('button', {
      class: 'search-field__builder-button',
      type: 'button',
      // The affordance belongs to THIS field, and its accessible name says so,
      // because a surface can carry several search bars.
      'aria-label': 'Open the regular expression builder for ' + options.label,
      'aria-expanded': 'false',
      title: 'Regular expression builder',
    }) as HTMLButtonElement;
    this.builderButton.textContent = '.*';
    this.builderButton.addEventListener('click', () => this.toggleBuilder());

    this.errorRegion = el('p', {
      class: 'search-field__error',
      id: options.id + '-error',
      role: 'status',
      'aria-live': 'polite',
    });

    this.element = el('div', { class: 'search-field' }, [
      el('label', { class: 'visually-hidden', for: options.id, text: options.label }),
      el('div', { class: 'search-field__row' }, [
        this.input,
        el('label', { class: 'search-field__mode', for: modeId, title: 'Use a regular expression' }, [
          this.modeToggle,
          el('span', { text: 'Regex' }),
        ]),
        this.builderButton,
      ]),
      this.errorRegion,
    ]);
  }

  private toggleBuilder(): void {
    if (!this.builder) {
      this.builder = new RegexBuilder({
        anchor: this.builderButton,
        initial: this.state,
        onChange: (state) => {
          this.state = state;
          // Bidirectional: building a pattern writes it back into the field,
          // and turns regex mode on because that is plainly what was meant.
          if (this.input.value !== state.pattern) this.input.value = state.pattern;
          if (state.pattern.length > 0 && this.mode === 'text') {
            this.mode = 'regex';
            this.modeToggle.checked = true;
          }
          this.notify();
        },
        onClose: () => this.builderButton.setAttribute('aria-expanded', 'false'),
      });
    }
    this.builder.toggle();
    this.builderButton.setAttribute('aria-expanded', String(this.builder.isOpen));
  }

  /** The current filter, as a predicate a caller can apply to any string. */
  predicate(): SearchPredicate {
    const query = this.input.value;
    if (query.length === 0) {
      return { mode: this.mode, query, test: null, error: null, empty: true };
    }

    if (this.mode === 'text') {
      const needle = query.toLocaleLowerCase();
      return {
        mode: 'text',
        query,
        test: (value) => value.toLocaleLowerCase().includes(needle),
        error: null,
        empty: false,
      };
    }

    const compiled = compile(query, this.state.flags);
    if (compiled.error !== null) {
      // Matches nothing, and says why. Falling back to plain text here would
      // return results the user did not ask for.
      return { mode: 'regex', query, test: null, error: compiled.error, empty: false };
    }
    return {
      mode: 'regex',
      query,
      test: (value) => {
        compiled.regex.lastIndex = 0;
        return compiled.regex.test(value);
      },
      error: null,
      empty: false,
    };
  }

  private notify(): void {
    const predicate = this.predicate();
    this.errorRegion.textContent = predicate.error ?? '';
    this.errorRegion.toggleAttribute('data-has-error', predicate.error !== null);
    this.options.onChange(predicate);
  }

  focus(): void {
    this.input.focus();
  }

  clear(): void {
    this.input.value = '';
    this.state.pattern = '';
    this.builder?.setState({ pattern: '' });
    this.notify();
  }

  get value(): string {
    return this.input.value;
  }
}

/**
 * Apply a predicate to a list, returning everything when the filter is empty and
 * NOTHING when the pattern is invalid.
 *
 * The invalid case is deliberate and worth stating: returning everything would
 * make a broken pattern look like a working one that happens to match all.
 */
export function applyPredicate<T>(
  items: T[],
  predicate: SearchPredicate,
  toText: (item: T) => string,
): T[] {
  if (predicate.empty) return items;
  if (!predicate.test) return [];
  const test = predicate.test;
  return items.filter((item) => test(toText(item)));
}
