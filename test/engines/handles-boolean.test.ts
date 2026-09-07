/**
 * Selection handles and boolean path operations.
 *
 * The handle tests are about what a DRAG MEANS: which corner stays put, which
 * axis an edge changes, what happens when the pointer crosses the anchor. Every
 * one of those has an obvious wrong answer that produces a shape which moves
 * when it should only have grown.
 *
 * The boolean tests are mostly about the cases with NO crossings, because those
 * are the ones a clipper written around the crossing walk quietly returns
 * nothing for - and nothing, for a union of two separate squares, is a deletion.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type BooleanResult,
  combine,
  combineShapes,
  contains,
  normaliseWinding,
  signedArea,
} from '../../app/engines/vector/boolean';
import {
  anchorFor,
  handleAt,
  handlesFor,
  resizable,
  resize,
  scaleFor,
} from '../../app/engines/vector/handles';
import {
  type Bounds,
  type Point,
  type Shape,
  IDENTITY,
} from '../../app/engines/vector/model';

const BOX: Bounds = { left: 10, top: 20, right: 110, bottom: 80 };

function square(x: number, y: number, size: number): Point[] {
  return [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ];
}

function shape(id: string, points: Point[], overrides: Partial<Shape> = {}): Shape {
  return {
    id,
    kind: 'polyline',
    points,
    transform: IDENTITY,
    locked: false,
    hidden: false,
    name: id,
    ...overrides,
  };
}

function ok(result: BooleanResult | { ok: false; reason: string }): BooleanResult {
  assert.ok(result.ok, 'refused: ' + (result.ok ? '' : result.reason));
  return result;
}

// --------------------------------------------------------------- handles --

test('there are eight resize handles and one to rotate', () => {
  const handles = handlesFor(BOX);
  assert.equal(handles.length, 9);
  assert.equal(handles.filter((handle) => handle.name === 'rotate').length, 1);
});

test('the rotate handle sits ABOVE the shape, clear of the corners', () => {
  // Otherwise it is a coin toss which one the pointer catches.
  const handles = handlesFor(BOX);
  const rotate = handles.find((handle) => handle.name === 'rotate');
  assert.ok((rotate?.y ?? 0) < BOX.top, 'the rotate handle is inside the shape');
});

test('every handle says what it does, in words and in a cursor', () => {
  // A handle is a control. One with no accessible name does not exist for
  // anybody using a screen reader, and one with the wrong cursor lies about
  // what a drag will do before the drag happens.
  for (const handle of handlesFor(BOX)) {
    assert.ok(handle.label.length > 5, handle.name + ' has no label');
    assert.ok(handle.cursor.length > 0, handle.name + ' has no cursor');
  }
});

test('the anchor is the OPPOSITE corner, so the shape does not move', () => {
  // THE ONE THAT MATTERS. A resize about the centre moves the shape as well as
  // sizing it, and the user chases it across the canvas.
  assert.deepEqual(anchorFor('bottomRight', BOX), { x: BOX.left, y: BOX.top });
  assert.deepEqual(anchorFor('topLeft', BOX), { x: BOX.right, y: BOX.bottom });
});

test('dragging a corner keeps the opposite corner exactly where it was', () => {
  const result = resize('bottomRight', BOX, { x: 200, y: 200 });
  assert.equal(result.bounds.left, BOX.left);
  assert.equal(result.bounds.top, BOX.top);
  assert.equal(result.bounds.right, 200);
  assert.equal(result.bounds.bottom, 200);
});

test('an EDGE handle changes one axis and leaves the other alone', () => {
  // A handle that resizes both is the commonest reason a careful drag ends up
  // crooked.
  const right = resize('right', BOX, { x: 200, y: 999 });
  assert.equal(right.bounds.top, BOX.top);
  assert.equal(right.bounds.bottom, BOX.bottom);
  assert.equal(right.bounds.right, 200);

  const bottom = resize('bottom', BOX, { x: 999, y: 200 });
  assert.equal(bottom.bounds.left, BOX.left);
  assert.equal(bottom.bounds.right, BOX.right);
  assert.equal(bottom.bounds.bottom, 200);
});

test('dragging past the anchor FLIPS rather than clamping', () => {
  // Clamping makes the shape stick at one pixel and refuse to follow the
  // pointer, which reads as the application freezing.
  const result = resize('bottomRight', BOX, { x: BOX.left - 50, y: BOX.top - 50 });
  assert.equal(result.bounds.left, BOX.left - 50);
  assert.equal(result.bounds.right, BOX.left);
  assert.ok(result.bounds.right >= result.bounds.left, 'the bounds came out inverted');
});

test('a zero-size drag does not produce Infinity', () => {
  // A drag passes through zero width on its way to flipping, and dividing by
  // the old size gives Infinity exactly then - so the shape vanishes at the
  // instant the pointer crosses the anchor.
  const flat: Bounds = { left: 10, top: 10, right: 10, bottom: 50 };
  const scale = scaleFor(flat, { left: 0, top: 10, right: 100, bottom: 50 });
  assert.ok(Number.isFinite(scale.x), 'the horizontal scale came out ' + scale.x);
  assert.equal(scale.x, 1, 'a zero divisor should hold the shape still, not resize it');
});

test('a proportional corner drag keeps the ratio', () => {
  const square100: Bounds = { left: 0, top: 0, right: 100, bottom: 100 };
  const result = resize('bottomRight', square100, { x: 200, y: 50 }, { proportional: true });
  const width = result.bounds.right - result.bounds.left;
  const height = result.bounds.bottom - result.bounds.top;
  assert.ok(Math.abs(width - height) < 0.001, width + ' by ' + height);
});

test('the NEAREST handle wins, not the first', () => {
  // Corners overlap edge handles at small sizes, and taking the first makes a
  // corner drag behave as an edge drag.
  const tiny: Bounds = { left: 0, top: 0, right: 10, bottom: 10 };
  const hit = handleAt(tiny, { x: 10, y: 10 }, 20);
  assert.equal(hit?.handle.name, 'bottomRight');
});

test('nothing is hit when the pointer is nowhere near', () => {
  assert.equal(handleAt(BOX, { x: 500, y: 500 }, 8), null);
});

test('a locked shape refuses a resize and SAYS SO', () => {
  // The handles are still drawn - hiding them makes a locked shape look
  // unselected - and the refusal names the shape.
  const locked = shape('a', square(0, 0, 10), { locked: true, name: 'Base' });
  const result = resizable(locked);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /Base is locked/);
});

// --------------------------------------------------------------- boolean --

test('winding is normalised, because both directions look identical on screen', () => {
  // Two rings wound the same way union cleanly; wound oppositely the same walk
  // subtracts.
  const clockwise = [...square(0, 0, 10)].reverse();
  assert.ok(signedArea(clockwise) < 0);
  assert.ok(signedArea(normaliseWinding(clockwise)) > 0);
});

test('a point on the boundary counts as inside', () => {
  // Floating point puts points there constantly, and calling them outside makes
  // a shape union with itself produce a sliver of nothing.
  const ring = square(0, 0, 10);
  assert.equal(contains(ring, { x: 0, y: 5 }), true);
  assert.equal(contains(ring, { x: 5, y: 5 }), true);
  assert.equal(contains(ring, { x: 20, y: 5 }), false);
});

test('a union of two SEPARATE squares is two rings, not nothing', () => {
  // THE CASE A CROSSING-WALK CLIPPER GETS WRONG. There are no intersections at
  // all, so a clipper that requires one returns empty - which is a deletion.
  const result = ok(combine(square(0, 0, 10), square(100, 100, 10), 'union'));
  assert.equal(result.rings.length, 2);
});

test('and it does not join them, which would draw a line that is not there', () => {
  const result = ok(combine(square(0, 0, 10), square(100, 100, 10), 'union'));
  for (const ring of result.rings) assert.equal(ring.length, 4);
});

test('an intersection of separate squares is EMPTY, and empty is an answer', () => {
  const result = ok(combine(square(0, 0, 10), square(100, 100, 10), 'intersection'));
  assert.deepEqual(result.rings, []);
});

test('subtracting a shape that covers you leaves NOTHING', () => {
  // Returning the original makes the operation appear to do nothing, which
  // somebody will press again.
  const result = ok(combine(square(10, 10, 10), square(0, 0, 100), 'difference'));
  assert.deepEqual(result.rings, []);
});

test('a union of nested squares is the outer one', () => {
  const result = ok(combine(square(10, 10, 10), square(0, 0, 100), 'union'));
  assert.equal(result.rings.length, 1);
  const ring = result.rings[0] as readonly Point[];
  assert.ok(Math.abs(signedArea(ring)) > 9000, 'the union kept the small square');
});

test('an intersection of nested squares is the inner one', () => {
  const result = ok(combine(square(10, 10, 10), square(0, 0, 100), 'intersection'));
  const ring = result.rings[0] as readonly Point[];
  assert.ok(Math.abs(signedArea(ring)) < 200, 'the intersection kept the big square');
});

test('two OVERLAPPING squares union into one bigger ring', () => {
  const result = ok(combine(square(0, 0, 10), square(5, 5, 10), 'union'));
  assert.equal(result.rings.length, 1);
  const area = Math.abs(signedArea(result.rings[0] as readonly Point[]));
  // 100 + 100 - 25 overlap.
  assert.ok(area > 150 && area < 200, 'the union area is ' + area);
});

test('and intersect into the overlap alone', () => {
  const result = ok(combine(square(0, 0, 10), square(5, 5, 10), 'intersection'));
  const area = Math.abs(signedArea(result.rings[0] as readonly Point[]));
  assert.ok(area > 15 && area < 35, 'the intersection area is ' + area);
});

test('a shape combined with ITSELF is itself, not a sliver', () => {
  // Every vertex lands on the other ring, which is the case a tolerance-free
  // containment test gets wrong.
  const result = ok(combine(square(0, 0, 10), square(0, 0, 10), 'union'));
  const area = Math.abs(signedArea(result.rings[0] as readonly Point[]));
  assert.ok(area > 90 && area < 110, 'the area came out ' + area);
});

test('a line is refused, because it encloses no area', () => {
  // Refused rather than approximated: returning the inputs unchanged is
  // indistinguishable from a button that is not wired up.
  const line = shape('l', [{ x: 0, y: 0 }, { x: 10, y: 10 }], { kind: 'line' });
  const box = shape('b', square(0, 0, 10));
  const result = combineShapes(line, box, 'union');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /encloses no area/);
});

test('text is refused, with what to do about it', () => {
  const text = shape('t', square(0, 0, 10), { kind: 'text', text: 'hi' });
  const box = shape('b', square(0, 0, 10));
  const result = combineShapes(text, box, 'union');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /convert it to a path/);
});

test('a locked shape is refused, and named', () => {
  const locked = shape('a', square(0, 0, 10), { locked: true, name: 'Base' });
  const other = shape('b', square(5, 5, 10));
  const result = combineShapes(locked, other, 'union');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /Base is locked|locked/);
});

test('an ellipse says its result is APPROXIMATE', () => {
  // Its outline is a polygon approximation, so the result is close rather than
  // exact - said out loud so nobody measures it and finds it off.
  const ellipse = shape('e', square(0, 0, 10), { kind: 'ellipse', width: 10, height: 10 });
  const box = shape('b', square(5, 5, 10));
  const result = combineShapes(ellipse, box, 'union');
  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.approximated : false, true);
});

test('two polygons of fewer than three points are refused', () => {
  const result = combine([{ x: 0, y: 0 }, { x: 1, y: 1 }], square(0, 0, 10), 'union');
  assert.equal(result.ok, false);
});

// ------------------------------------------------- the diagonal overlap ----
//
// Every one of these would have PASSED against the broken walk that
// concatenated the two filtered rings instead of hopping between them, if it
// had only counted rings. The area is what caught it: the union came back as a
// self-crossing tangle whose shoelace area was 27,600 against a true 30,000,
// and it rendered as a diagonal slice across the middle of two rectangles.
//
// Two rectangles overlapping at a corner rather than edge-on, because that is
// the arrangement where the two kept runs do NOT join end to end.

const LOWER = [
  { x: 60, y: 60 },
  { x: 200, y: 60 },
  { x: 200, y: 180 },
  { x: 60, y: 180 },
] as const;

const UPPER = [
  { x: 140, y: 120 },
  { x: 280, y: 120 },
  { x: 280, y: 240 },
  { x: 140, y: 240 },
] as const;

const areaOf = (rings: readonly (readonly Point[])[]): number =>
  rings.reduce((total, ring) => total + Math.abs(signedArea(ring)), 0);

test('the union of two corner-overlapping rectangles is an L, not a tangle', () => {
  const result = combine([...LOWER], [...UPPER], 'union');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.rings.length, 1);
  // 140x120 twice, less the 60x60 they share.
  assert.equal(Math.round(areaOf(result.rings)), 140 * 120 * 2 - 60 * 60);
  // Eight corners exactly: six from the outsides plus the two crossings. A
  // tangle has ten, because it visits two of them twice.
  assert.equal(result.rings[0]?.length, 8);
});

test('the intersection is the shared square and nothing else', () => {
  const result = combine([...LOWER], [...UPPER], 'intersection');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(Math.round(areaOf(result.rings)), 60 * 60);
  assert.equal(result.rings[0]?.length, 4);
});

test('a difference removes exactly the shared square', () => {
  const result = combine([...LOWER], [...UPPER], 'difference');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(Math.round(areaOf(result.rings)), 140 * 120 - 60 * 60);
  assert.equal(result.rings[0]?.length, 6);
});

test('subtracting the other way round is a DIFFERENT shape, not the same one', () => {
  // A boolean is not symmetric, and a walk that ignores which ring is the
  // subject gives the same answer both ways round - which looks fine until
  // somebody subtracts the shape they meant to keep.
  const one = combine([...LOWER], [...UPPER], 'difference');
  const other = combine([...UPPER], [...LOWER], 'difference');
  assert.ok(one.ok && other.ok);
  if (!one.ok || !other.ok) return;
  assert.equal(Math.round(areaOf(one.rings)), 140 * 120 - 60 * 60);
  assert.equal(Math.round(areaOf(other.rings)), 140 * 120 - 60 * 60);
  assert.notDeepEqual(one.rings[0], other.rings[0]);
});

test('no edge of a union ring crosses another edge of it', () => {
  // The direct statement of what went wrong. A ring can have the right vertex
  // count and the wrong ORDER, and area alone will not always notice.
  const result = combine([...LOWER], [...UPPER], 'union');
  assert.ok(result.ok);
  if (!result.ok) return;
  const ring = result.rings[0] ?? [];

  const crosses = (
    a: Point, b: Point, c: Point, d: Point,
  ): boolean => {
    const side = (p: Point, q: Point, r: Point): number =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const one = side(a, b, c);
    const two = side(a, b, d);
    const three = side(c, d, a);
    const four = side(c, d, b);
    return one * two < -1e-9 && three * four < -1e-9;
  };

  for (let i = 0; i < ring.length; i += 1) {
    for (let j = i + 2; j < ring.length; j += 1) {
      if (i === 0 && j === ring.length - 1) continue; // adjacent round the loop
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const c = ring[j];
      const d = ring[(j + 1) % ring.length];
      if (a && b && c && d) assert.equal(crosses(a, b, c, d), false);
    }
  }
});

test('an exclusion of the pair keeps both pieces, and their areas add up', () => {
  const result = combine([...LOWER], [...UPPER], 'exclusion');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.rings.length, 2);
  assert.equal(Math.round(areaOf(result.rings)), 140 * 120 * 2 - 60 * 60 + 60 * 60);
});
