/**
 * The four tab-discovery searches, in one surface.
 *
 * They are four rather than one because they answer four different questions,
 * and a single box that silently answered whichever one it felt like would be
 * the most confusing of the lot:
 *
 *   1. THIS STRIP - "where did that tab go?"
 *   2. INSIDE A GROUP - "which of the Research tabs was it?"
 *   3. GROUPS - "what did I call that group?"
 *   4. EVERYTHING - "it is open somewhere, but which window?"
 *
 * Each field owns its own query, pattern, flags and mode. Sharing state between
 * them would mean typing in one silently filtered another, which is the exact
 * hidden coupling the four-search rule exists to prevent.
 */

import { clear, el } from '../dom.js';
import {
  type SearchResult,
  type StripState,
  type TabGroupRecord,
  type TabRecord,
  planClose,
  plainMatcher,
  regexMatcher,
  searchEverything,
  searchGroup,
  searchGroups,
  searchStrip,
} from '../tabs/model.js';

export interface WindowSnapshot {
  readonly name: string;
  readonly tabs: readonly TabRecord[];
  readonly state: StripState;
  readonly active: string;
}

export interface TabSearchOptions {
  readonly windows: () => readonly WindowSnapshot[];
  /** Which window this surface belongs to. Search one and two use it. */
  readonly current: () => WindowSnapshot;
  readonly onReveal?: (tabId: string, windowName: string) => void;
  readonly onCloseMany?: (ids: readonly string[]) => void;
}

type Kind = 'strip' | 'group' | 'groups' | 'everything';

interface Field {
  readonly kind: Kind;
  readonly input: HTMLInputElement;
  readonly regexToggle: HTMLInputElement;
  readonly flagsInput: HTMLInputElement;
  readonly error: HTMLElement;
  readonly results: HTMLElement;
  readonly count: HTMLElement;
  /** Only search two has one. */
  readonly groupSelect?: HTMLSelectElement;
}

const TITLES: Record<Kind, { title: string; help: string }> = {
  strip: {
    title: 'Tabs in this window',
    help: 'Where did that tab go? Searches the strip you are looking at.',
  },
  group: {
    title: 'Tabs inside one group',
    help: 'Which of them was it? Searches a single group and nothing outside it.',
  },
  groups: {
    title: 'Groups',
    help: 'What did you call that group? Searches the group names themselves.',
  },
  everything: {
    title: 'Every tab, everywhere',
    help: 'It is open somewhere. Searches every window and workspace, not just this one.',
  },
};

export class TabSearch {
  readonly element: HTMLElement;

  private readonly fields: Field[] = [];
  private readonly closePreview: HTMLElement;

  constructor(private readonly options: TabSearchOptions) {
    this.closePreview = el('div', { class: 'tabsearch-preview', hidden: true, role: 'status' });

    const panels = (['strip', 'group', 'groups', 'everything'] as const).map((kind) =>
      this.buildField(kind),
    );

    this.element = el('section', { class: 'tabsearch', 'aria-label': 'Find a tab' }, [
      el('header', { class: 'tabsearch-header' }, [
        el('h2', { class: 'tabsearch-title', text: 'Find a tab' }),
        el('p', {
          class: 'tabsearch-lede',
          text:
            'Four searches, because they answer four different questions. Each keeps its own ' +
            'query, so typing in one never quietly filters another.',
        }),
      ]),
      ...panels,
      el('div', { class: 'tabsearch-bulk' }, [
        el('h3', { class: 'tabsearch-subtitle', text: 'Close many at once' }),
        this.buildBulk(),
        this.closePreview,
      ]),
    ]);

    this.refresh();
  }

  /** Re-run every search. Called when tabs, groups or windows change. */
  refresh(): void {
    for (const field of this.fields) this.run(field);
    this.syncGroupOptions();
  }

  private buildField(kind: Kind): HTMLElement {
    const id = 'tabsearch-' + kind;

    const input = el('input', {
      class: 'tabsearch-input',
      type: 'search',
      id,
      spellcheck: 'false',
      placeholder: 'Type to filter',
      'aria-describedby': id + '-help',
    }) as HTMLInputElement;

    const regexToggle = el('input', {
      class: 'tabsearch-regex',
      type: 'checkbox',
      id: id + '-regex',
    }) as HTMLInputElement;

    const flagsInput = el('input', {
      class: 'tabsearch-flags',
      type: 'text',
      id: id + '-flags',
      value: 'i',
      size: 4,
      'aria-label': 'Regular expression flags',
    }) as HTMLInputElement;

    const error = el('p', { class: 'tabsearch-error', role: 'alert', hidden: true });
    const results = el('ul', { class: 'tabsearch-results', role: 'list' });
    const count = el('p', { class: 'tabsearch-count', role: 'status' });

    let groupSelect: HTMLSelectElement | undefined;
    if (kind === 'group') {
      groupSelect = el('select', {
        class: 'tabsearch-group-select',
        id: id + '-which',
      }) as HTMLSelectElement;
    }

    const field: Field = {
      kind,
      input,
      regexToggle,
      flagsInput,
      error,
      results,
      count,
      ...(groupSelect === undefined ? {} : { groupSelect }),
    };
    this.fields.push(field);

    for (const control of [input, regexToggle, flagsInput]) {
      control.addEventListener('input', () => this.run(field));
      control.addEventListener('change', () => this.run(field));
    }
    groupSelect?.addEventListener('change', () => this.run(field));

    const info = TITLES[kind];
    return el('div', { class: 'tabsearch-field', 'data-kind': kind }, [
      el('h3', { class: 'tabsearch-subtitle', text: info.title }),
      el('p', { class: 'tabsearch-help', id: id + '-help', text: info.help }),
      groupSelect === undefined
        ? null
        : el('label', { class: 'tabsearch-label', for: id + '-which', text: 'Which group' }),
      groupSelect ?? null,
      // The label says what to TYPE, not what the card is called. Repeating
      // the heading a line below it wastes a line and tells a screen-reader
      // user the same thing twice in a row.
      el('label', { class: 'tabsearch-label', for: id, text: 'Search' }),
      input,
      // Plain text is the default and regex is the explicit opt-in, on every
      // one of the four. Anchored beside its own field rather than behind a
      // menu, so it belongs to the box being typed in.
      el('div', { class: 'tabsearch-regex-row' }, [
        regexToggle,
        el('label', {
          class: 'tabsearch-label',
          for: id + '-regex',
          text: 'Regular expression',
        }),
        el('label', { class: 'tabsearch-label', for: id + '-flags', text: 'Flags' }),
        flagsInput,
      ]),
      error,
      count,
      results,
    ]);
  }

  private buildBulk(): HTMLElement {
    const text = el('input', {
      class: 'tabsearch-input',
      type: 'search',
      id: 'tabsearch-bulk-text',
      placeholder: 'Text to match',
    }) as HTMLInputElement;

    const invert = el('input', {
      class: 'tabsearch-regex',
      type: 'checkbox',
      id: 'tabsearch-bulk-invert',
    }) as HTMLInputElement;

    const includePinned = el('input', {
      class: 'tabsearch-regex',
      type: 'checkbox',
      id: 'tabsearch-bulk-pinned',
    }) as HTMLInputElement;

    const preview = el('button', {
      class: 'tabsearch-action',
      type: 'button',
      text: 'Show what would close',
    }) as HTMLButtonElement;

    const update = (): void => {
      const query = text.value;
      // Refused on an empty query. "Close every tab not containing nothing"
      // closes everything, which is never what somebody meant to ask for.
      if (query.trim() === '') {
        this.closePreview.hidden = false;
        this.closePreview.textContent =
          'Type some text first. An empty match would close every tab, which is not something ' +
          'this will do by accident.';
        return;
      }

      const current = this.options.current();
      const plan = planClose(current.tabs, current.state, plainMatcher(query), {
        invert: invert.checked,
        includePinned: includePinned.checked,
      });

      this.closePreview.hidden = false;
      clear(this.closePreview);
      this.closePreview.append(
        el('p', {
          class: 'tabsearch-preview-count',
          text:
            plan.closing.length +
            (plan.closing.length === 1 ? ' tab would close' : ' tabs would close') +
            (plan.kept.length === 0
              ? '.'
              : ', and ' + plan.kept.length + ' would be kept because they are pinned.'),
        }),
        el(
          'ul',
          { class: 'tabsearch-preview-list', role: 'list' },
          plan.closing.map((id) =>
            el('li', { class: 'tabsearch-preview-item', role: 'listitem', text: id }),
          ),
        ),
        // Named with the reason rather than silently skipped: a bulk action
        // that quietly drops items is indistinguishable from one that failed.
        ...plan.kept.map((kept) =>
          el('p', {
            class: 'tabsearch-preview-kept',
            text: 'Kept: ' + kept.id + ' (' + kept.reason + ')',
          }),
        ),
      );
    };

    preview.addEventListener('click', update);

    return el('div', { class: 'tabsearch-bulk-row' }, [
      el('label', { class: 'tabsearch-label', for: 'tabsearch-bulk-text', text: 'Matching' }),
      text,
      invert,
      el('label', {
        class: 'tabsearch-label',
        for: 'tabsearch-bulk-invert',
        text: 'Close the ones that do NOT match',
      }),
      includePinned,
      el('label', {
        class: 'tabsearch-label',
        for: 'tabsearch-bulk-pinned',
        text: 'Include pinned tabs',
      }),
      preview,
    ]);
  }

  private syncGroupOptions(): void {
    const field = this.fields.find((entry) => entry.kind === 'group');
    const select = field?.groupSelect;
    if (select === undefined) return;

    const chosen = select.value;
    const groups = this.options.current().state.groups;
    clear(select);
    if (groups.length === 0) {
      select.append(el('option', { value: '', text: 'No groups yet' }));
      return;
    }
    for (const group of groups) {
      select.append(el('option', { value: group.id, text: group.name }));
    }
    // The choice survives a refresh when the group still exists.
    if (groups.some((group) => group.id === chosen)) select.value = chosen;
  }

  private matcherFor(field: Field): { match: ReturnType<typeof plainMatcher>; error: string | null } {
    if (!field.regexToggle.checked) {
      return { match: plainMatcher(field.input.value), error: null };
    }
    const pattern = field.input.value;
    if (pattern.trim() === '') return { match: plainMatcher(''), error: null };
    try {
      new RegExp(pattern, field.flagsInput.value);
    } catch (error) {
      return {
        match: () => false,
        error: 'That is not a usable pattern: ' + (error as Error).message,
      };
    }
    return { match: regexMatcher(pattern, field.flagsInput.value), error: null };
  }

  private run(field: Field): void {
    const { match, error } = this.matcherFor(field);
    field.flagsInput.disabled = !field.regexToggle.checked;

    field.error.hidden = error === null;
    field.error.textContent = error ?? '';

    const current = this.options.current();
    clear(field.results);

    if (field.kind === 'groups') {
      const found = searchGroups(current.state, match);
      field.count.textContent = describeCount(found.length, 'group');
      for (const group of found) field.results.append(this.groupRow(group));
      return;
    }

    let found: SearchResult[];
    switch (field.kind) {
      case 'strip':
        found = searchStrip(current.tabs, current.state, current.active, match);
        break;
      case 'group': {
        const groupId = field.groupSelect?.value ?? '';
        found = groupId === '' ? [] : searchGroup(current.tabs, current.state, current.active, groupId, match);
        break;
      }
      case 'everything':
        found = searchEverything(this.options.windows(), match);
        break;
    }

    field.count.textContent = describeCount(found.length, 'tab');
    for (const result of found) field.results.append(this.resultRow(result));
  }

  private resultRow(result: SearchResult): HTMLElement {
    const button = el('button', {
      class: 'tabsearch-result',
      type: 'button',
    }) as HTMLButtonElement;

    // Every result says WHERE it is: which window, which group, whether it is
    // pinned, and whether it is currently hidden inside a collapsed group.
    // A bare label leaves somebody with three identical rows and no way to
    // tell which is which.
    // `append` refuses null, unlike the `el` helper's children, so the optional
    // parts are filtered rather than passed through as holes.
    const parts: (HTMLElement | null)[] = [
      el('span', { class: 'tabsearch-result-label', text: result.tab.label }),
      el('span', { class: 'tabsearch-result-where', text: result.window }),
      result.group === null
        ? null
        : el('span', { class: 'tabsearch-result-group', text: result.group.name }),
      result.pinned ? el('span', { class: 'tabsearch-result-flag', text: 'pinned' }) : null,
      result.hidden
        ? el('span', { class: 'tabsearch-result-flag', text: 'in a collapsed group' })
        : null,
    ];
    for (const part of parts) {
      if (part !== null) button.append(part);
    }

    button.addEventListener('click', () => {
      // Revealing a result inside a collapsed group must NOT expand it
      // permanently: the user collapsed it deliberately, and quietly undoing
      // that is a preference silently overwritten.
      this.options.onReveal?.(result.tab.id, result.window);
    });

    return el('li', { class: 'tabsearch-result-item', role: 'listitem' }, [button]);
  }

  private groupRow(group: TabGroupRecord): HTMLElement {
    return el('li', { class: 'tabsearch-result-item', role: 'listitem' }, [
      el('span', { class: 'tabsearch-result-label', text: group.name }),
      el('span', {
        class: 'tabsearch-result-where',
        text: describeCount(group.members.length, 'tab'),
      }),
    ]);
  }
}

/** Honest counts, including the empty one, which is never a blank surface. */
function describeCount(count: number, noun: string): string {
  if (count === 0) return 'Nothing matches.';
  return count + ' ' + noun + (count === 1 ? '' : 's') + '.';
}
