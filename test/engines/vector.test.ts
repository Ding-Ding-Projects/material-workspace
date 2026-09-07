/**
 * Vector engine conformance.
 *
 * The transform tests are the ones that matter: an affine composition in the
 * wrong order produces coordinates that look plausible and are wrong, which is
 * exactly the class of defect no screenshot reveals.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IDENTITY,
  type Drawing,
  type Point,
  type Shape,
  applyTransform,
  arrange,
  boundsOf,
  compose,
  emptyDrawing,
  hitTest,
  invert,
  newShapeId,
  rotation,
  rotationAbout,
  scaling,
  shapeAt,
  toSvg,
  translation,
  unionBounds,
} from '../../app/engines/vector/model';

function shape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: newShapeId(),
    kind: 'rectangle',
    points: [],
    width: 100,
    height: 50,
    transform: IDENTITY,
    locked: false,
    hidden: false,
    name: 'Shape',
    ...overrides,
  };
}

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    'expected ' + actual + ' to be within ' + tolerance + ' of ' + expected,
  );
}

// ------------------------------------------------------------- transforms --

test('the identity transform leaves a point alone', () => {
  assert.deepEqual(applyTransform(IDENTITY, { x: 3, y: 7 }), { x: 3, y: 7 });
});

test('composition applies the RIGHT transform first', () => {
  // The order people get backwards. Translate-then-scale and
  // scale-then-translate give different answers, and the wrong one sends a
  // shape somewhere unexpected.
  const translateThenScale = compose(scaling(2, 2), translation(10, 0));
  const scaleThenTranslate = compose(translation(10, 0), scaling(2, 2));

  assert.deepEqual(applyTransform(translateThenScale, { x: 0, y: 0 }), { x: 20, y: 0 });
  assert.deepEqual(applyTransform(scaleThenTranslate, { x: 0, y: 0 }), { x: 10, y: 0 });
});

test('a rotation about a point leaves that point where it was', () => {
  const centre: Point = { x: 50, y: 25 };
  const rotated = applyTransform(rotationAbout(Math.PI / 3, centre), centre);
  close(rotated.x, centre.x);
  close(rotated.y, centre.y);
});

test('five rotations of seventy-two degrees return to the start', () => {
  // Exactly the case a baked-geometry implementation loses. A stored transform
  // composes the rotations and comes back; baking rounds at every step.
  const centre: Point = { x: 0, y: 0 };
  const step = (Math.PI * 2) / 5;
  let transform = IDENTITY;
  for (let index = 0; index < 5; index += 1) {
    transform = compose(rotationAbout(step, centre), transform);
  }
  const point = applyTransform(transform, { x: 100, y: 0 });
  close(point.x, 100, 1e-9);
  close(point.y, 0, 1e-9);
});

test('inverting a transform undoes it', () => {
  const transform = compose(rotation(0.7), compose(scaling(3, 2), translation(11, -4)));
  const inverse = invert(transform);
  assert.ok(inverse !== undefined);
  const original: Point = { x: 17, y: -23 };
  const round = applyTransform(inverse, applyTransform(transform, original));
  close(round.x, original.x, 1e-9);
  close(round.y, original.y, 1e-9);
});

test('a degenerate transform has no inverse, and says so rather than guessing', () => {
  // A zero determinant has collapsed the plane to a line. Returning an
  // approximation would give coordinates that look plausible and mean nothing.
  assert.equal(invert(scaling(0, 1)), undefined);
  assert.equal(invert(scaling(1, 0)), undefined);
});

// ----------------------------------------------------------------- bounds --

test('bounds follow the transform', () => {
  const moved = shape({ transform: translation(20, 10) });
  assert.deepEqual(boundsOf(moved), { left: 20, top: 10, right: 120, bottom: 60 });
});

test('a rotated rectangle has bounds larger than itself', () => {
  const rotated = shape({
    width: 100,
    height: 100,
    transform: rotationAbout(Math.PI / 4, { x: 50, y: 50 }),
  });
  const bounds = boundsOf(rotated);
  const size = bounds.right - bounds.left;
  // A square rotated forty-five degrees has a bounding box its diagonal wide.
  close(size, Math.SQRT2 * 100, 1e-6);
});

test('union bounds cover every shape, and are undefined for none', () => {
  const a = shape({ transform: translation(0, 0) });
  const b = shape({ transform: translation(200, 100) });
  assert.deepEqual(unionBounds([a, b]), { left: 0, top: 0, right: 300, bottom: 150 });
  assert.equal(unionBounds([]), undefined);
});

// ------------------------------------------------------------ hit testing --

test('a point inside an untransformed rectangle hits it', () => {
  const box = shape();
  assert.equal(hitTest(box, { x: 50, y: 25 }), true);
  assert.equal(hitTest(box, { x: 150, y: 25 }), false);
});

test('hit testing respects the transform', () => {
  const moved = shape({ transform: translation(200, 0) });
  assert.equal(hitTest(moved, { x: 50, y: 25 }), false);
  assert.equal(hitTest(moved, { x: 250, y: 25 }), true);
});

test('a rotated rectangle is hit in its ROTATED position, not its original one', () => {
  const rotated = shape({
    width: 100,
    height: 20,
    transform: rotationAbout(Math.PI / 2, { x: 50, y: 10 }),
  });
  // After a quarter turn about its own centre the long axis is vertical.
  assert.equal(hitTest(rotated, { x: 50, y: 50 }), true);
  assert.equal(hitTest(rotated, { x: 95, y: 10 }), false);
});

test('an ellipse is elliptical, not its bounding box', () => {
  const oval = shape({ kind: 'ellipse', width: 100, height: 50 });
  assert.equal(hitTest(oval, { x: 50, y: 25 }), true, 'the centre should hit');
  // The corner of the bounding box is outside the ellipse itself.
  assert.equal(hitTest(oval, { x: 2, y: 2 }), false, 'a bounding-box corner should miss');
});

test('a line is selectable near it, not only exactly on it', () => {
  // A one-pixel line that can only be hit exactly is a line nobody can select.
  const line = shape({
    kind: 'line',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    stroke: { colour: '#000', width: 1 },
  });
  assert.equal(hitTest(line, { x: 50, y: 2 }), true);
  assert.equal(hitTest(line, { x: 50, y: 40 }), false);
});

test('a point beyond the end of a segment is not on it', () => {
  // Without clamping the projection this measures to the infinite LINE, so a
  // point far past the end reads as being right on it.
  const line = shape({
    kind: 'line',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  });
  assert.equal(hitTest(line, { x: 500, y: 0 }), false);
});

test('a hidden shape is never hit', () => {
  assert.equal(hitTest(shape({ hidden: true }), { x: 50, y: 25 }), false);
});

test('the topmost shape wins, and locked shapes are skipped', () => {
  const back = shape({ name: 'back' });
  const front = shape({ name: 'front' });
  const drawing: Drawing = { ...emptyDrawing(), shapes: [back, front] };
  // Painted last is what the user sees there, so it is what they mean.
  assert.equal(shapeAt(drawing, { x: 50, y: 25 })?.name, 'front');

  const locked: Drawing = { ...drawing, shapes: [back, { ...front, locked: true }] };
  assert.equal(shapeAt(locked, { x: 50, y: 25 })?.name, 'back');
});

// --------------------------------------------------------------- ordering --

test('shapes can be arranged, and the ends clamp rather than wrap', () => {
  const a = shape({ name: 'a' });
  const b = shape({ name: 'b' });
  const c = shape({ name: 'c' });
  const drawing: Drawing = { ...emptyDrawing(), shapes: [a, b, c] };

  const names = (d: Drawing): string[] => d.shapes.map((s) => s.name);

  assert.deepEqual(names(arrange(drawing, a.id, 'front')), ['b', 'c', 'a']);
  assert.deepEqual(names(arrange(drawing, c.id, 'back')), ['c', 'a', 'b']);
  assert.deepEqual(names(arrange(drawing, a.id, 'forward')), ['b', 'a', 'c']);
  assert.deepEqual(names(arrange(drawing, a.id, 'backward')), ['a', 'b', 'c']);
  // Already at the front: forward must not wrap it round to the back.
  assert.deepEqual(names(arrange(drawing, c.id, 'forward')), ['a', 'b', 'c']);
});

// -------------------------------------------------------------------- SVG --

test('the drawing exports as SVG that carries the transform', () => {
  const drawing: Drawing = {
    ...emptyDrawing(400, 300),
    shapes: [
      shape({
        transform: translation(10, 20),
        fill: { colour: '#ff0000' },
        stroke: { colour: '#000000', width: 2 },
      }),
    ],
  };
  const svg = toSvg(drawing);
  assert.ok(svg.includes('viewBox="0 0 400 300"'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('matrix(1 0 0 1 10 20)'));
  assert.ok(svg.includes('fill="#ff0000"'));
  assert.ok(svg.includes('stroke-width="2"'));
});

test('a hidden shape is not exported', () => {
  const drawing: Drawing = {
    ...emptyDrawing(),
    shapes: [shape({ hidden: true }), shape({ kind: 'ellipse' })],
  };
  const svg = toSvg(drawing);
  assert.ok(!svg.includes('<rect'));
  assert.ok(svg.includes('<ellipse'));
});

test('a shape with no fill exports fill="none", not a black rectangle', () => {
  // The SVG default is black. Omitting the attribute turns every unfilled
  // outline into a solid block.
  const svg = toSvg({ ...emptyDrawing(), shapes: [shape({ stroke: { colour: '#000', width: 1 } })] });
  assert.ok(svg.includes('fill="none"'));
});

test('a polyline is exported as a polyline, not a polygon', () => {
  // A polygon closes itself, silently adding a segment the user never drew.
  const svg = toSvg({
    ...emptyDrawing(),
    shapes: [
      shape({
        kind: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
          { x: 20, y: 0 },
        ],
      }),
    ],
  });
  assert.ok(svg.includes('<polyline'));
  assert.ok(!svg.includes('<polygon'));
});

test('text is escaped on export', () => {
  const svg = toSvg({
    ...emptyDrawing(),
    shapes: [shape({ kind: 'text', text: '1 < 2 & "quoted"' })],
  });
  assert.ok(svg.includes('1 &lt; 2 &amp;'));
  assert.ok(!svg.includes('1 < 2 &'));
});
