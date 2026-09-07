/**
 * Selection handles: where they are, and what dragging one does.
 *
 * Pure geometry, so the hard part is testable without a pointer. The surface
 * draws the handles and reports drags; every decision about what a drag MEANS
 * is here.
 *
 * SIX THINGS THAT LOOK RIGHT AND ARE WRONG.
 *
 *   - THE OPPOSITE CORNER IS THE ANCHOR. Dragging the bottom-right must keep
 *     the top-left where it is. A resize that scales about the centre moves the
 *     shape as well as sizing it, and the user chases it across the canvas.
 *
 *   - AN EDGE HANDLE CHANGES ONE AXIS. Dragging the right edge must not move
 *     the top, and a handle that resizes both is the commonest reason a careful
 *     drag ends up crooked.
 *
 *   - A DRAG PAST THE ANCHOR FLIPS THE SHAPE. Clamping to a minimum size
 *     instead makes the shape stick at one pixel and refuse to follow the
 *     pointer, which reads as the application freezing.
 *
 *   - ZERO IS NOT A VALID SIZE, BUT IT IS A VALID MOMENT. A drag passes
 *     through zero width on its way to flipping, and a resize that divides by
 *     the old size produces Infinity exactly then - so the shape vanishes at
 *     the instant the pointer crosses the anchor.
 *
 *   - A ROTATED SHAPE RESIZES IN ITS OWN SPACE. Applying a drag in screen
 *     space to a rotated shape shears it, which is a change nobody asked for
 *     and cannot be undone by dragging back.
 *
 *   - A LOCKED SHAPE SHOWS ITS HANDLES AND REFUSES THEM. Hiding them makes a
 *     locked shape look unselected; letting them work makes the lock a
 *     decoration.
 */

import {
  type Bounds,
  type Point,
  type Shape,
  boundsOf,
} from './model.js';

export type HandleName =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'right'
  | 'bottomRight'
  | 'bottom'
  | 'bottomLeft'
  | 'left'
  | 'rotate';

export interface Handle {
  readonly name: HandleName;
  readonly x: number;
  readonly y: number;
  /** The CSS cursor for this handle, so the pointer says what a drag will do. */
  readonly cursor: string;
  /** What a screen reader is told, since a handle is a control. */
  readonly label: string;
}

/** How far above the shape the rotate handle sits, in drawing units. */
const ROTATE_OFFSET = 24;

const CURSORS: Record<HandleName, string> = {
  topLeft: 'nwse-resize',
  top: 'ns-resize',
  topRight: 'nesw-resize',
  right: 'ew-resize',
  bottomRight: 'nwse-resize',
  bottom: 'ns-resize',
  bottomLeft: 'nesw-resize',
  left: 'ew-resize',
  rotate: 'grab',
};

const LABELS: Record<HandleName, string> = {
  topLeft: 'Resize from the top left',
  top: 'Resize the top edge',
  topRight: 'Resize from the top right',
  right: 'Resize the right edge',
  bottomRight: 'Resize from the bottom right',
  bottom: 'Resize the bottom edge',
  bottomLeft: 'Resize from the bottom left',
  left: 'Resize the left edge',
  rotate: 'Rotate',
};

/** The eight resize handles and the rotate handle, for a shape's bounds. */
export function handlesFor(bounds: Bounds): Handle[] {
  const midX = (bounds.left + bounds.right) / 2;
  const midY = (bounds.top + bounds.bottom) / 2;

  const positions: Record<HandleName, Point> = {
    topLeft: { x: bounds.left, y: bounds.top },
    top: { x: midX, y: bounds.top },
    topRight: { x: bounds.right, y: bounds.top },
    right: { x: bounds.right, y: midY },
    bottomRight: { x: bounds.right, y: bounds.bottom },
    bottom: { x: midX, y: bounds.bottom },
    bottomLeft: { x: bounds.left, y: bounds.bottom },
    left: { x: bounds.left, y: midY },
    // Above the shape, clear of the corner handles, so it is not a coin toss
    // which one the pointer catches.
    rotate: { x: midX, y: bounds.top - ROTATE_OFFSET },
  };

  return (Object.keys(positions) as HandleName[]).map((name) => ({
    name,
    x: (positions[name] as Point).x,
    y: (positions[name] as Point).y,
    cursor: CURSORS[name],
    label: LABELS[name],
  }));
}

/**
 * The anchor a handle resizes about: the OPPOSITE corner or edge.
 *
 * Dragging the bottom-right must keep the top-left exactly where it is. A
 * resize about the centre moves the shape as well as sizing it, and the user
 * chases it across the canvas.
 */
export function anchorFor(name: HandleName, bounds: Bounds): Point {
  switch (name) {
    case 'topLeft':
      return { x: bounds.right, y: bounds.bottom };
    case 'topRight':
      return { x: bounds.left, y: bounds.bottom };
    case 'bottomRight':
      return { x: bounds.left, y: bounds.top };
    case 'bottomLeft':
      return { x: bounds.right, y: bounds.top };
    case 'top':
      return { x: bounds.left, y: bounds.bottom };
    case 'bottom':
      return { x: bounds.left, y: bounds.top };
    case 'left':
      return { x: bounds.right, y: bounds.top };
    case 'right':
      return { x: bounds.left, y: bounds.top };
    default:
      return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  }
}

export interface ResizeResult {
  readonly bounds: Bounds;
  /** True when the drag crossed the anchor, so the shape is mirrored. */
  readonly flippedX: boolean;
  readonly flippedY: boolean;
}

export interface ResizeOptions {
  /** Keep the proportions, as a corner drag with Shift held does. */
  readonly proportional?: boolean;
}

/**
 * Where the bounds go when a handle is dragged to a point.
 *
 * An EDGE handle changes one axis only. A handle that resizes both is the
 * commonest reason a careful drag ends up crooked.
 */
export function resize(
  name: HandleName,
  bounds: Bounds,
  to: Point,
  options: ResizeOptions = {},
): ResizeResult {
  const anchor = anchorFor(name, bounds);

  const horizontal = name !== 'top' && name !== 'bottom' && name !== 'rotate';
  const vertical = name !== 'left' && name !== 'right' && name !== 'rotate';

  let left = horizontal ? Math.min(anchor.x, to.x) : bounds.left;
  let right = horizontal ? Math.max(anchor.x, to.x) : bounds.right;
  let top = vertical ? Math.min(anchor.y, to.y) : bounds.top;
  let bottom = vertical ? Math.max(anchor.y, to.y) : bounds.bottom;

  if (options.proportional === true && horizontal && vertical) {
    const width = right - left;
    const height = bottom - top;
    const originalWidth = bounds.right - bounds.left;
    const originalHeight = bounds.bottom - bounds.top;

    // Guarded: a shape with no height would divide by zero and give a ratio of
    // Infinity, which sends the other axis off the canvas.
    const ratio = originalHeight === 0 ? 1 : originalWidth / originalHeight;
    if (ratio !== 0 && width / (height === 0 ? 1 : height) > ratio) {
      const adjusted = height * ratio;
      if (to.x < anchor.x) left = anchor.x - adjusted;
      else right = anchor.x + adjusted;
    } else {
      const adjusted = ratio === 0 ? height : width / ratio;
      if (to.y < anchor.y) top = anchor.y - adjusted;
      else bottom = anchor.y + adjusted;
    }
  }

  return {
    bounds: { left, top, right, bottom },
    // A drag past the anchor FLIPS the shape rather than clamping. Clamping
    // makes it stick at one pixel and refuse to follow the pointer, which reads
    // as the application freezing.
    flippedX: horizontal && to.x < anchor.x !== bounds.right < anchor.x,
    flippedY: vertical && to.y < anchor.y !== bounds.bottom < anchor.y,
  };
}

/**
 * The scale a resize implies, as a pair of factors about the anchor.
 *
 * Zero is not a valid size but it IS a valid moment: a drag passes through zero
 * width on its way to flipping, and dividing by the old size gives Infinity
 * exactly then - so the shape vanishes at the instant the pointer crosses the
 * anchor. A zero divisor yields a factor of 1, which holds the shape still for
 * that one frame instead.
 */
export function scaleFor(from: Bounds, to: Bounds): { x: number; y: number } {
  const fromWidth = from.right - from.left;
  const fromHeight = from.bottom - from.top;
  return {
    x: Math.abs(fromWidth) < 1e-9 ? 1 : (to.right - to.left) / fromWidth,
    y: Math.abs(fromHeight) < 1e-9 ? 1 : (to.bottom - to.top) / fromHeight,
  };
}

/** The angle from a centre to a point, in radians, measured from straight up. */
export function angleTo(centre: Point, point: Point): number {
  return Math.atan2(point.x - centre.x, centre.y - point.y);
}

export interface HandleHit {
  readonly handle: Handle;
  readonly distance: number;
}

/**
 * The handle under a point, if any.
 *
 * The tolerance is in DRAWING units and is passed in, because a handle that is
 * eight pixels wide on screen is eight divided by the zoom in the drawing - and
 * a fixed tolerance makes handles impossible to grab when zoomed out.
 */
export function handleAt(
  bounds: Bounds,
  point: Point,
  tolerance: number,
): HandleHit | null {
  let best: HandleHit | null = null;

  for (const handle of handlesFor(bounds)) {
    const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
    if (distance > tolerance) continue;
    // The NEAREST, not the first. Corners overlap edge handles at small sizes,
    // and taking the first makes a corner drag behave as an edge drag.
    if (best === null || distance < best.distance) best = { handle, distance };
  }

  return best;
}

/** Whether a shape may be resized at all, and why not when it may not. */
export function resizable(shape: Shape): { ok: true } | { ok: false; reason: string } {
  if (shape.locked) {
    // The handles are still DRAWN for a locked shape - hiding them makes it
    // look unselected - and the refusal says why.
    return { ok: false, reason: shape.name + ' is locked. Unlock it to resize it.' };
  }
  if (shape.hidden) {
    return { ok: false, reason: shape.name + ' is hidden. Show it to resize it.' };
  }
  return { ok: true };
}

/** The bounds of a shape, for placing its handles. */
export function boundsForHandles(shape: Shape): Bounds {
  return boundsOf(shape);
}
