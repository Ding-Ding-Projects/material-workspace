/**
 * The tab strip's arithmetic, kept away from the DOM.
 *
 * Ordering, pinning, grouping, overflow and the four searches are all decisions
 * about lists, and every one of them has an edge case that is invisible on
 * screen until somebody hits it: a pinned tab inside a collapsed group, a
 * group whose last member was moved out, a search that reveals a result inside
 * a group the user deliberately collapsed.
 *
 * Separated so those cases can be tested exhaustively rather than clicked at.
 */

export interface TabRecord {
  readonly id: string;
  /** What the user sees. Searched by the tab searches. */
  readonly label: string;
  /** Extra words that should match a search without being displayed. */
  readonly searchText?: string;
  /** Which window or workspace it belongs to, for the master search. */
  readonly window?: string;
}

export interface TabGroupRecord {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly members: readonly string[];
}

export interface StripState {
  readonly order: readonly string[];
  readonly pinned: readonly string[];
  readonly groups: readonly TabGroupRecord[];
  readonly collapsed: readonly string[];
}

export const EMPTY_STATE: StripState = { order: [], pinned: [], groups: [], collapsed: [] };

/**
 * The order tabs are laid out in.
 *
 * Pinned first, in their own pinned order, then the rest. A tab that is pinned
 * AND in a group stays pinned: pinning is about survival when the strip
 * overflows, and a group is about organisation. Letting the group win means a
 * pinned tab disappears the moment it is grouped, which is precisely when
 * somebody needs it visible.
 */
export function layout(tabs: readonly TabRecord[], state: StripState): TabRecord[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const seen = new Set<string>();
  const out: TabRecord[] = [];

  const take = (id: string): void => {
    if (seen.has(id)) return;
    const tab = byId.get(id);
    if (tab === undefined) return;
    seen.add(id);
    out.push(tab);
  };

  for (const id of state.pinned) take(id);
  for (const id of state.order) take(id);
  // Anything the stored order has never heard of goes last, in its own order.
  // Dropping it instead would make a newly added tab invisible until somebody
  // reset their settings, which reads as the feature not shipping.
  for (const tab of tabs) take(tab.id);

  return out;
}

/** Which group a tab belongs to, or null. */
export function groupOf(id: string, state: StripState): TabGroupRecord | null {
  return state.groups.find((group) => group.members.includes(id)) ?? null;
}

export function isCollapsed(groupId: string, state: StripState): boolean {
  return state.collapsed.includes(groupId);
}

/**
 * Whether a tab is on screen in the strip.
 *
 * A tab inside a collapsed group is hidden UNLESS it is the active one:
 * collapsing a group while looking at one of its tabs must not make the tab
 * the user is reading disappear from the strip they navigate with.
 */
export function isVisible(id: string, state: StripState, active: string): boolean {
  if (id === active) return true;
  const group = groupOf(id, state);
  return group === null || !isCollapsed(group.id, state);
}

// ------------------------------------------------------------------ moves --

/** Move a tab to a position, keeping pinned and unpinned in their own regions. */
export function reorder(state: StripState, id: string, toIndex: number): StripState {
  const pinned = state.pinned.includes(id);
  const list = [...(pinned ? state.pinned : state.order.filter((entry) => !state.pinned.includes(entry)))];

  const from = list.indexOf(id);
  if (from < 0) return state;
  list.splice(from, 1);
  list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, id);

  if (pinned) return { ...state, pinned: list };
  return { ...state, order: [...state.pinned, ...list] };
}

export function pin(state: StripState, id: string): StripState {
  if (state.pinned.includes(id)) return state;
  return { ...state, pinned: [...state.pinned, id] };
}

export function unpin(state: StripState, id: string): StripState {
  return { ...state, pinned: state.pinned.filter((entry) => entry !== id) };
}

/**
 * Put a tab in a group, removing it from any other.
 *
 * A tab in two groups is a tab that renders twice, and the second copy cannot
 * be closed because closing it closes the first.
 */
export function moveToGroup(state: StripState, id: string, groupId: string | null): StripState {
  const groups = state.groups
    .map((group) => ({
      ...group,
      members: group.members.filter((entry) => entry !== id),
    }))
    .map((group) =>
      group.id === groupId ? { ...group, members: [...group.members, id] } : group,
    );

  // An emptied group is KEPT, not removed. Somebody who drags the last tab out
  // of a group they named and coloured has not asked for it to be deleted, and
  // silently deleting it loses the name.
  return { ...state, groups };
}

export function createGroup(
  state: StripState,
  group: { id: string; name: string; color: string; members?: readonly string[] },
): StripState {
  if (state.groups.some((existing) => existing.id === group.id)) return state;
  const members = group.members ?? [];
  // Members are moved rather than copied, or a tab lands in two groups.
  let next: StripState = {
    ...state,
    groups: [...state.groups, { ...group, members: [] }],
  };
  for (const member of members) next = moveToGroup(next, member, group.id);
  return next;
}

/** Remove a group. Its tabs survive, ungrouped. */
export function removeGroup(state: StripState, groupId: string): StripState {
  return {
    ...state,
    groups: state.groups.filter((group) => group.id !== groupId),
    collapsed: state.collapsed.filter((entry) => entry !== groupId),
  };
}

export function toggleCollapsed(state: StripState, groupId: string): StripState {
  return isCollapsed(groupId, state)
    ? { ...state, collapsed: state.collapsed.filter((entry) => entry !== groupId) }
    : { ...state, collapsed: [...state.collapsed, groupId] };
}

export function renameGroup(state: StripState, groupId: string, name: string): StripState {
  return {
    ...state,
    groups: state.groups.map((group) => (group.id === groupId ? { ...group, name } : group)),
  };
}

// --------------------------------------------------------------- searches --

export interface SearchResult {
  readonly tab: TabRecord;
  /** The group it sits in, so a result can say where it is. */
  readonly group: TabGroupRecord | null;
  readonly pinned: boolean;
  /** True when the result is inside a group the user has collapsed. */
  readonly hidden: boolean;
  readonly window: string;
}

export type Matcher = (text: string) => boolean;

/** Plain-text matching, which is the default everywhere. */
export function plainMatcher(query: string): Matcher {
  const needle = query.trim().toLowerCase();
  if (needle === '') return () => true;
  return (text) => text.toLowerCase().includes(needle);
}

/**
 * A regular-expression matcher, for the builder.
 *
 * An invalid pattern matches NOTHING rather than everything. Falling back to
 * matching everything while somebody is halfway through typing `(` shows the
 * whole list and reads as the filter being broken.
 */
export function regexMatcher(pattern: string, flags: string): Matcher {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flags);
  } catch {
    return () => false;
  }
  return (text) => {
    // `lastIndex` on a sticky or global expression makes a reused RegExp give
    // different answers on identical input, so it is reset every call.
    expression.lastIndex = 0;
    return expression.test(text);
  };
}

function haystack(tab: TabRecord): string {
  return tab.label + ' ' + (tab.searchText ?? '');
}

function describe(
  tab: TabRecord,
  state: StripState,
  active: string,
): SearchResult {
  const group = groupOf(tab.id, state);
  return {
    tab,
    group,
    pinned: state.pinned.includes(tab.id),
    // Reported rather than filtered out. A result the user cannot see is still
    // a result, and saying "in Research, collapsed" is more use than silently
    // omitting it.
    hidden: !isVisible(tab.id, state, active),
    window: tab.window ?? 'this window',
  };
}

/** SEARCH ONE: the current strip. */
export function searchStrip(
  tabs: readonly TabRecord[],
  state: StripState,
  active: string,
  match: Matcher,
): SearchResult[] {
  return layout(tabs, state)
    .filter((tab) => match(haystack(tab)))
    .map((tab) => describe(tab, state, active));
}

/** SEARCH TWO: inside one group. */
export function searchGroup(
  tabs: readonly TabRecord[],
  state: StripState,
  active: string,
  groupId: string,
  match: Matcher,
): SearchResult[] {
  const group = state.groups.find((entry) => entry.id === groupId);
  if (group === undefined) return [];
  const members = new Set(group.members);
  return layout(tabs, state)
    .filter((tab) => members.has(tab.id) && match(haystack(tab)))
    .map((tab) => describe(tab, state, active));
}

/** SEARCH THREE: groups themselves, by their visible names. */
export function searchGroups(state: StripState, match: Matcher): TabGroupRecord[] {
  return state.groups.filter((group) => match(group.name));
}

/**
 * SEARCH FOUR: every open tab, across every window and workspace.
 *
 * Distinct from search one, which only sees the current strip. A master search
 * that quietly searched one window would be the most confusing of the four,
 * because it would look like it worked.
 */
export function searchEverything(
  windows: readonly { readonly name: string; readonly tabs: readonly TabRecord[]; readonly state: StripState; readonly active: string }[],
  match: Matcher,
): SearchResult[] {
  const out: SearchResult[] = [];
  for (const window of windows) {
    for (const tab of layout(window.tabs, window.state)) {
      if (!match(haystack(tab))) continue;
      out.push({
        ...describe(tab, window.state, window.active),
        window: window.name,
      });
    }
  }
  return out;
}

// --------------------------------------------------------- bulk closing --

export interface ClosePlan {
  readonly closing: readonly string[];
  /** Named, with the reason, rather than silently skipped. */
  readonly kept: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Work out what a bulk close would do, without doing it.
 *
 * Pinned tabs are excluded by default. `includePinned` is the explicit opt-in,
 * and even then the plan is shown before anything closes: a bulk close that
 * silently skips items is indistinguishable from one that failed.
 */
export function planClose(
  tabs: readonly TabRecord[],
  state: StripState,
  match: Matcher,
  options: { readonly invert?: boolean; readonly includePinned?: boolean } = {},
): ClosePlan {
  const closing: string[] = [];
  const kept: { id: string; reason: string }[] = [];

  for (const tab of layout(tabs, state)) {
    const matches = match(haystack(tab));
    const wanted = options.invert === true ? !matches : matches;
    if (!wanted) continue;

    if (state.pinned.includes(tab.id) && options.includePinned !== true) {
      kept.push({ id: tab.id, reason: 'pinned' });
      continue;
    }
    closing.push(tab.id);
  }

  return { closing, kept };
}
