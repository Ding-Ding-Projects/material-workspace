/**
 * Multi-select and bulk actions, for any collection.
 *
 * Selecting one item and repeating an action forty times is the application
 * failing to do its job. So: click, shift-click for a range, a keyboard
 * equivalent for both, a select-all that says plainly whether it means THIS
 * PAGE or EVERY MATCH, and an inverse.
 *
 * THE RULE THAT MATTERS: a bulk action says what will happen before it happens,
 * and never silently skips anything. "42 selected" and "42 will change" are
 * different numbers whenever something is protected, and an action that
 * quietly drops the difference is indistinguishable from one that failed.
 */

export type Scope = 'page' | 'everything';

export interface Selection {
  /** The ids explicitly chosen. */
  readonly chosen: ReadonlySet<string>;
  /**
   * The last item touched, for a shift-click range.
   *
   * Null after a select-all or an inverse, because there is no meaningful
   * anchor: extending a range from "everything" would select a span nobody
   * pointed at.
   */
  readonly anchor: string | null;
}

export const EMPTY: Selection = { chosen: new Set(), anchor: null };

export function isChosen(selection: Selection, id: string): boolean {
  return selection.chosen.has(id);
}

export function count(selection: Selection): number {
  return selection.chosen.size;
}

/** A plain click: this one, and nothing else. */
export function choose(id: string): Selection {
  return { chosen: new Set([id]), anchor: id };
}

/** Control-click: add or remove one, keeping the rest. */
export function toggle(selection: Selection, id: string): Selection {
  const chosen = new Set(selection.chosen);
  if (chosen.has(id)) chosen.delete(id);
  else chosen.add(id);
  return { chosen, anchor: id };
}

/**
 * Shift-click: everything between the anchor and here.
 *
 * With no anchor it behaves as a plain click rather than doing nothing.
 * Silently ignoring a shift-click is the version people report as "the
 * selection is broken", because from the outside it is indistinguishable from
 * a click that missed.
 */
export function extend(
  selection: Selection,
  id: string,
  order: readonly string[],
): Selection {
  if (selection.anchor === null) return choose(id);

  const from = order.indexOf(selection.anchor);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return choose(id);

  const [low, high] = from <= to ? [from, to] : [to, from];
  const chosen = new Set(selection.chosen);
  for (const entry of order.slice(low, high + 1)) chosen.add(entry);

  // The anchor STAYS where it was, so dragging a shift-click back and forth
  // grows and shrinks one range rather than leaving a trail of them.
  return { chosen, anchor: selection.anchor };
}

export function selectAll(order: readonly string[]): Selection {
  return { chosen: new Set(order), anchor: null };
}

export function clear(): Selection {
  return EMPTY;
}

/** Everything currently NOT chosen. */
export function invert(selection: Selection, order: readonly string[]): Selection {
  const chosen = new Set(order.filter((id) => !selection.chosen.has(id)));
  return { chosen, anchor: null };
}

/**
 * What a select-all actually covers.
 *
 * Stated in words rather than left to be inferred. "Select all" over a
 * filtered list of 20 out of 4000 means one of two completely different
 * things, and the one somebody assumed is the one that ruins their afternoon.
 */
export function describeSelectAll(scope: Scope, onPage: number, total: number): string {
  if (scope === 'page' || onPage === total) {
    return 'Select all ' + onPage + (onPage === 1 ? ' item shown' : ' items shown');
  }
  return (
    'Select all ' + onPage + ' shown, or all ' + total + ' that match — these are different'
  );
}

// -------------------------------------------------------------- planning --

export interface Protection {
  readonly id: string;
  /** Why it will not be acted on. Shown beside it, never swallowed. */
  readonly reason: string;
}

export interface Plan<T> {
  readonly acting: readonly T[];
  readonly kept: readonly Protection[];
  /** True when the action cannot be undone and needs the two-key gate. */
  readonly irreversible: boolean;
}

/**
 * Work out what a bulk action would do, WITHOUT doing it.
 *
 * A preview that is computed by a different rule from the action is a preview
 * that eventually lies, so the action is expected to run over `plan.acting`
 * rather than recomputing the set itself.
 */
export function plan<T extends { id: string }>(
  items: readonly T[],
  selection: Selection,
  options: {
    readonly protect?: (item: T) => string | null;
    readonly irreversible?: boolean;
  } = {},
): Plan<T> {
  const acting: T[] = [];
  const kept: Protection[] = [];

  for (const item of items) {
    if (!selection.chosen.has(item.id)) continue;
    const reason = options.protect?.(item) ?? null;
    if (reason === null) acting.push(item);
    // Named with the reason rather than filtered out. A bulk action that
    // silently skips items is indistinguishable from one that failed.
    else kept.push({ id: item.id, reason });
  }

  return { acting, kept, irreversible: options.irreversible === true };
}

/**
 * The sentence shown before a bulk action runs.
 *
 * Says the counts SEPARATELY. "42 selected" and "42 will change" are different
 * numbers whenever anything is protected, and collapsing them is how somebody
 * discovers afterwards that six were skipped.
 */
export function describePlan<T>(plan: Plan<T>, verb: string): string {
  const acting = plan.acting.length;
  const kept = plan.kept.length;

  if (acting === 0 && kept === 0) return 'Nothing is selected.';
  if (acting === 0) {
    return 'Nothing will be ' + verb + ': all ' + kept + ' selected are protected.';
  }

  const head = acting + (acting === 1 ? ' item will be ' : ' items will be ') + verb;
  if (kept === 0) return head + '.';
  return head + ', and ' + kept + (kept === 1 ? ' is kept' : ' are kept') + ' — listed below.';
}
