/**
 * The changelog viewer.
 *
 * Every released change, in the application rather than only on a website. A
 * link to release notes somewhere else does not satisfy this: somebody
 * wondering what changed is looking at the thing that changed.
 *
 * THE DATA IS GENERATED FROM `git log`, never hand-maintained. A hand-written
 * changelog drifts from what actually shipped within about a fortnight, and the
 * drift is invisible - every entry looks plausible, and the one that is missing
 * is missing silently.
 *
 * EVERY ENTRY LINKS TO ITS COMMIT, and the generator refuses to write an entry
 * whose commit does not exist. A dead link is worse than none: it sends a
 * reader somewhere confidently irrelevant.
 */

import data from '../changelog-data.json' with { type: 'json' };
import { clear, el } from '../dom.js';
import { plainMatcher, regexMatcher } from '../tabs/model.js';

export interface ChangelogEntry {
  readonly commit: string;
  readonly shortCommit: string;
  readonly at: string;
  readonly subject: string;
  readonly category: string;
}

export interface ChangelogData {
  readonly repository: string | null;
  readonly commitUrlPrefix: string | null;
  readonly entries: readonly ChangelogEntry[];
}

export interface ChangelogOptions {
  /** Injected so a test can supply a known set rather than the real history. */
  readonly data?: ChangelogData;
  readonly onCopy?: (text: string) => void;
  readonly onOpen?: (url: string) => void;
}

export class Changelog {
  readonly element: HTMLElement;

  private readonly data: ChangelogData;
  private readonly chosen = new Set<string>();

  private readonly since: HTMLInputElement;
  private readonly until: HTMLInputElement;
  private readonly typed: HTMLInputElement;
  private readonly dateError: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly regexToggle: HTMLInputElement;
  private readonly flags: HTMLInputElement;
  private readonly searchError: HTMLElement;
  private readonly categoryRow: HTMLElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly options: ChangelogOptions = {}) {
    this.data = options.data ?? (data as unknown as ChangelogData);

    this.since = el('input', { class: 'changelog-input', type: 'date', id: 'changelog-since' }) as HTMLInputElement;
    this.until = el('input', { class: 'changelog-input', type: 'date', id: 'changelog-until' }) as HTMLInputElement;
    this.typed = el('input', {
      class: 'changelog-input',
      type: 'text',
      id: 'changelog-typed',
      placeholder: 'or type 2026-09-01',
      spellcheck: 'false',
    }) as HTMLInputElement;
    this.dateError = el('p', { class: 'changelog-error', role: 'alert', hidden: true });

    this.search = el('input', {
      class: 'changelog-input',
      type: 'search',
      id: 'changelog-search',
      placeholder: 'Search what changed',
    }) as HTMLInputElement;
    this.regexToggle = el('input', {
      class: 'changelog-check',
      type: 'checkbox',
      id: 'changelog-regex',
    }) as HTMLInputElement;
    this.flags = el('input', {
      class: 'changelog-input changelog-flags',
      type: 'text',
      id: 'changelog-flags',
      value: 'i',
      'aria-label': 'Regular expression flags',
    }) as HTMLInputElement;
    this.searchError = el('p', { class: 'changelog-error', role: 'alert', hidden: true });

    for (const control of [this.since, this.until, this.search, this.regexToggle, this.flags]) {
      control.addEventListener('input', () => this.render());
      control.addEventListener('change', () => this.render());
    }
    this.typed.addEventListener('change', () => this.onTyped());

    this.categoryRow = el('div', {
      class: 'changelog-categories',
      role: 'group',
      'aria-label': 'Filter by kind of change',
    });
    this.count = el('p', { class: 'changelog-count', role: 'status' });
    this.list = el('ul', { class: 'changelog-list', role: 'list' });

    const copy = el('button', {
      class: 'changelog-action',
      type: 'button',
      text: 'Copy what is shown',
    }) as HTMLButtonElement;
    copy.addEventListener('click', () => this.options.onCopy?.(this.asMarkdown()));

    const exportButton = el('button', {
      class: 'changelog-action',
      type: 'button',
      text: 'Export as Markdown',
    }) as HTMLButtonElement;
    exportButton.addEventListener('click', () => this.options.onCopy?.(this.asMarkdown()));

    this.element = el('section', { class: 'changelog', 'aria-label': 'Changelog' }, [
      el('header', { class: 'changelog-header' }, [
        el('h2', { class: 'changelog-title', text: 'Changelog' }),
        el('p', {
          class: 'changelog-lede',
          text:
            'Generated from the repository itself, so it cannot drift from what shipped. ' +
            'Every entry carries the commit that made the change.',
        }),
      ]),

      el('div', { class: 'changelog-filters' }, [
        el('label', { class: 'changelog-label', for: 'changelog-since', text: 'From' }),
        this.since,
        el('label', { class: 'changelog-label', for: 'changelog-until', text: 'To' }),
        this.until,
        el('label', { class: 'changelog-label', for: 'changelog-typed', text: 'Or type a date' }),
        this.typed,
        this.dateError,
        el('label', { class: 'changelog-label', for: 'changelog-search', text: 'Containing' }),
        this.search,
        el('div', { class: 'changelog-regex-row' }, [
          this.regexToggle,
          el('label', {
            class: 'changelog-label',
            for: 'changelog-regex',
            text: 'Regular expression',
          }),
          el('label', { class: 'changelog-label', for: 'changelog-flags', text: 'Flags' }),
          this.flags,
        ]),
        this.searchError,
        el('span', { class: 'changelog-label', text: 'Kind' }),
        this.categoryRow,
      ]),

      this.count,
      this.list,
      el('div', { class: 'changelog-actions-row' }, [copy, exportButton]),
    ]);

    this.render();
  }

  /** What is currently shown, for tests. */
  shown(): ChangelogEntry[] {
    return this.filtered();
  }

  private onTyped(): void {
    const text = this.typed.value.trim();
    if (text === '') {
      this.dateError.hidden = true;
      this.render();
      return;
    }
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00') : null;
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      // Reported inline, and the text is LEFT ALONE. Clearing what somebody
      // typed to punish a typo is how a field becomes infuriating.
      this.dateError.hidden = false;
      this.dateError.textContent =
        'That is not a date this can read. Try 2026-09-01, or use the picker above.';
      return;
    }
    this.dateError.hidden = true;
    this.since.value = text;
    this.render();
  }

  private matcher(): { test: (text: string) => boolean; error: string | null } {
    if (!this.regexToggle.checked) {
      return { test: plainMatcher(this.search.value), error: null };
    }
    const pattern = this.search.value;
    if (pattern.trim() === '') return { test: plainMatcher(''), error: null };
    try {
      new RegExp(pattern, this.flags.value);
    } catch (error) {
      return { test: () => false, error: 'Not a usable pattern: ' + (error as Error).message };
    }
    return { test: regexMatcher(pattern, this.flags.value), error: null };
  }

  private filtered(): ChangelogEntry[] {
    const { test } = this.matcher();
    const since = this.since.value === '' ? null : this.since.value;
    const until = this.until.value === '' ? null : this.until.value;

    return this.data.entries.filter((entry) => {
      // Every filter COMPOSES rather than overriding, so a result set is
      // always explainable by the controls that are set.
      const day = entry.at.slice(0, 10);
      if (since !== null && day < since) return false;
      if (until !== null && day > until) return false;
      if (this.chosen.size > 0 && !this.chosen.has(entry.category)) return false;
      return test(entry.subject + ' ' + entry.shortCommit);
    });
  }

  private asMarkdown(): string {
    // The export honours the ACTIVE filter, so it matches what is on screen.
    // An export that quietly dumped everything would disagree with the count
    // above it.
    const rows = this.filtered();
    const range =
      (this.since.value === '' ? 'the beginning' : this.since.value) +
      ' to ' +
      (this.until.value === '' ? 'now' : this.until.value);

    const lines = ['# Changelog (' + range + ')', ''];
    for (const entry of rows) {
      const link =
        this.data.commitUrlPrefix === null
          ? '`' + entry.shortCommit + '`'
          : '[`' + entry.shortCommit + '`](' + this.data.commitUrlPrefix + entry.commit + ')';
      lines.push('- ' + entry.subject + ' — ' + link + ' — ' + entry.at.slice(0, 10));
    }
    if (rows.length === 0) lines.push('_Nothing matched those filters._');
    return lines.join('\n') + '\n';
  }

  private render(): void {
    this.flags.disabled = !this.regexToggle.checked;

    const { error } = this.matcher();
    this.searchError.hidden = error === null;
    this.searchError.textContent = error ?? '';

    // Categories come from the data rather than a fixed list, so a category
    // the generator starts emitting cannot go unfilterable.
    const counts = new Map<string, number>();
    for (const entry of this.data.entries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }

    clear(this.categoryRow);
    for (const [category, total] of [...counts.entries()].sort()) {
      const id = 'changelog-category-' + category;
      const box = el('input', { class: 'changelog-check', type: 'checkbox', id }) as HTMLInputElement;
      box.checked = this.chosen.has(category);
      box.addEventListener('change', () => {
        if (box.checked) this.chosen.add(category);
        else this.chosen.delete(category);
        this.render();
      });
      this.categoryRow.append(
        el('span', { class: 'changelog-chip' }, [
          box,
          el('label', { class: 'changelog-label', for: id, text: category + ' (' + total + ')' }),
        ]),
      );
    }

    const rows = this.filtered();
    this.count.textContent =
      rows.length === 0
        ? 'Nothing matched those filters.'
        : rows.length + ' of ' + this.data.entries.length + ' changes.';

    clear(this.list);
    for (const entry of rows) {
      const identifier = el('a', {
        class: 'changelog-commit',
        href: this.data.commitUrlPrefix === null ? '#' : this.data.commitUrlPrefix + entry.commit,
        text: entry.shortCommit,
        // The link says where it goes, because "a2a71f6" tells a screen-reader
        // user nothing about what activating it does.
        'aria-label': 'Open commit ' + entry.shortCommit + ' on the repository',
      }) as HTMLAnchorElement;
      identifier.addEventListener('click', (event) => {
        if (this.data.commitUrlPrefix === null) {
          event.preventDefault();
          return;
        }
        // Opened through the host rather than navigating this window, which
        // would replace the application with a web page.
        event.preventDefault();
        this.options.onOpen?.(this.data.commitUrlPrefix + entry.commit);
      });

      this.list.append(
        el('li', { class: 'changelog-item', role: 'listitem' }, [
          el('span', { class: 'changelog-category', text: entry.category }),
          el('span', { class: 'changelog-subject', text: entry.subject }),
          el('span', { class: 'changelog-date', text: entry.at.slice(0, 10) }),
          identifier,
        ]),
      );
    }
  }
}
