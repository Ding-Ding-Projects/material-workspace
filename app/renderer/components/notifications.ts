/**
 * Notifications, and the centre that keeps them reviewable.
 *
 * Anything that only INFORMS is a non-blocking toast in a corner. A modal dialog
 * is reserved for a decision that genuinely must be made before continuing —
 * confirmations, unsaved-changes prompts, destructive gates, credential steps.
 * Everything else gets out of the way.
 *
 * Two rules that decide the shape of this file:
 *
 *   - An error or warning does NOT auto-dismiss. A message that disappears
 *     before it is read is a message that was never delivered, and the ones most
 *     likely to be missed are the ones that mattered.
 *   - Dismissed is not deleted. The centre keeps everything, because "it flashed
 *     up and I did not catch it" is the single most common complaint about
 *     toasts anywhere.
 */

import { clear, el } from '../dom.js';
import { SearchField, type SearchPredicate } from './search-field.js';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error' | 'progress';

export interface NotificationAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface NotificationInput {
  title: string;
  body?: string;
  severity?: NotificationSeverity;
  actions?: NotificationAction[];
  /** Overrides the default for its severity. Ignored for warning and error,
   *  which never auto-dismiss. */
  timeoutMs?: number;
  /** Replaces an existing notification with the same key rather than stacking a
   *  second copy. Progress updates use this. */
  key?: string;
}

export interface NotificationRecord extends NotificationInput {
  id: string;
  severity: NotificationSeverity;
  at: string;
  dismissed: boolean;
}

const DEFAULT_TIMEOUT: Record<NotificationSeverity, number | null> = {
  info: 6000,
  success: 4000,
  progress: null, // dismissed by whoever is reporting progress
  warning: null, // never: an unread warning is an undelivered warning
  error: null,
};

const MAX_RETAINED = 500;

export class Notifications {
  private readonly records: NotificationRecord[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  readonly host: HTMLElement;

  constructor() {
    this.host = el('div', {
      class: 'toasts',
      // Polite, not assertive: a toast must not interrupt a screen reader
      // mid-sentence. Errors are announced through their own alert role below.
      'aria-live': 'polite',
      'aria-relevant': 'additions',
      'aria-label': 'Notifications',
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  push(input: NotificationInput): string {
    const severity = input.severity ?? 'info';

    // A keyed notification REPLACES rather than stacks. Without this, a progress
    // report becomes forty toasts.
    if (input.key) {
      const existing = this.records.find(
        (record) => record.key === input.key && !record.dismissed,
      );
      if (existing) {
        Object.assign(existing, input, { severity, at: new Date().toISOString() });
        this.render();
        this.notify();
        return existing.id;
      }
    }

    const record: NotificationRecord = {
      ...input,
      id: 'n' + this.nextId++,
      severity,
      at: new Date().toISOString(),
      dismissed: false,
    };
    this.records.unshift(record);

    // Bounded retention, so a long session cannot grow without limit. The oldest
    // DISMISSED entries go first; nothing still on screen is discarded.
    while (this.records.length > MAX_RETAINED) {
      const index = this.records.map((r) => r.dismissed).lastIndexOf(true);
      if (index === -1) break;
      this.records.splice(index, 1);
    }

    // Severity WINS over an explicit timeout for warning and error.
    //
    // Written the other way round first, as `input.timeoutMs ?? DEFAULT`,
    // which honoured a caller-supplied timeout on an error and quietly
    // contradicted the comment two lines above it. A caller asking for a
    // five-second error toast is asking for a message that vanishes before
    // it is read; the severity decides, not the caller.
    const neverDismisses = severity === 'warning' || severity === 'error';
    const timeout = neverDismisses ? null : input.timeoutMs ?? DEFAULT_TIMEOUT[severity];
    if (timeout !== null && timeout !== undefined) {
      this.timers.set(
        record.id,
        setTimeout(() => this.dismiss(record.id), timeout),
      );
    }

    this.render();
    this.notify();
    return record.id;
  }

  dismiss(id: string): void {
    const record = this.records.find((entry) => entry.id === id);
    if (!record || record.dismissed) return;
    record.dismissed = true;
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.render();
    this.notify();
  }

  /** Dismiss several at once. Reports how many actually changed, because a
   *  count of what was SELECTED is not a count of what happened. */
  dismissMany(ids: string[]): { dismissed: number; alreadyDismissed: number } {
    let dismissed = 0;
    let alreadyDismissed = 0;
    for (const id of ids) {
      const record = this.records.find((entry) => entry.id === id);
      if (!record) continue;
      if (record.dismissed) {
        alreadyDismissed += 1;
        continue;
      }
      this.dismiss(id);
      dismissed += 1;
    }
    return { dismissed, alreadyDismissed };
  }

  /** Release every pending timer. A host that is going away must call this,
   *  or the timers keep the process alive long after the window has gone. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  all(): NotificationRecord[] {
    return [...this.records];
  }

  visible(): NotificationRecord[] {
    return this.records.filter((record) => !record.dismissed);
  }

  /** Render the on-screen stack. The centre renders separately. */
  private render(): void {
    clear(this.host);
    // Newest at the bottom of the stack, nearest the corner, so a burst does not
    // shove the one being read upward out of the eye's path.
    for (const record of this.visible().slice(0, 5).reverse()) {
      this.host.append(this.renderToast(record));
    }
  }

  private renderToast(record: NotificationRecord): HTMLElement {
    const toast = el('div', {
      class: 'toast',
      'data-severity': record.severity,
      // An error is announced immediately; everything else waits its turn.
      role: record.severity === 'error' ? 'alert' : 'status',
    });

    toast.append(
      el('div', { class: 'toast__main' }, [
        el('p', { class: 'toast__title', text: record.title }),
        record.body ? el('p', { class: 'toast__body', text: record.body }) : null,
      ]),
    );

    if (record.actions && record.actions.length > 0) {
      const actions = el('div', { class: 'toast__actions' });
      for (const action of record.actions) {
        const button = el('button', { class: 'toast__action', type: 'button' });
        button.textContent = action.label;
        button.addEventListener('click', () => {
          void action.run();
          this.dismiss(record.id);
        });
        actions.append(button);
      }
      toast.append(actions);
    }

    const dismiss = el('button', {
      class: 'toast__dismiss',
      type: 'button',
      'aria-label': 'Dismiss: ' + record.title,
    });
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => this.dismiss(record.id));
    toast.append(dismiss);

    return toast;
  }
}

/**
 * The notification centre.
 *
 * A list, and therefore it carries everything every other list here carries: a
 * search field with its own anchored regular-expression builder, multi-select
 * with a keyboard equivalent, an honestly-scoped select-all, inverse selection,
 * and bulk actions. "It is just a log" is not an exemption — a log is exactly
 * the surface where somebody needs to select forty things and act on them.
 */
export class NotificationCentre {
  readonly element: HTMLElement;

  private readonly notifications: Notifications;
  private readonly selected = new Set<string>();
  private predicate: SearchPredicate | null = null;
  /**
   * What the last bulk action actually did.
   *
   * Held here rather than written straight into the summary, because the
   * handler that performs the action also triggers a re-render — so writing
   * the outcome directly meant announcing it and erasing it in the same tick.
   * The result of an action a user just took is exactly the thing that must
   * survive the redraw.
   */
  private lastOutcome: string | null = null;
  private listHost: HTMLElement;
  private summaryHost: HTMLElement;
  private toolbarHost: HTMLElement;

  constructor(notifications: Notifications) {
    this.notifications = notifications;

    const search = new SearchField({
      id: 'notification-search',
      label: 'Search notifications',
      placeholder: 'Search notifications',
      onChange: (predicate) => {
        this.predicate = predicate;
        this.render();
      },
    });

    this.listHost = el('div', {
      class: 'centre__list',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': 'Notifications',
    });
    this.summaryHost = el('p', { class: 'centre__summary', role: 'status', 'aria-live': 'polite' });
    this.toolbarHost = el('div', { class: 'centre__toolbar' });

    this.element = el('section', { class: 'centre' }, [
      el('h2', { class: 'card__title', text: 'Notifications' }),
      search.element,
      this.toolbarHost,
      this.summaryHost,
      this.listHost,
    ]);

    notifications.onChange(() => this.render());
    this.render();
  }

  private matching(): NotificationRecord[] {
    const all = this.notifications.all();
    const predicate = this.predicate;
    if (!predicate || predicate.empty) return all;
    if (!predicate.test) return [];
    const test = predicate.test;
    return all.filter((record) => test(record.title + ' ' + (record.body ?? '') + ' ' + record.severity));
  }

  private render(): void {
    const matching = this.matching();

    clear(this.toolbarHost);
    clear(this.listHost);

    if (this.predicate?.error) {
      this.summaryHost.textContent =
        'That pattern will not compile, so nothing was matched: ' + this.predicate.error;
      return;
    }

    // Select-all states plainly WHICH set it means. "Select all" that silently
    // means only the visible page is how people delete the wrong things.
    const filtered = !(this.predicate?.empty ?? true);
    const selectAll = el('button', { class: 'centre__bulk', type: 'button' });
    selectAll.textContent = filtered
      ? 'Select all ' + matching.length + ' matching'
      : 'Select all ' + matching.length;
    selectAll.addEventListener('click', () => {
      for (const record of matching) this.selected.add(record.id);
      this.render();
    });

    const invert = el('button', { class: 'centre__bulk', type: 'button' });
    invert.textContent = 'Invert selection';
    invert.addEventListener('click', () => {
      for (const record of matching) {
        if (this.selected.has(record.id)) this.selected.delete(record.id);
        else this.selected.add(record.id);
      }
      this.render();
    });

    const clearSelection = el('button', { class: 'centre__bulk', type: 'button' });
    clearSelection.textContent = 'Clear selection';
    clearSelection.addEventListener('click', () => {
      this.selected.clear();
      this.render();
    });

    const dismissSelected = el('button', {
      class: 'centre__bulk',
      type: 'button',
      disabled: this.selected.size === 0,
      // A disabled control names the condition that is unmet, rather than
      // reading as broken.
      title:
        this.selected.size === 0
          ? 'Select one or more notifications to dismiss them'
          : 'Dismiss the ' + this.selected.size + ' selected notifications',
    });
    dismissSelected.textContent = 'Dismiss selected';
    dismissSelected.addEventListener('click', () => {
      const outcome = this.notifications.dismissMany([...this.selected]);
      this.selected.clear();
      // Reports what HAPPENED, distinguished from what was selected.
      this.lastOutcome =
        outcome.dismissed +
        ' dismissed' +
        (outcome.alreadyDismissed > 0
          ? ', ' + outcome.alreadyDismissed + ' were already dismissed'
          : '') +
        '.';
      this.render();
    });

    const exportSelected = el('button', {
      class: 'centre__bulk',
      type: 'button',
      title: 'Copy what is currently listed, honouring the search above',
    });
    exportSelected.textContent = filtered ? 'Copy these ' + matching.length : 'Copy all';
    exportSelected.addEventListener('click', () => {
      // Honours the active filter rather than dumping the entire log.
      const text = matching
        .map(
          (record) =>
            record.at + '  [' + record.severity + '] ' + record.title +
            (record.body ? ' — ' + record.body : ''),
        )
        .join('\n');
      void navigator.clipboard?.writeText(text);
      this.lastOutcome = 'Copied ' + matching.length + ' notifications.';
      this.render();
    });

    this.toolbarHost.append(selectAll, invert, clearSelection, dismissSelected, exportSelected);

    if (this.lastOutcome) {
      this.summaryHost.textContent = this.lastOutcome;
      this.lastOutcome = null;
      for (const record of matching) this.listHost.append(this.renderRow(record));
      return;
    }

    if (matching.length === 0) {
      this.summaryHost.textContent = filtered
        ? 'No notification matches that search.'
        : 'Nothing has been reported yet.';
      return;
    }

    this.summaryHost.textContent =
      matching.length +
      (matching.length === 1 ? ' notification' : ' notifications') +
      (this.selected.size > 0 ? ', ' + this.selected.size + ' selected' : '');

    for (const record of matching) {
      this.listHost.append(this.renderRow(record));
    }
  }

  private renderRow(record: NotificationRecord): HTMLElement {
    const selected = this.selected.has(record.id);
    const row = el('div', {
      class: 'centre__row',
      role: 'option',
      'data-severity': record.severity,
      'data-dismissed': String(record.dismissed),
      'aria-selected': String(selected),
      tabindex: '0',
    });

    const toggle = (): void => {
      if (this.selected.has(record.id)) this.selected.delete(record.id);
      else this.selected.add(record.id);
      this.render();
    };

    row.addEventListener('click', toggle);
    // The keyboard equivalent, so selection is not pointer-only.
    row.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggle();
      }
    });

    row.append(
      // The severity is a WORD, not only a colour.
      el('span', { class: 'centre__severity', text: record.severity }),
      el('div', { class: 'centre__row-main' }, [
        el('span', { class: 'centre__row-title', text: record.title }),
        record.body ? el('span', { class: 'centre__row-body', text: record.body }) : null,
      ]),
      el('time', {
        class: 'centre__row-time',
        datetime: record.at,
        text: new Date(record.at).toLocaleTimeString(),
      }),
    );

    if (record.dismissed) {
      row.append(el('span', { class: 'centre__row-state', text: 'dismissed' }));
    }

    return row;
  }
}
