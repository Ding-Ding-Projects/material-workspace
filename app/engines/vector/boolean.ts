/**
 * Boolean operations on polygons: union, difference, intersection, exclusion.
 *
 * A Greiner-Hormann style clipper, walking the intersections between two rings
 * and following one or the other depending on the operation.
 *
 * WHAT THIS HANDLES AND WHAT IT REFUSES, SAID UP FRONT. Simple closed polygons,
 * including concave ones, with a boolean of two shapes at a time. It does NOT
 * handle self-intersecting input, holes, or curves - a curve is flattened
 * first, which is exact for a line and an approximation for a bezier, and the
 * caller is told rather than left to discover it from a shape that is slightly
 * the wrong size.
 *
 * FIVE THINGS THAT MAKE A BOOLEAN LOOK RIGHT AND BE WRONG.
 *
 *   - WINDING DECIDES WHICH SIDE IS INSIDE. Two rings wound the same way union
 *     cleanly; wound oppositely, the same code subtracts. So the winding is
 *     normalised rather than assumed, because a shape drawn clockwise and one
 *     drawn anticlockwise look identical on screen.
 *
 *   - DISJOINT SHAPES HAVE NO INTERSECTIONS AT ALL. A clipper that requires one
 *     returns empty for a union of two separate squares - which is not a union,
 *     it is a deletion. The no-crossing cases are decided by containment
 *     instead, and every operation has its own answer for them.
 *
 *   - A POINT EXACTLY ON AN EDGE is neither in nor out, and floating point puts
 *     points there constantly. Every containment test uses a small tolerance,
 *     and a vertex that lands on the other ring is treated as touching rather
 *     than crossing - otherwise a rectangle union with itself produces a
 *     zero-area sliver.
 *
 *   - THE RESULT OF A DIFFERENCE CAN BE NOTHING. Subtracting a shape that
 *     covers another leaves an empty result, and an empty result is a real
 *     answer. Returning the original instead makes the operation appear to do
 *     nothing, which somebody will press again.
 *
 *   - AN OPERATION THAT CANNOT BE DONE MUST SAY SO. Returning the inputs
 *     unchanged is indistinguishable from a button that is not wired up.
 */

import { type Point, type Shape, type Transform, applyTransform, localPoints } from './model.js';

export type BooleanOperation = 'union' | 'difference' | 'intersection' | 'exclusion';

export interface BooleanResult {
  readonly ok: true;
  /** The rings of the result. Empty means the operation genuinely erased it. */
  readonly rings: readonly (readonly Point[])[];
  /** True when a curve was flattened, so the caller can say it was approximated. */
  readonly approximated: boolean;
}

export interface BooleanRefusal {
  readonly ok: false;
  readonly reason: string;
}

const EPSILON = 1e-9;
const NEAR = 1e-6;

/** A shape's outline in DRAWING space, so two shapes can be compared at all. */
export function outlineOf(shape: Shape): readonly Point[] {
  return localPoints(shape).map((point) => applyTransform(shape.transform, point));
}

/** Twice the signed area. Positive is anticlockwise in a Y-down space. */
export function signedArea(ring: readonly Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index] as Point;
    const b = ring[(index + 1) % ring.length] as Point;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/**
 * Normalise winding.
 *
 * Two rings wound the same way union cleanly; wound oppositely the same walk
 * subtracts. A shape drawn clockwise and one drawn anticlockwise look identical
 * on screen, so this cannot be left to the caller.
 */
export function normaliseWinding(ring: readonly Point[]): readonly Point[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

/**
 * Whether a point is inside a ring, by the even-odd rule.
 *
 * A point exactly ON an edge is reported as inside. Floating point puts points
 * there constantly, and calling them outside makes a shape union with itself
 * produce a sliver of nothing.
 */
export function contains(ring: readonly Point[], point: Point): boolean {
  if (onBoundary(ring, point)) return true;

  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index] as Point;
    const b = ring[previous] as Point;
    const crosses = a.y > point.y !== b.y > point.y;
    if (!crosses) continue;
    const at = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (point.x < at) inside = !inside;
  }
  return inside;
}

function onBoundary(ring: readonly Point[], point: Point): boolean {
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index] as Point;
    const b = ring[(index + 1) % ring.length] as Point;
    if (distanceToSegment(point, a, b) <= NEAR) return true;
  }
  return false;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);

  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

interface Crossing {
  readonly point: Point;
  /** Position along the subject edge, 0..1. */
  readonly subjectT: number;
  readonly subjectEdge: number;
  readonly clipT: number;
  readonly clipEdge: number;
}

/** Where two segments cross, or null when they do not. */
function crossing(a1: Point, a2: Point, b1: Point, b2: Point): { point: Point; t: number; u: number } | null {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;

  const denominator = dax * dby - day * dbx;
  // Parallel, including collinear. A collinear overlap is a touch rather than a
  // crossing, and treating it as a crossing produces duplicated vertices that
  // fold the result inside out.
  if (Math.abs(denominator) < EPSILON) return null;

  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denominator;
  const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denominator;

  if (t < -NEAR || t > 1 + NEAR || u < -NEAR || u > 1 + NEAR) return null;
  return { point: { x: a1.x + t * dax, y: a1.y + t * day }, t, u };
}

function allCrossings(subject: readonly Point[], clip: readonly Point[]): Crossing[] {
  const found: Crossing[] = [];
  for (let s = 0; s < subject.length; s += 1) {
    const a1 = subject[s] as Point;
    const a2 = subject[(s + 1) % subject.length] as Point;
    for (let c = 0; c < clip.length; c += 1) {
      const b1 = clip[c] as Point;
      const b2 = clip[(c + 1) % clip.length] as Point;
      const hit = crossing(a1, a2, b1, b2);
      if (hit === null) continue;
      found.push({
        point: hit.point,
        subjectT: hit.t,
        subjectEdge: s,
        clipT: hit.u,
        clipEdge: c,
      });
    }
  }
  return found;
}

/**
 * Combine two rings.
 *
 * The disjoint and nested cases are decided by CONTAINMENT rather than by the
 * walk, because they produce no crossings at all - and a clipper that needs one
 * returns empty for a union of two separate squares, which is a deletion rather
 * than a union.
 */
export function combine(
  subjectRing: readonly Point[],
  clipRing: readonly Point[],
  operation: BooleanOperation,
): BooleanResult | BooleanRefusal {
  if (subjectRing.length < 3 || clipRing.length < 3) {
    return { ok: false, reason: 'both shapes need at least three points to combine' };
  }

  const subject = normaliseWinding(subjectRing);
  const clip = normaliseWinding(clipRing);

  // IDENTICAL RINGS, decided before the walk. Every corner of one lies exactly
  // on the other, so the crossing walk finds a crossing at each and traces the
  // outline TWICE - a ring of double the area that draws correctly and measures
  // wrong, which is the worst kind. Duplicating a shape and combining it with
  // its copy is an ordinary thing to do, so this is a real case rather than a
  // curiosity.
  if (sameRing(subject, clip)) {
    switch (operation) {
      case 'union':
      case 'intersection':
        return { ok: true, rings: [subject], approximated: false };
      case 'difference':
      case 'exclusion':
        // Nothing is left, and nothing is a real answer.
        return { ok: true, rings: [], approximated: false };
      default:
        return { ok: true, rings: [subject], approximated: false };
    }
  }

  const crossings = allCrossings(subject, clip);

  if (crossings.length === 0) {
    return { ok: true, rings: disjoint(subject, clip, operation), approximated: false };
  }

  // Build both rings with the crossings spliced in, so the walk can hop
  // between them at the same coordinates.
  const subjectPath = spliceCrossings(subject, crossings, 'subject');
  const clipPath = spliceCrossings(clip, crossings, 'clip');

  const rings = walk(subjectPath, clipPath, subject, clip, operation);
  return { ok: true, rings, approximated: false };
}

interface Vertex {
  readonly point: Point;
  readonly isCrossing: boolean;
}

function spliceCrossings(
  ring: readonly Point[],
  crossings: readonly Crossing[],
  side: 'subject' | 'clip',
): Vertex[] {
  const out: Vertex[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    out.push({ point: ring[index] as Point, isCrossing: false });

    const onThisEdge = crossings
      .filter((entry) => (side === 'subject' ? entry.subjectEdge : entry.clipEdge) === index)
      .sort(
        (one, two) =>
          (side === 'subject' ? one.subjectT : one.clipT) -
          (side === 'subject' ? two.subjectT : two.clipT),
      );

    for (const entry of onThisEdge) out.push({ point: entry.point, isCrossing: true });
  }
  return out;
}

/**
 * Walk the two paths, hopping to the other one at every crossing.
 *
 * THE HOP IS THE WHOLE ALGORITHM, and leaving it out is the failure this
 * function was rewritten to remove: filtering each ring for the vertices worth
 * keeping and then concatenating the two runs produces a ring that happens to
 * be right when the runs join end to end, and a self-crossing tangle whenever
 * they do not. Two rectangles overlapping at a diagonal came out with a
 * diagonal slice through the middle of them and an area eight per cent short,
 * while every check that counted shapes and read the status line stayed green.
 */
function walk(
  subjectPath: readonly Vertex[],
  clipPath: readonly Vertex[],
  subject: readonly Point[],
  clip: readonly Point[],
  operation: BooleanOperation,
): (readonly Point[])[] {
  if (operation === 'exclusion') {
    // Exclusion is the union minus the intersection. Expressed as two rings
    // rather than one, because the result genuinely can be two pieces and
    // flattening them into one ring draws a line between them that is not
    // there.
    const outer = combine(subject, clip, 'union');
    const inner = combine(subject, clip, 'intersection');
    const rings: (readonly Point[])[] = [];
    if (outer.ok && outer.rings[0] !== undefined) rings.push(outer.rings[0]);
    if (inner.ok && inner.rings[0] !== undefined) rings.push(inner.rings[0]);
    return rings;
  }

  // Which side of the other ring each path keeps. Union keeps what lies
  // outside, intersection what lies inside, and a difference keeps the
  // subject's outside together with the clip's inside - the hole it cuts.
  const wantSubjectInside = operation === 'intersection';
  const wantClipInside = operation !== 'union';

  // A difference walks the clip BACKWARDS, because the hole it cuts winds the
  // opposite way from the outline and walking it forwards folds the result
  // inside out.
  const clipStep = operation === 'difference' ? -1 : 1;

  const sides = {
    subject: { path: subjectPath, step: 1, want: wantSubjectInside },
    clip: { path: clipPath, step: clipStep, want: wantClipInside },
  } as const;

  const wrap = (length: number, index: number): number =>
    ((index % length) + length) % length;

  const at = (path: readonly Vertex[], index: number): Vertex => {
    const vertex = path[wrap(path.length, index)];
    if (vertex === undefined) throw new Error('walked an empty path');
    return vertex;
  };

  const crossingIndex = (path: readonly Vertex[], point: Point): number =>
    path.findIndex(
      (vertex) =>
        vertex.isCrossing && Math.hypot(vertex.point.x - point.x, vertex.point.y - point.y) < NEAR,
    );

  const visited = new Set<number>();
  const rings: (readonly Point[])[] = [];

  for (let seed = 0; seed < subjectPath.length; seed += 1) {
    const first = at(subjectPath, seed);
    if (!first.isCrossing || visited.has(seed)) continue;
    visited.add(seed);

    // Which path LEAVES this crossing on the side being kept. Judged by the
    // midpoint of the next segment rather than by its far end, because that end
    // is frequently another crossing sitting exactly on the boundary, where a
    // containment test can honestly answer either way.
    const after = at(subjectPath, seed + sides.subject.step).point;
    const middle = { x: (first.point.x + after.x) / 2, y: (first.point.y + after.y) / 2 };
    const startsOnSubject = contains(clip, middle) === sides.subject.want;

    let side: 'subject' | 'clip' = startsOnSubject ? 'subject' : 'clip';
    let index = startsOnSubject ? seed : crossingIndex(clipPath, first.point);
    if (index < 0) continue;

    const ring: Point[] = [];
    // Bounded, because a malformed pair of rings would otherwise spin here for
    // ever, and a hang is far harder to diagnose than a wrong shape.
    const cap = (subjectPath.length + clipPath.length) * 4;

    for (let step = 0; step < cap; step += 1) {
      const current = sides[side];
      ring.push(at(current.path, index).point);

      index += current.step;
      const next = at(current.path, index);
      if (!next.isCrossing) continue;

      if (side === 'subject') visited.add(wrap(subjectPath.length, index));
      if (
        Math.hypot(next.point.x - first.point.x, next.point.y - first.point.y) < NEAR
      ) {
        break;
      }

      // Hop to the same crossing on the other path. The point itself is pushed
      // by the next turn of the loop, so it lands in the ring exactly once.
      const other = side === 'subject' ? 'clip' : 'subject';
      const jumped = crossingIndex(sides[other].path, next.point);
      if (jumped < 0) break;
      side = other;
      index = jumped;
      if (side === 'subject') visited.add(wrap(subjectPath.length, index));
    }

    const cleaned = dedupe(ring);
    if (cleaned.length >= 3) rings.push(cleaned);
  }

  return rings;
}

/**
 * The cases with no crossings at all.
 *
 * Every operation has its own answer here, and none of them is "give up".
 */
function disjoint(
  subject: readonly Point[],
  clip: readonly Point[],
  operation: BooleanOperation,
): (readonly Point[])[] {
  const subjectInClip = subject.every((point) => contains(clip, point));
  const clipInSubject = clip.every((point) => contains(subject, point));

  switch (operation) {
    case 'union':
      if (subjectInClip) return [clip];
      if (clipInSubject) return [subject];
      // Separate shapes. Two rings, not one: joining them draws a line between
      // two shapes that never touched.
      return [subject, clip];

    case 'intersection':
      if (subjectInClip) return [subject];
      if (clipInSubject) return [clip];
      // Nothing in common is an EMPTY result, and empty is a real answer.
      return [];

    case 'difference':
      // Covered entirely: the result is nothing. Returning the original makes
      // the operation appear to do nothing, which somebody will press again.
      if (subjectInClip) return [];
      // A hole, which this cannot express as a single ring - reported as the
      // outline alone rather than silently drawn as though the hole were not
      // there. The caller says so.
      if (clipInSubject) return [subject];
      return [subject];

    case 'exclusion':
      if (subjectInClip || clipInSubject) return [subject, clip];
      return [subject, clip];

    default:
      return [];
  }
}

/** Whether two rings are the same outline, whatever order their points start in. */
function sameRing(one: readonly Point[], two: readonly Point[]): boolean {
  // Compared by AREA and by boundary membership rather than point for point:
  // the same outline can start at a different vertex, and a point-by-point
  // comparison calls those two different shapes.
  if (Math.abs(Math.abs(signedArea(one)) - Math.abs(signedArea(two))) > NEAR) return false;
  return (
    one.every((point) => onBoundary(two, point)) && two.every((point) => onBoundary(one, point))
  );
}

/** Drop consecutive duplicates, which a splice produces at every crossing. */
function dedupe(ring: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of ring) {
    const last = out[out.length - 1];
    if (last !== undefined && Math.hypot(last.x - point.x, last.y - point.y) < NEAR) continue;
    out.push(point);
  }
  // The closing point too, or the ring ends where it began and the fill rule
  // sees a duplicate vertex.
  const first = out[0];
  const last = out[out.length - 1];
  if (
    out.length > 1 &&
    first !== undefined &&
    last !== undefined &&
    Math.hypot(first.x - last.x, first.y - last.y) < NEAR
  ) {
    out.pop();
  }
  return out;
}

/**
 * Combine two SHAPES, in drawing space.
 *
 * Refuses rather than approximating what it cannot do. Returning the inputs
 * unchanged would be indistinguishable from a button that is not wired up.
 */
export function combineShapes(
  subject: Shape,
  clip: Shape,
  operation: BooleanOperation,
): BooleanResult | BooleanRefusal {
  if (subject.kind === 'text' || clip.kind === 'text') {
    return { ok: false, reason: 'text has no outline to combine; convert it to a path first' };
  }
  if (subject.kind === 'line' || clip.kind === 'line') {
    return { ok: false, reason: 'a line encloses no area, so there is nothing to combine' };
  }
  if (subject.locked || clip.locked) {
    return { ok: false, reason: 'one of these shapes is locked. Unlock it to combine it.' };
  }

  const subjectRing = outlineOf(subject);
  const clipRing = outlineOf(clip);

  const result = combine(subjectRing, clipRing, operation);
  if (!result.ok) return result;

  // An ellipse is approximated by its outline points, so the result is close
  // rather than exact. Said out loud so nobody measures it and finds it off.
  const approximated = subject.kind === 'ellipse' || clip.kind === 'ellipse';
  return { ...result, approximated };
}

/** The identity transform, for a shape built from an already-placed ring. */
export const PLACED: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
