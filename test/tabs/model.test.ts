/**
 * The tab strip's arithmetic.
 *
 * Every test here is an edge case that is invisible on screen until somebody
 * hits it: a pinned tab inside a collapsed group, a group whose last member was
 * dragged out, a bulk close that silently skips something.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_STATE,
  type StripState,
  type TabRecord,
  createGroup,
  groupOf,
  isCollapsed,
  isVisible,
  layout,
  moveToGroup,
  pin,
  planClose,
  plainMatcher,
  regexMatcher,
  removeGroup,
  renameGroup,
  reorder,
  searchEverything,
  searchGroup,
  searchGroups,
  searchStrip,
  toggleCollapsed,
  unpin,
} from '../../app/renderer/tabs/model';

const tab = (id: string, label = id, searchText?: string): TabRecord =>
  searchText === undefined ? { id, label } : { id, label, searchText };

const TABS: TabRecord[] = [
  tab('home', 'Home'),
  tab('writer', 'Writer', 'document text'),
  tab('sheets', 'Sheets', 'spreadsheet numbers'),
  tab('slides', 'Slides', 'presentation deck'),
  tab('notes', 'Notes'),
];

const base: StripState = { ...EMPTY_STATE, order: TABS.map((entry) => entry.id) };

const ids = (list: readonly { id: string }[]): string[] => list.map((entry) => entry.id);

// ------------------------------------------------------------------ order --

test('pinned tabs come first, in their own order', () => {
  const state = pin(pin(base, 'notes'), 'writer');
  assert.deepEqual(ids(layout(TABS, state)), ['notes', 'writer', 'home', 'sheets', 'slides']);
});

test('a tab the stored order has never seen still appears, rather than vanishing', () => {
  // Dropping it would make a newly added tab invisible until somebody reset
  // their settings, which reads as the feature not shipping.
  const stale: StripState = { ...EMPTY_STATE, order: ['home', 'writer'] };
  assert.deepEqual(ids(layout(TABS, stale)), ['home', 'writer', 'sheets', 'slides', 'notes']);
});

test('an order naming a tab that no longer exists does not produce a hole', () => {
  const ghosts: StripState = { ...EMPTY_STATE, order: ['gone', 'home', 'also-gone', 'writer'] };
  assert.deepEqual(ids(layout(TABS, ghosts)), ['home', 'writer', 'sheets', 'slides', 'notes']);
});

test('a tab never appears twice, however the state names it', () => {
  const doubled: StripState = {
    ...EMPTY_STATE,
    order: ['home', 'home', 'writer'],
    pinned: ['home'],
  };
  const laid = ids(layout(TABS, doubled));
  assert.equal(new Set(laid).size, laid.length, 'a tab was rendered twice: ' + laid.join(', '));
});

test('reordering moves within the pinned or unpinned region, not across it', () => {
  const state = pin(base, 'notes');
  const moved = reorder(state, 'slides', 0);
  // `notes` is pinned and stays first; `slides` moves to the front of the rest.
  assert.deepEqual(ids(layout(TABS, moved)), ['notes', 'slides', 'home', 'writer', 'sheets']);
});

test('reordering past the end lands at the end rather than throwing it away', () => {
  const moved = reorder(base, 'home', 99);
  assert.equal(ids(layout(TABS, moved)).at(-1), 'home');
});

test('unpinning returns a tab to the unpinned region', () => {
  const state = unpin(pin(base, 'notes'), 'notes');
  assert.deepEqual(ids(layout(TABS, state)), ['home', 'writer', 'sheets', 'slides', 'notes']);
});

// ----------------------------------------------------------------- groups --

test('a tab is only ever in one group', () => {
  // A tab in two groups renders twice, and the second copy cannot be closed
  // because closing it closes the first.
  let state = createGroup(base, { id: 'g1', name: 'Docs', color: '#f00', members: ['writer'] });
  state = createGroup(state, { id: 'g2', name: 'Data', color: '#0f0' });
  state = moveToGroup(state, 'writer', 'g2');

  assert.equal(groupOf('writer', state)?.id, 'g2');
  assert.deepEqual(
    state.groups.map((group) => group.members),
    [[], ['writer']],
  );
});

test('an emptied group is kept, not silently deleted', () => {
  // Somebody who drags the last tab out of a group they named and coloured has
  // not asked for it to be deleted, and deleting it loses the name.
  let state = createGroup(base, { id: 'g1', name: 'Research', color: '#f00', members: ['notes'] });
  state = moveToGroup(state, 'notes', null);

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.name, 'Research');
  assert.deepEqual(state.groups[0]?.members, []);
});

test('removing a group keeps its tabs and forgets it was collapsed', () => {
  let state = createGroup(base, { id: 'g1', name: 'Docs', color: '#f00', members: ['writer'] });
  state = toggleCollapsed(state, 'g1');
  state = removeGroup(state, 'g1');

  assert.equal(state.groups.length, 0);
  assert.equal(state.collapsed.length, 0, 'a collapsed entry outlived its group');
  assert.ok(ids(layout(TABS, state)).includes('writer'), 'the tab went with the group');
});

test('creating a group with the same id twice does nothing the second time', () => {
  let state = createGroup(base, { id: 'g1', name: 'Docs', color: '#f00' });
  state = createGroup(state, { id: 'g1', name: 'Other', color: '#0f0' });
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.name, 'Docs');
});

test('renaming changes only the name', () => {
  let state = createGroup(base, { id: 'g1', name: 'Docs', color: '#f00', members: ['writer'] });
  state = renameGroup(state, 'g1', 'Writing');
  assert.equal(state.groups[0]?.name, 'Writing');
  assert.deepEqual(state.groups[0]?.members, ['writer']);
});

test('collapsing hides members - except the one being looked at', () => {
  // Collapsing a group while reading one of its tabs must not make that tab
  // disappear from the strip the user navigates with.
  let state = createGroup(base, {
    id: 'g1',
    name: 'Docs',
    color: '#f00',
    members: ['writer', 'sheets'],
  });
  state = toggleCollapsed(state, 'g1');

  assert.equal(isCollapsed('g1', state), true);
  assert.equal(isVisible('sheets', state, 'writer'), false);
  assert.equal(isVisible('writer', state, 'writer'), true, 'the active tab was hidden');
  assert.equal(isVisible('home', state, 'writer'), true);
});

test('a pinned tab stays pinned when it is grouped', () => {
  // Pinning is about surviving overflow; grouping is organisation. Letting the
  // group win means a pinned tab disappears the moment it is grouped, which is
  // exactly when somebody needs it visible.
  let state = pin(base, 'notes');
  state = createGroup(state, { id: 'g1', name: 'Docs', color: '#f00', members: ['notes'] });
  assert.deepEqual(ids(layout(TABS, state)).slice(0, 1), ['notes']);
  assert.equal(groupOf('notes', state)?.id, 'g1');
});

// --------------------------------------------------------------- matchers --

test('an empty query matches everything, so a cleared box shows the list again', () => {
  const match = plainMatcher('   ');
  assert.equal(match('anything at all'), true);
});

test('plain matching is case-insensitive and matches the search text too', () => {
  const match = plainMatcher('SPREADSHEET');
  assert.deepEqual(
    searchStrip(TABS, base, 'home', match).map((result) => result.tab.id),
    ['sheets'],
  );
});

test('an invalid pattern matches nothing rather than everything', () => {
  // Falling back to matching everything while somebody is halfway through
  // typing `(` shows the whole list and reads as the filter being broken.
  const match = regexMatcher('(unclosed', '');
  assert.equal(match('anything'), false);
});

test('a global pattern gives the same answer twice', () => {
  // lastIndex on a reused sticky or global expression makes identical input
  // give different answers, and the symptom is a filter that flickers.
  const match = regexMatcher('e', 'g');
  assert.equal(match('sheets'), true);
  assert.equal(match('sheets'), true, 'the second call disagreed with the first');
});

// --------------------------------------------------------------- searches --

test('search one covers the current strip', () => {
  const results = searchStrip(TABS, base, 'home', plainMatcher('s'));
  assert.deepEqual(
    results.map((result) => result.tab.id).sort(),
    ['notes', 'sheets', 'slides'],
  );
});

test('search two covers one group and nothing outside it', () => {
  const state = createGroup(base, {
    id: 'g1',
    name: 'Docs',
    color: '#f00',
    members: ['writer', 'sheets'],
  });
  const results = searchGroup(TABS, state, 'home', 'g1', plainMatcher('s'));
  assert.deepEqual(results.map((result) => result.tab.id), ['sheets']);
  assert.deepEqual(searchGroup(TABS, state, 'home', 'nope', plainMatcher('')), []);
});

test('search three covers group names', () => {
  let state = createGroup(base, { id: 'g1', name: 'Research', color: '#f00' });
  state = createGroup(state, { id: 'g2', name: 'Drafts', color: '#0f0' });
  assert.deepEqual(
    searchGroups(state, plainMatcher('re')).map((group) => group.id),
    ['g1'],
  );
});

test('search four really does cross windows', () => {
  // A master search that quietly searched one window would be the most
  // confusing of the four, because it would look like it worked.
  const results = searchEverything(
    [
      { name: 'Main', tabs: TABS, state: base, active: 'home' },
      {
        name: 'Second',
        tabs: [tab('report', 'Quarterly report')],
        state: { ...EMPTY_STATE, order: ['report'] },
        active: 'report',
      },
    ],
    plainMatcher('r'),
  );

  const windows = new Set(results.map((result) => result.window));
  assert.ok(windows.has('Main') && windows.has('Second'), 'only one window was searched');
  assert.ok(results.some((result) => result.tab.id === 'report'));
});

test('a result inside a collapsed group is reported as hidden, not omitted', () => {
  // A result the user cannot see is still a result, and saying "in Docs,
  // collapsed" is more use than silently leaving it out.
  let state = createGroup(base, { id: 'g1', name: 'Docs', color: '#f00', members: ['sheets'] });
  state = toggleCollapsed(state, 'g1');

  const found = searchStrip(TABS, state, 'home', plainMatcher('sheets'))[0];
  assert.equal(found?.hidden, true);
  assert.equal(found?.group?.name, 'Docs');
});

test('a result says whether it is pinned and where it lives', () => {
  let state = pin(base, 'notes');
  state = createGroup(state, { id: 'g1', name: 'Docs', color: '#f00', members: ['notes'] });
  const found = searchStrip(TABS, state, 'home', plainMatcher('notes'))[0];
  assert.equal(found?.pinned, true);
  assert.equal(found?.group?.id, 'g1');
  assert.equal(found?.window, 'this window');
});

// ----------------------------------------------------------- bulk closing --

test('a bulk close excludes pinned tabs and says which it kept', () => {
  // A bulk action that silently skips items is indistinguishable from one that
  // failed.
  const state = pin(base, 'sheets');
  const plan = planClose(TABS, state, plainMatcher('s'));
  assert.deepEqual([...plan.closing].sort(), ['notes', 'slides']);
  assert.deepEqual(plan.kept, [{ id: 'sheets', reason: 'pinned' }]);
});

test('including pinned tabs is an explicit opt-in', () => {
  const state = pin(base, 'sheets');
  const plan = planClose(TABS, state, plainMatcher('s'), { includePinned: true });
  assert.deepEqual([...plan.closing].sort(), ['notes', 'sheets', 'slides']);
  assert.deepEqual(plan.kept, []);
});

test('the inverse close negates exactly the same predicate', () => {
  // Flags, casing and scope cannot drift between the two modes, because there
  // is one matcher and one plan function.
  const match = plainMatcher('s');
  const closing = planClose(TABS, base, match).closing;
  const inverted = planClose(TABS, base, match, { invert: true }).closing;

  assert.equal(new Set([...closing, ...inverted]).size, TABS.length);
  assert.equal(closing.some((id) => inverted.includes(id)), false, 'the two overlapped');
});

test('planning changes nothing, so a preview is safe to show', () => {
  const before = JSON.stringify(base);
  planClose(TABS, base, plainMatcher('s'), { includePinned: true, invert: true });
  assert.equal(JSON.stringify(base), before, 'planning mutated the state');
});
