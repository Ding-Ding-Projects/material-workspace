/**
 * Multi-select and bulk actions.
 *
 * Every test here is a way a selection quietly does the wrong thing: a range
 * that grows a trail, a select-all whose scope nobody stated, a plan that
 * silently drops what it could not act on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY,
  type Selection,
  choose,
  clear,
  count,
  describePlan,
  describeSelectAll,
  extend,
  invert,
  isChosen,
  plan,
  selectAll,
  toggle,
} from '../../app/shared/bulk';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const ITEMS = ORDER.map((id) => ({ id, pinned: id === 'c' }));

const ids = (selection: Selection): string[] => [...selection.chosen].sort();

// ------------------------------------------------------------- selecting --

test('a plain click selects one and forgets the rest', () => {
  const first = toggle(toggle(EMPTY, 'a'), 'b');
  assert.deepEqual(ids(first), ['a', 'b']);
  assert.deepEqual(ids(choose('e')), ['e']);
});

test('control-click adds and removes without disturbing the rest', () => {
  let selection = choose('a');
  selection = toggle(selection, 'c');
  assert.deepEqual(ids(selection), ['a', 'c']);
  selection = toggle(selection, 'a');
  assert.deepEqual(ids(selection), ['c']);
});

test('shift-click takes the range between the anchor and here', () => {
  const selection = extend(choose('b'), 'd', ORDER);
  assert.deepEqual(ids(selection), ['b', 'c', 'd']);
});

test('a range works backwards as well as forwards', () => {
  assert.deepEqual(ids(extend(choose('d'), 'b', ORDER)), ['b', 'c', 'd']);
});

test('the anchor stays put, so dragging a range grows and shrinks ONE range', () => {
  // Moving the anchor each time leaves a trail of ranges behind, which is the
  // behaviour people describe as "it selects things I did not touch".
  let selection = choose('b');
  selection = extend(selection, 'e', ORDER);
  assert.deepEqual(ids(selection), ['b', 'c', 'd', 'e']);
  assert.equal(selection.anchor, 'b', 'the anchor moved');
});

test('a shift-click with no anchor behaves as a click rather than doing nothing', () => {
  // Silently ignoring it is the version people report as broken, because from
  // the outside it is indistinguishable from a click that missed.
  assert.deepEqual(ids(extend(EMPTY, 'c', ORDER)), ['c']);
});

test('a range to an item that is not in the list falls back to a click', () => {
  assert.deepEqual(ids(extend(choose('a'), 'ghost', ORDER)), ['ghost']);
});

test('select-all and inverse leave no anchor', () => {
  // Extending a range from "everything" would select a span nobody pointed at.
  assert.equal(selectAll(ORDER).anchor, null);
  assert.equal(invert(choose('a'), ORDER).anchor, null);
});

test('inverting takes exactly what was not chosen', () => {
  assert.deepEqual(ids(invert(choose('a'), ORDER)), ['b', 'c', 'd', 'e']);
  assert.deepEqual(ids(invert(selectAll(ORDER), ORDER)), []);
  assert.deepEqual(ids(invert(EMPTY, ORDER)), ORDER);
});

test('clearing empties it', () => {
  assert.equal(count(clear()), 0);
  assert.equal(isChosen(clear(), 'a'), false);
});

// ------------------------------------------------------------- the scope --

test('select-all says WHICH all it means when the two differ', () => {
  // Over a filtered list of 20 out of 4000 those are completely different
  // actions, and the one somebody assumed is the one that ruins their
  // afternoon.
  const filtered = describeSelectAll('everything', 20, 4000);
  assert.match(filtered, /20 shown/);
  assert.match(filtered, /4000/);
  assert.match(filtered, /different/);
});

test('it does not belabour the scope when there is only one', () => {
  // A warning that is always there is a warning nobody reads.
  const same = describeSelectAll('everything', 12, 12);
  assert.ok(!/different/.test(same), same);
  assert.match(same, /12 items shown/);
  assert.match(describeSelectAll('page', 1, 900), /1 item shown/);
});

// --------------------------------------------------------------- the plan --

test('a plan names what it kept and why, rather than skipping it', () => {
  // A bulk action that silently skips items is indistinguishable from one that
  // failed.
  const selection = selectAll(ORDER);
  const result = plan(ITEMS, selection, {
    protect: (item) => (item.pinned ? 'pinned' : null),
  });

  assert.deepEqual(result.acting.map((item) => item.id), ['a', 'b', 'd', 'e']);
  assert.deepEqual(result.kept, [{ id: 'c', reason: 'pinned' }]);
});

test('the sentence gives the two counts separately', () => {
  // "42 selected" and "42 will change" are different numbers whenever anything
  // is protected, and collapsing them is how somebody discovers afterwards
  // that six were skipped.
  const result = plan(ITEMS, selectAll(ORDER), {
    protect: (item) => (item.pinned ? 'pinned' : null),
  });
  const sentence = describePlan(result, 'closed');
  assert.match(sentence, /4 items will be closed/);
  assert.match(sentence, /1 is kept/);
});

test('the sentence is honest when nothing will happen', () => {
  const nothing = plan(ITEMS, choose('c'), {
    protect: (item) => (item.pinned ? 'pinned' : null),
  });
  assert.match(describePlan(nothing, 'deleted'), /Nothing will be deleted/);
  assert.match(describePlan(plan(ITEMS, EMPTY), 'deleted'), /Nothing is selected/);
});

test('planning changes nothing, so a preview is safe to show', () => {
  const selection = selectAll(ORDER);
  const before = [...selection.chosen].join(',');
  plan(ITEMS, selection, { protect: () => 'held' });
  assert.equal([...selection.chosen].join(','), before, 'planning mutated the selection');
});

test('a plan only ever covers what is selected', () => {
  const result = plan(ITEMS, choose('b'));
  assert.deepEqual(result.acting.map((item) => item.id), ['b']);
  assert.deepEqual(result.kept, []);
});

test('a selected id that is no longer in the list is simply absent', () => {
  // A list changes under a selection all the time - something arrives,
  // something is removed. Acting on an id that is gone would be acting on
  // whatever now holds that position.
  const stale: Selection = { chosen: new Set(['a', 'ghost']), anchor: null };
  const result = plan(ITEMS, stale);
  assert.deepEqual(result.acting.map((item) => item.id), ['a']);
});

test('irreversible is carried on the plan, so the caller knows to gate it', () => {
  assert.equal(plan(ITEMS, choose('a')).irreversible, false);
  assert.equal(plan(ITEMS, choose('a'), { irreversible: true }).irreversible, true);
});

// ------------------------------------------------------------- pluralism --

test('one item reads as one item', () => {
  const one = plan(ITEMS, choose('a'));
  assert.match(describePlan(one, 'dismissed'), /1 item will be dismissed\./);
  assert.ok(!/1 items/.test(describePlan(one, 'dismissed')));
});
