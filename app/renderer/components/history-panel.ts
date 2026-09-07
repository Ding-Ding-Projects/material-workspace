/**
 * Document history.
 *
 * The autosave layer has been committing to a local Git repository since the
 * beginning; until now there was no way to look at it. A history nobody can
 * browse is a backup nobody has ever opened, which is a file rather than a
 * backup.
 *
 * Two rules shape the whole surface:
 *
 *   - RESTORING IS A NEW COMMIT, never a rewrite. An undo can itself be undone,
 *     and undone again. A destructive restore that discarded the branch it
 *     replaced would make the panel unsafe to experiment in, which is the one
 *     thing it has to be.
 *   - A HISTORY NOBODY CAN SEARCH IS AN ARCHIVE NOBODY OPENS. So: a date range
 *     typed or picked, an action filter built from the actions genuinely
 *     recorded rather than a hard-coded list that drifts, and a text search
 *     with its own anchored regular-expression builder.
 */

import type { HistoryAction, HistoryEntry, HistoryHealth } from '../../shared/ipc.js';
import { clear, el } from '../dom.js';
import { plainMatcher, regexMatcher } from '../tabs/model.js';
import {
  EMPTY as NO_SELECTION,
  type Selection,
  choose,
  clear as clearSelection,
  describePlan,
  describeSelectAll,
  extend,
  invert,
  plan,
  selectAll,
  toggle,
} from '../../shared/bulk.js';

export interface HistoryPanelOptions {
  /**
   * The engine's own reply shape, not a bare array.
   *
   * It returns the entries AND the set of actions it has genuinely observed
   * across the whole history. Recomputing that set here from the loaded page
   * would build a second authority that disagrees the moment a date range
   * hides an action - the filter would silently lose a checkbox for something
   * that exists.
   */
  readonly list: (query: {
    limit?: number;
    since?: string;
    until?: string;
    actions?: HistoryAction[];
  }) => Promise<{
    entries: HistoryEntry[];
    observedActions: { action: HistoryAction; count: number }[];
  }>;
  readonly diff: (commit: string) => Promise<string>;
  readonly restore: (commit: string) => Promise<unknown>;
  readonly label: (commit: string, label: string) => Promise<unknown>;
  readonly health: () => Promise<HistoryHealth>;
  readonly onExport?: () => void;
}

/** What each action is called, and what it means. */
const ACTION_LABELS: Record<HistoryAction, string> = {
  created: 'Created',
  autosaved: 'Autosaved',
  updated: 'Updated',
  renamed: 'Renamed',
  deleted: 'Deleted',
  restored: 'Restored',
  discarded: 'Discarded',
  imported: 'Imported',
  'settings-changed': 'Settings changed',
  'label-added': 'Labelled',
};

export class HistoryPanel {
  readonly element: HTMLElement;

  private entries: HistoryEntry[] = [];
  private selected: string | null = null;

  private readonly statusRow: HTMLElement;
  private readonly since: HTMLInputElement;
  private readonly until: HTMLInputElement;
  private readonly typedSince: HTMLInputElement;
  private readonly dateError: HTMLElement;
  private readonly actionRow: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly regexToggle: HTMLInputElement;
  private readonly flags: HTMLInputElement;
  private readonly searchError: HTMLElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private readonly diffView: HTMLElement;

  private selection: Selection = NO_SELECTION;
  private readonly bulkBar: HTMLElement;
  private readonly bulkSummary: HTMLElement;

  private chosenActions = new Set<HistoryAction>();
  /** What the engine has observed across the WHOLE history, not this page. */
  private observed: { action: HistoryAction; count: number }[] = [];

  constructor(private readonly options: HistoryPanelOptions) {
    this.statusRow = el('p', { class: 'history-status', role: 'status' });

    this.since = el('input', {
      class: 'history-input',
      type: 'date',
      id: 'history-since',
    }) as HTMLInputElement;
    this.until = el('input', {
      class: 'history-input',
      type: 'date',
      id: 'history-until',
    }) as HTMLInputElement;

    // Typed as well as picked. A native date control is the accessible,
    // localised way in; a plain ISO box is how somebody who knows the date
    // types it without three clicks, and both are offered because neither
    // suits everybody.
    this.typedSince = el('input', {
      class: 'history-input',
      type: 'text',
      id: 'history-typed',
      placeholder: 'or type 2026-09-01',
      spellcheck: 'false',
    }) as HTMLInputElement;
    this.dateError = el('p', { class: 'history-error', role: 'alert', hidden: true });

    for (const control of [this.since, this.until]) {
      control.addEventListener('change', () => void this.reload());
    }
    this.typedSince.addEventListener('change', () => this.onTypedDate());

    this.actionRow = el('div', { class: 'history-actions', role: 'group', 'aria-label': 'Filter by action' });

    this.search = el('input', {
      class: 'history-input',
      type: 'search',
      id: 'history-search',
      placeholder: 'Filter what is listed',
    }) as HTMLInputElement;
    this.regexToggle = el('input', {
      class: 'history-check',
      type: 'checkbox',
      id: 'history-regex',
    }) as HTMLInputElement;
    this.flags = el('input', {
      class: 'history-input history-flags',
      type: 'text',
      id: 'history-flags',
      value: 'i',
      'aria-label': 'Regular expression flags',
    }) as HTMLInputElement;
    this.searchError = el('p', { class: 'history-error', role: 'alert', hidden: true });

    for (const control of [this.search, this.regexToggle, this.flags]) {
      control.addEventListener('input', () => this.render());
      control.addEventListener('change', () => this.render());
    }

    this.list = el('ul', { class: 'history-list', role: 'list' });
    this.count = el('p', { class: 'history-count', role: 'status' });
    this.diffView = el('pre', { class: 'history-diff', tabindex: '0' });

    this.bulkBar = el('div', { class: 'history-bulk', role: 'group', 'aria-label': 'Bulk actions' });
    this.bulkSummary = el('p', { class: 'history-bulk-summary', role: 'status' });

    const exportButton = el('button', {
      class: 'history-action',
      type: 'button',
      text: 'Export the history',
    }) as HTMLButtonElement;
    exportButton.addEventListener('click', () => this.options.onExport?.());

    this.element = el('section', { class: 'history', 'aria-label': 'Document history' }, [
      el('header', { class: 'history-header' }, [
        el('h2', { class: 'history-title', text: 'History' }),
        el('p', {
          class: 'history-lede',
          text:
            'Every change, kept locally. Restoring writes a NEW entry rather than rewriting, ' +
            'so an undo can itself be undone.',
        }),
      ]),

      this.statusRow,

      el('div', { class: 'history-filters' }, [
        el('label', { class: 'history-label', for: 'history-since', text: 'From' }),
        this.since,
        el('label', { class: 'history-label', for: 'history-until', text: 'To' }),
        this.until,
        el('label', { class: 'history-label', for: 'history-typed', text: 'Or type a date' }),
        this.typedSince,
        this.dateError,

        el('label', { class: 'history-label', for: 'history-search', text: 'Containing' }),
        this.search,
        el('div', { class: 'history-regex-row' }, [
          this.regexToggle,
          el('label', { class: 'history-label', for: 'history-regex', text: 'Regular expression' }),
          el('label', { class: 'history-label', for: 'history-flags', text: 'Flags' }),
          this.flags,
        ]),
        this.searchError,

        el('span', { class: 'history-label', text: 'Actions' }),
        this.actionRow,
      ]),

      this.count,
      this.bulkBar,
      this.bulkSummary,
      el('div', { class: 'history-body' }, [this.list, this.diffView]),
      exportButton,
    ]);

    void this.reload();
  }

  /** The entries currently loaded, for tests. */
  loaded(): readonly HistoryEntry[] {
    return this.entries;
  }

  private onTypedDate(): void {
    const text = this.typedSince.value.trim();
    if (text === '') {
      this.dateError.hidden = true;
      void this.reload();
      return;
    }

    // Accepts the locale's own format through the native control and plain ISO
    // here. Invalid input is reported WITHOUT discarding what was typed:
    // clearing somebody's half-finished date to punish a typo is how a field
    // becomes infuriating.
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00') : null;
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      this.dateError.hidden = false;
      this.dateError.textContent =
        'That is not a date this can read. Try 2026-09-01, or use the picker above.';
      return;
    }

    this.dateError.hidden = true;
    this.since.value = text;
    void this.reload();
  }

  private async reload(): Promise<void> {
    const health = await this.options.health().catch(() => null);

    if (health === null || !health.available) {
      // A broken history reads as a DIAGNOSIS rather than as an empty archive.
      // An empty list here would tell somebody their work was never saved,
      // which is both alarming and untrue.
      this.statusRow.dataset['state'] = 'unavailable';
      this.statusRow.textContent =
        health === null
          ? 'The history could not be reached, so nothing can be listed. This does not mean ' +
            'nothing was saved.'
          : 'History is unavailable: ' + (health.reason ?? 'no reason was given') +
            '. This does not mean nothing was saved.';
      this.entries = [];
      this.render();
      return;
    }

    this.statusRow.dataset['state'] = 'ok';
    const recorded = health.commitCount ?? 0;
    this.statusRow.textContent =
      recorded + (recorded === 1 ? ' entry' : ' entries') + ' recorded in ' + health.repositoryPath;

    const query: { limit: number; since?: string; until?: string } = { limit: 500 };
    if (this.since.value !== '') query.since = this.since.value;
    if (this.until.value !== '') query.until = this.until.value;

    const reply = await this.options
      .list(query)
      .catch(() => ({ entries: [], observedActions: [] }));
    this.entries = reply.entries ?? [];
    this.observed = reply.observedActions ?? [];
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
      // Matches nothing rather than everything. Falling back to everything
      // while somebody is halfway through typing `(` shows the whole archive
      // and reads as the filter being broken.
      return { test: () => false, error: 'Not a usable pattern: ' + (error as Error).message };
    }
    return { test: regexMatcher(pattern, this.flags.value), error: null };
  }

  private render(): void {
    this.flags.disabled = !this.regexToggle.checked;

    // ---- the action filter, built from the actions REALLY recorded ----
    //
    // A hard-coded list drifts from what the application actually writes: it
    // grows a checkbox nobody can ever tick, and misses one that would have
    // been useful. Counts are shown so an empty action is visibly empty rather
    // than mysteriously absent.
    // Counted in the CURRENT view, listed from what the engine has observed
    // across the whole history. An action that exists but is outside the date
    // range still gets a checkbox, reading "(0 here)" - because losing the
    // checkbox would hide the fact that the action exists at all, and somebody
    // widening the range would never think to look for it.
    const here = new Map<HistoryAction, number>();
    for (const entry of this.entries) {
      here.set(entry.action, (here.get(entry.action) ?? 0) + 1);
    }

    clear(this.actionRow);
    if (this.observed.length === 0) {
      this.actionRow.append(
        el('span', { class: 'history-empty', text: 'No actions to filter by yet.' }),
      );
    }
    for (const { action } of this.observed) {
      const count = here.get(action) ?? 0;
      const id = 'history-action-' + action;
      const box = el('input', {
        class: 'history-check',
        type: 'checkbox',
        id,
      }) as HTMLInputElement;
      box.checked = this.chosenActions.has(action);
      box.addEventListener('change', () => {
        if (box.checked) this.chosenActions.add(action);
        else this.chosenActions.delete(action);
        this.render();
      });
      this.actionRow.append(
        el('span', { class: 'history-action-chip', 'data-empty': count === 0 ? 'yes' : 'no' }, [
          box,
          el('label', {
            class: 'history-label',
            for: id,
            text: ACTION_LABELS[action] + ' (' + count + ' here)',
          }),
        ]),
      );
    }

    // ---- filtering ----
    const { test, error } = this.matcher();
    this.searchError.hidden = error === null;
    this.searchError.textContent = error ?? '';

    const shown = this.entries.filter((entry) => {
      // Every filter COMPOSES rather than overriding. An action filter that
      // silently ignored the date range, or a search that reset it, would make
      // the result set unexplainable.
      if (this.chosenActions.size > 0 && !this.chosenActions.has(entry.action)) return false;
      return test(entry.subject + ' ' + (entry.label ?? '') + ' ' + (entry.documentId ?? ''));
    });

    this.count.textContent =
      shown.length === 0
        ? 'Nothing matches those filters.'
        : shown.length +
          ' of ' +
          this.entries.length +
          (this.entries.length === 1 ? ' entry.' : ' entries.');

    this.renderBulk(shown);

    clear(this.list);
    for (const entry of shown) {
      const open = el('button', {
        class: 'history-entry',
        type: 'button',
        'aria-label': ACTION_LABELS[entry.action] + ' at ' + entry.at + ': ' + entry.subject,
      }) as HTMLButtonElement;
      open.append(
        el('span', { class: 'history-entry-action', text: ACTION_LABELS[entry.action] }),
        el('span', { class: 'history-entry-subject', text: entry.subject }),
        el('span', { class: 'history-entry-at', text: entry.at }),
        el('span', { class: 'history-entry-commit', text: entry.shortCommit }),
      );
      if (entry.label !== null && entry.label !== '') {
        open.append(el('span', { class: 'history-entry-label', text: entry.label }));
      }
      open.addEventListener('click', (event) => {
        // Click selects and opens; control-click adds to the selection;
        // shift-click takes the range. All three are the conventions a list
        // already teaches somebody everywhere else, so none of them needs
        // explaining here.
        const order = shown.map((candidate) => candidate.commit);
        if (event.shiftKey) this.selection = extend(this.selection, entry.commit, order);
        else if (event.ctrlKey || event.metaKey) this.selection = toggle(this.selection, entry.commit);
        else {
          this.selection = choose(entry.commit);
          void this.show(entry.commit);
        }
        this.render();
      });
      // The keyboard equivalent, because a selection that needs a modifier and
      // a pointer is a selection somebody who uses neither cannot make.
      open.addEventListener('keydown', (event) => {
        if (event.key !== ' ') return;
        event.preventDefault();
        this.selection = toggle(this.selection, entry.commit);
        this.render();
      });
      open.setAttribute('aria-pressed', String(this.selection.chosen.has(entry.commit)));
      if (this.selection.chosen.has(entry.commit)) open.dataset['selected'] = 'yes';

      const restore = el('button', {
        class: 'history-restore',
        type: 'button',
        text: 'Restore',
        'aria-label': 'Restore the state at ' + entry.shortCommit,
      }) as HTMLButtonElement;
      restore.addEventListener('click', () => void this.restore(entry));

      this.list.append(
        el('li', { class: 'history-item', role: 'listitem' }, [open, restore]),
      );
    }
  }

  /**
   * The bulk toolbar.
   *
   * Rebuilt from the current filter rather than remembered, because a
   * select-all over a filtered list means something different from one over
   * the whole history, and the button has to say which.
   */
  private renderBulk(shown: readonly HistoryEntry[]): void {
    clear(this.bulkBar);

    const order = shown.map((entry) => entry.commit);

    const all = el('button', { class: 'history-restore', type: 'button' }) as HTMLButtonElement;
    all.textContent = describeSelectAll('everything', shown.length, this.entries.length);
    all.addEventListener('click', () => {
      this.selection = selectAll(order);
      this.render();
    });

    const flip = el('button', {
      class: 'history-restore',
      type: 'button',
      text: 'Invert selection',
    }) as HTMLButtonElement;
    flip.addEventListener('click', () => {
      this.selection = invert(this.selection, order);
      this.render();
    });

    const none = el('button', {
      class: 'history-restore',
      type: 'button',
      text: 'Clear selection',
    }) as HTMLButtonElement;
    none.addEventListener('click', () => {
      this.selection = clearSelection();
      this.render();
    });

    const exportSelected = el('button', {
      class: 'history-restore',
      type: 'button',
      text: 'Export selected',
    }) as HTMLButtonElement;
    exportSelected.disabled = this.selection.chosen.size === 0;
    exportSelected.addEventListener('click', () => this.options.onExport?.());

    this.bulkBar.append(all, flip, none, exportSelected);

    // The plan is computed even when nothing is selected, so the sentence
    // beneath is always the truth about what a press would do rather than a
    // label that appears only once something is chosen.
    const items = shown.map((entry) => ({ id: entry.commit, entry }));
    const outcome = plan(items, this.selection);
    this.bulkSummary.textContent = describePlan(outcome, 'exported');
  }

  private async show(commit: string): Promise<void> {
    this.selected = commit;
    this.diffView.textContent = 'Loading ' + commit.slice(0, 7) + '...';
    try {
      const diff = await this.options.diff(commit);
      if (this.selected !== commit) return;
      this.diffView.textContent = diff === '' ? 'That entry changed nothing.' : diff;
    } catch (error) {
      this.diffView.textContent =
        'That entry could not be read: ' + ((error as Error).message ?? 'no reason given');
    }
  }

  private async restore(entry: HistoryEntry): Promise<void> {
    // Deliberately NOT behind the destructive gate: restoring writes a new
    // entry rather than rewriting, so it destroys nothing and can itself be
    // undone. Gating a reversible action trains people to click through gates,
    // which is exactly what makes the real ones stop working.
    try {
      await this.options.restore(entry.commit);
      await this.reload();
      this.diffView.textContent =
        'Restored the state at ' + entry.shortCommit +
        '. That restore is itself a new entry in this list, so it can be undone.';
    } catch (error) {
      this.diffView.textContent =
        'That restore did not happen: ' + ((error as Error).message ?? 'no reason given');
    }
  }
}
