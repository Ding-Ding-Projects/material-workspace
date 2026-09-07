/**
 * The vector drawing model.
 *
 * Shapes are stored as PATHS in user space, with transforms kept separate from
 * geometry. That separation is the decision everything else depends on:
 *
 *   - Baking a rotation into the points means the shape can never be un-rotated
 *     exactly, because every bake rounds. Rotate a rectangle five times by
 *     seventy-two degrees and a baked implementation gives you a slightly
 *     crooked rectangle; a stored transform gives you the original.
 *   - It also means the ORIGINAL geometry survives editing. A rectangle that
 *     has been rotated is still a rectangle whose width can be typed into.
 *
 * Coordinates are plain numbers in a document space with an explicit size,
 * rather than screen pixels, so zooming changes one number instead of every
 * point.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * An affine transform, row-major: [a c e / b d f / 0 0 1].
 *
 * The naming follows the conventional a..f rather than being invented, so it
 * can be checked against any reference on affine geometry without translating
 * the field names first.
 */
export interface Transform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export interface Stroke {
  readonly colour: string;
  readonly width: number;
  readonly dash?: readonly number[];
  readonly cap?: 'butt' | 'round' | 'square';
  readonly join?: 'miter' | 'round' | 'bevel';
}

export interface Fill {
  readonly colour: string;
  /** 0..1. Absent is opaque. */
  readonly opacity?: number;
}

export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'polyline' | 'path' | 'text';

export interface Shape {
  readonly id: string;
  readonly kind: ShapeKind;
  /** Geometry in the shape's own space, before its transform. */
  readonly points: readonly Point[];
  /** Rectangles and ellipses need a size; a polyline does not. */
  readonly width?: number;
  readonly height?: number;
  readonly cornerRadius?: number;
  readonly text?: string;
  readonly transform: Transform;
  readonly fill?: Fill;
  readonly stroke?: Stroke;
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly name: string;
}

export interface Drawing {
  readonly schema: 'material-workspace/vector@1';
  readonly width: number;
  readonly height: number;
  /** Painted in order: index 0 is at the back. */
  readonly shapes: readonly Shape[];
}

let counter = 0;

export function newShapeId(): string {
  counter += 1;
  return 'v' + counter.toString(36);
}

export function emptyDrawing(width = 800, height = 600): Drawing {
  return { schema: 'material-workspace/vector@1', width, height, shapes: [] };
}

// ------------------------------------------------------------- transforms --

/**
 * Compose two transforms. The RIGHT one is applied first.
 *
 * That order matters and is the one people get backwards: composing a rotation
 * with a translation gives a different result depending which happens first,
 * and the wrong order sends a rotated shape flying off somewhere unexpected.
 */
export function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function translation(x: number, y: number): Transform {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaling(x: number, y: number): Transform {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

export function rotation(radians: number): Transform {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** Rotate about a point rather than about the origin. */
export function rotationAbout(radians: number, centre: Point): Transform {
  return compose(
    translation(centre.x, centre.y),
    compose(rotation(radians), translation(-centre.x, -centre.y)),
  );
}

export function applyTransform(transform: Transform, point: Point): Point {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  };
}

/**
 * The inverse, or undefined when the transform is degenerate.
 *
 * A zero determinant means the transform has collapsed the plane to a line, so
 * there is no inverse — returning an approximation there produces coordinates
 * that look plausible and are meaningless. Callers must handle undefined.
 */
export function invert(transform: Transform): Transform | undefined {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (determinant === 0 || !Number.isFinite(determinant)) return undefined;
  return {
    a: transform.d / determinant,
    b: -transform.b / determinant,
    c: -transform.c / determinant,
    d: transform.a / determinant,
    e: (transform.c * transform.f - transform.d * transform.e) / determinant,
    f: (transform.b * transform.e - transform.a * transform.f) / determinant,
  };
}

// ----------------------------------------------------------------- bounds --

export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The geometry a shape occupies in its OWN space, before its transform. */
export function localPoints(shape: Shape): Point[] {
  switch (shape.kind) {
    case 'rectangle':
    case 'ellipse':
    case 'text': {
      const width = shape.width ?? 0;
      const height = shape.height ?? 0;
      return [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ];
    }
    default:
      return [...shape.points];
  }
}

/**
 * The axis-aligned bounds after the transform.
 *
 * Transforming the bounding box's corners is NOT the same as bounding the
 * transformed shape for a curve, but for the polygonal outlines here it is
 * exact — and for an ellipse it is the bounding box of its own bounding box,
 * which is what a selection rectangle should show anyway.
 */
export function boundsOf(shape: Shape): Bounds {
  const points = localPoints(shape).map((point) => applyTransform(shape.transform, point));
  if (points.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.x > right) right = point.x;
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }
  return { left, top, right, bottom };
}

export function unionBounds(shapes: readonly Shape[]): Bounds | undefined {
  if (shapes.length === 0) return undefined;
  let result: Bounds | undefined;
  for (const shape of shapes) {
    const bounds = boundsOf(shape);
    result =
      result === undefined
        ? bounds
        : {
            left: Math.min(result.left, bounds.left),
            top: Math.min(result.top, bounds.top),
            right: Math.max(result.right, bounds.right),
            bottom: Math.max(result.bottom, bounds.bottom),
          };
  }
  return result;
}

export function centreOf(bounds: Bounds): Point {
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}

// ------------------------------------------------------------- hit testing --

/**
 * Is the point inside this shape?
 *
 * The point is transformed into the SHAPE's space rather than the shape being
 * transformed into the point's. One inverse per shape beats transforming every
 * one of its points, and it means the containment test itself only ever deals
 * with un-rotated geometry — which is the difference between a few lines and a
 * rotated-polygon intersection.
 */
export function hitTest(shape: Shape, point: Point): boolean {
  if (shape.hidden) return false;

  const inverse = invert(shape.transform);
  if (inverse === undefined) return false;
  const local = applyTransform(inverse, point);

  switch (shape.kind) {
    case 'rectangle':
    case 'text':
      return (
        local.x >= 0 &&
        local.y >= 0 &&
        local.x <= (shape.width ?? 0) &&
        local.y <= (shape.height ?? 0)
      );
    case 'ellipse': {
      const width = shape.width ?? 0;
      const height = shape.height ?? 0;
      if (width === 0 || height === 0) return false;
      const nx = (local.x - width / 2) / (width / 2);
      const ny = (local.y - height / 2) / (height / 2);
      return nx * nx + ny * ny <= 1;
    }
    case 'line':
    case 'polyline':
    case 'path':
      return nearPolyline(shape.points, local, Math.max(shape.stroke?.width ?? 1, 6) / 2);
    default:
      return false;
  }
}

/**
 * Distance from a point to a polyline, within a tolerance.
 *
 * The tolerance is at least three pixels regardless of stroke width, because a
 * one-pixel line that can only be selected by hitting it exactly is a line
 * nobody can select.
 */
function nearPolyline(points: readonly Point[], point: Point, tolerance: number): boolean {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index] as Point;
    const end = points[index + 1] as Point;
    if (distanceToSegment(point, start, end) <= tolerance) return true;
  }
  return false;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);

  // Projection parameter, clamped to the segment. Without the clamp this
  // measures to the infinite LINE, so a point far beyond the end of a short
  // segment reads as being right on it.
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = Math.min(Math.max(t, 0), 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/**
 * The topmost shape at a point.
 *
 * Searched from the FRONT backwards, because the shape painted last is the one
 * the user sees there and therefore the one they mean. Searching forwards
 * selects whatever is underneath.
 */
export function shapeAt(drawing: Drawing, point: Point): Shape | undefined {
  for (let index = drawing.shapes.length - 1; index >= 0; index -= 1) {
    const shape = drawing.shapes[index] as Shape;
    if (shape.locked || shape.hidden) continue;
    if (hitTest(shape, point)) return shape;
  }
  return undefined;
}

// ---------------------------------------------------------------- ordering --

export type ArrangeAction = 'front' | 'back' | 'forward' | 'backward';

export function arrange(
  drawing: Drawing,
  id: string,
  action: ArrangeAction,
): Drawing {
  const index = drawing.shapes.findIndex((shape) => shape.id === id);
  if (index < 0) return drawing;

  const shapes = [...drawing.shapes];
  const [shape] = shapes.splice(index, 1);
  if (shape === undefined) return drawing;

  const target =
    action === 'front'
      ? shapes.length
      : action === 'back'
        ? 0
        : action === 'forward'
          ? Math.min(index + 1, shapes.length)
          : Math.max(index - 1, 0);

  shapes.splice(target, 0, shape);
  return { ...drawing, shapes };
}

// ------------------------------------------------------------------- SVG --

/**
 * The drawing as SVG.
 *
 * SVG rather than a private format because it is what every other tool reads,
 * and because a drawing exported to something nothing else opens is a drawing
 * that is trapped.
 */
export function toSvg(drawing: Drawing): string {
  const body = drawing.shapes
    .filter((shape) => !shape.hidden)
    .map((shape) => shapeToSvg(shape))
    .join('\n  ');

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      drawing.width +
      '" height="' +
      drawing.height +
      '" viewBox="0 0 ' +
      drawing.width +
      ' ' +
      drawing.height +
      '">',
    '  ' + body,
    '</svg>',
  ].join('\n');
}

function transformAttribute(transform: Transform): string {
  const { a, b, c, d, e, f } = transform;
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return '';
  return ' transform="matrix(' + [a, b, c, d, e, f].map(round).join(' ') + ')"';
}

function round(value: number): number {
  // Three decimal places. More is noise from floating point; fewer is visible
  // drift on a large canvas.
  return Math.round(value * 1000) / 1000;
}

function paintAttributes(shape: Shape): string {
  const parts: string[] = [];
  parts.push(' fill="' + (shape.fill?.colour ?? 'none') + '"');
  if (shape.fill?.opacity !== undefined) {
    parts.push(' fill-opacity="' + shape.fill.opacity + '"');
  }
  if (shape.stroke !== undefined) {
    parts.push(' stroke="' + shape.stroke.colour + '"');
    parts.push(' stroke-width="' + shape.stroke.width + '"');
    if (shape.stroke.dash !== undefined && shape.stroke.dash.length > 0) {
      parts.push(' stroke-dasharray="' + shape.stroke.dash.join(' ') + '"');
    }
    if (shape.stroke.cap !== undefined) parts.push(' stroke-linecap="' + shape.stroke.cap + '"');
    if (shape.stroke.join !== undefined) parts.push(' stroke-linejoin="' + shape.stroke.join + '"');
  }
  return parts.join('');
}

function escapeXml(text: string): string {
  return text
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split(String.fromCharCode(34))
    .join('&quot;');
}

function shapeToSvg(shape: Shape): string {
  const common = transformAttribute(shape.transform) + paintAttributes(shape);

  switch (shape.kind) {
    case 'rectangle':
      return (
        '<rect x="0" y="0" width="' +
        round(shape.width ?? 0) +
        '" height="' +
        round(shape.height ?? 0) +
        '"' +
        (shape.cornerRadius !== undefined && shape.cornerRadius > 0
          ? ' rx="' + round(shape.cornerRadius) + '"'
          : '') +
        common +
        '/>'
      );
    case 'ellipse': {
      const rx = (shape.width ?? 0) / 2;
      const ry = (shape.height ?? 0) / 2;
      return (
        '<ellipse cx="' +
        round(rx) +
        '" cy="' +
        round(ry) +
        '" rx="' +
        round(rx) +
        '" ry="' +
        round(ry) +
        '"' +
        common +
        '/>'
      );
    }
    case 'text':
      return (
        '<text x="0" y="' +
        round(shape.height ?? 16) +
        '"' +
        common +
        '>' +
        escapeXml(shape.text ?? '') +
        '</text>'
      );
    default: {
      const points = shape.points.map((point) => round(point.x) + ',' + round(point.y)).join(' ');
      // A polyline rather than a polygon: a polygon closes itself, which
      // silently adds a segment the user never drew.
      return '<polyline points="' + points + '"' + common + '/>';
    }
  }
}
