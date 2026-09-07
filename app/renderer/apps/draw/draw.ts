/**
 * Draw.
 *
 * Rendered as real SVG elements rather than to a canvas. Three reasons, and
 * the third is the one that decided it:
 *
 *   - Each shape is a DOM node, so it has a role, an accessible name and a
 *     focus ring for free. A canvas drawing is a single opaque rectangle to
 *     assistive technology, and making it accessible means rebuilding an
 *     accessibility tree by hand alongside it.
 *   - Zooming is one attribute on the root, not a re-render of everything.
 *   - The export IS the rendering. There is no second code path that draws the
 *     file differently from the screen, which is where a drawing application
 *     usually accumulates its subtle differences between what you see and what
 *     you get.
 *
 * The cost is that a drawing of many thousands of shapes would be slow. That
 * is a real limit and it is stated in the documentation rather than hidden.
 */

import { clear, el } from '../../dom.js';
import {
  EMPTY as NO_SELECTION,
  type Selection,
  clear as clearSelection,
  describePlan,
  extend,
  invert,
  plan,
  selectAll,
  toggle as toggle_,
} from '../../../shared/bulk.js';
import { PLACED, combineShapes } from '../../../engines/vector/boolean.js';
import { angleTo, handleAt, handlesFor, resizable, resize, scaleFor }
  from '../../../engines/vector/handles.js';
import {
  IDENTITY,
  type ArrangeAction,
  type Bounds,
  type Drawing,
  type Point,
  type Shape,
  type ShapeKind,
  arrange,
  boundsOf,
  compose,
  emptyDrawing,
  newShapeId,
  rotationAbout,
  scaling,
  shapeAt,
  toSvg,
  translation,
  unionBounds,
} from '../../../engines/vector/model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface DrawOptions {
  drawing?: Drawing;
  onChange?: (drawing: Drawing) => void;
}

type Tool = 'select' | 'rectangle' | 'ellipse' | 'line';

const TOOLS: readonly { tool: Tool; label: string; shortcut: string }[] = [
  { tool: 'select', label: 'Select', shortcut: 'V' },
  { tool: 'rectangle', label: 'Rectangle', shortcut: 'R' },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'E' },
  { tool: 'line', label: 'Line', shortcut: 'L' },
];

const PALETTE: readonly string[] = [
  '#e57373',
  '#64b5f6',
  '#81c784',
  '#ffd54f',
  '#ba68c8',
  '#4dd0e1',
  '#ffffff',
  '#212121',
];

export class Draw {
  readonly element: HTMLElement;

  private drawing: Drawing;
  private readonly options: DrawOptions;

  private tool: Tool = 'select';
  private selected: string | null = null;
  /**
   * The bulk selection, separate from the shape being EDITED.
   *
   * Conflating them means a bulk delete also moves what the canvas is showing
   * mid-action, and the editor jumps to something nobody chose.
   */
  private marked: Selection = NO_SELECTION;

  /**
   * Combine exactly two marked shapes.
   *
   * Two, not "the selection": a boolean of three shapes has an order and the
   * order changes the answer, so asking for two is honest rather than picking
   * one silently.
   */
  private combineMarked(operation: 'union' | 'difference' | 'intersection'): void {
    const chosen = this.drawing.shapes.filter((shape) => this.marked.chosen.has(shape.id));
    if (chosen.length !== 2) {
      this.setStatus(
        'Mark exactly two shapes to combine. ' + chosen.length +
          (chosen.length === 1 ? ' is marked.' : ' are marked.'),
      );
      return;
    }

    // The one nearer the FRONT is the subject, so subtracting takes the shape
    // on top out of the one beneath - which is what somebody looking at the
    // canvas means by it.
    const [back, front] = chosen;
    if (back === undefined || front === undefined) return;

    const result = combineShapes(back, front, operation);
    if (!result.ok) {
      this.setStatus(result.reason);
      return;
    }

    if (result.rings.length === 0) {
      // An empty result is a REAL answer: subtracting a shape that covers
      // another leaves nothing. Refusing to apply it would make the button
      // appear broken.
      this.drawing = {
        ...this.drawing,
        shapes: this.drawing.shapes.filter((shape) => !this.marked.chosen.has(shape.id)),
      };
      this.marked = NO_SELECTION;
      this.selected = null;
      this.commit();
      this.setStatus('The result is empty, so both shapes were removed.');
      return;
    }

    const combined = result.rings.map((ring, index) => ({
      id: newShapeId(),
      kind: 'polyline' as const,
      points: [...ring],
      transform: PLACED,
      ...(back.fill === undefined ? {} : { fill: back.fill }),
      ...(back.stroke === undefined ? {} : { stroke: back.stroke }),
      locked: false,
      hidden: false,
      name:
        operation === 'union'
          ? 'Union'
          : operation === 'difference'
            ? 'Subtracted'
            : 'Intersection',
      ...(result.rings.length > 1 ? { name: 'Piece ' + (index + 1) } : {}),
    }));

    this.drawing = {
      ...this.drawing,
      shapes: [
        ...this.drawing.shapes.filter((shape) => !this.marked.chosen.has(shape.id)),
        ...combined,
      ],
    };
    this.marked = NO_SELECTION;
    this.selected = combined[0]?.id ?? null;
    this.commit();

    this.setStatus(
      combined.length === 1
        ? 'Combined into one shape.' +
          (result.approximated
            ? ' An ellipse was approximated by its outline, so the edge is close rather than exact.'
            : '')
        : 'Combined into ' + combined.length + ' separate pieces, because the shapes do not touch.',
    );
  }
  private fill = '#64b5f6';
  private stroke = '#212121';

  /** Set while a drag is creating or moving a shape. */
  private dragFrom: Point | null = null;
  private dragMode: 'create' | 'move' | 'resize' | null = null;
  private dragHandle: string | null = null;
  private dragBounds: Bounds | null = null;
  private dragOriginal: Shape | null = null;

  private readonly toolbar: HTMLElement;
  private readonly paletteBar: HTMLElement;
  private readonly canvas: SVGSVGElement;
  private readonly layerList: HTMLElement;
  private readonly statusLine: HTMLElement;

  constructor(options: DrawOptions = {}) {
    this.options = options;
    this.drawing = options.drawing ?? emptyDrawing();

    this.toolbar = el('div', { class: 'draw__toolbar', role: 'toolbar', 'aria-label': 'Tools' });
    this.paletteBar = el('div', {
      class: 'draw__palette',
      role: 'group',
      'aria-label': 'Colours',
    });
    this.layerList = el('div', {
      class: 'draw__layers',
      role: 'listbox',
      'aria-label': 'Shapes, front to back',
    });
    this.statusLine = el('div', {
      class: 'draw__status',
      role: 'status',
      'aria-live': 'polite',
    });

    this.canvas = document.createElementNS(SVG_NS, 'svg');
    this.canvas.setAttribute('class', 'draw__canvas');
    this.canvas.setAttribute('viewBox', '0 0 ' + this.drawing.width + ' ' + this.drawing.height);
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', 'Drawing canvas');
    this.canvas.setAttribute('tabindex', '0');

    this.element = el('div', { class: 'draw' }, [
      this.toolbar,
      this.paletteBar,
      el('div', { class: 'draw__body' }, [
        el('div', { class: 'draw__stage' }, [this.canvas as unknown as HTMLElement]),
        this.layerList,
      ]),
      this.statusLine,
    ]);

    this.buildToolbar();
    this.buildPalette();
    this.wire();
    this.render();
  }

  private buildToolbar(): void {
    clear(this.toolbar);
    for (const entry of TOOLS) {
      this.toolbar.append(
        el(
          'button',
          {
            class: 'draw__tool',
            type: 'button',
            'data-tool': entry.tool,
            'aria-pressed': entry.tool === this.tool ? 'true' : 'false',
            // The shortcut that actually works, where people look for it.
            title: entry.label + '  ' + entry.shortcut,
            'aria-keyshortcuts': entry.shortcut,
          },
          [entry.label],
        ),
      );
    }

    for (const [action, label] of [
      ['front', 'Bring to front'],
      ['forward', 'Forward'],
      ['backward', 'Backward'],
      ['back', 'Send to back'],
    ] as const) {
      this.toolbar.append(
        el(
          'button',
          { class: 'draw__action', type: 'button', 'data-arrange': action },
          [label],
        ),
      );
    }

    this.toolbar.append(
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'delete' }, ['Delete']),
      // Bulk actions from the shared model, so a locked shape is KEPT and
      // named rather than silently skipped.
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'union' }, [
        'Union',
      ]),
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'subtract' }, [
        'Subtract',
      ]),
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'intersect' }, [
        'Intersect',
      ]),
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'select-all' }, [
        'Select all',
      ]),
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'invert' }, ['Invert']),
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'delete-marked' }, [
        'Delete selected',
      ]),
      el('button', { class: 'draw__action', type: 'button', 'data-action': 'export' }, [
        'Export as SVG',
      ]),
    );
  }

  private buildPalette(): void {
    clear(this.paletteBar);
    this.paletteBar.append(el('span', { class: 'draw__palette-label' }, ['Fill']));
    for (const colour of PALETTE) {
      this.paletteBar.append(
        el('button', {
          class: 'draw__swatch',
          type: 'button',
          'data-role': 'fill',
          'data-colour': colour,
          // The colour is in the accessible name, not only in the swatch: a
          // grid of unnamed coloured squares is unusable with a screen reader.
          'aria-label': 'Fill colour ' + colour,
          title: colour,
          style: 'background:' + colour,
        }),
      );
    }
    this.paletteBar.append(el('span', { class: 'draw__palette-label' }, ['Line']));
    for (const colour of PALETTE) {
      this.paletteBar.append(
        el('button', {
          class: 'draw__swatch',
          type: 'button',
          'data-role': 'stroke',
          'data-colour': colour,
          'aria-label': 'Line colour ' + colour,
          title: colour,
          style: 'background:' + colour,
        }),
      );
    }
  }

  private wire(): void {
    this.toolbar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('button');
      if (!target) return;

      const tool = target.getAttribute('data-tool');
      if (tool !== null) {
        this.tool = tool as Tool;
        this.buildToolbar();
        this.renderStatus();
        return;
      }

      const arrangeAction = target.getAttribute('data-arrange');
      if (arrangeAction !== null && this.selected !== null) {
        this.drawing = arrange(this.drawing, this.selected, arrangeAction as ArrangeAction);
        this.commit();
        return;
      }

      const action = target.getAttribute('data-action');
      if (action === 'delete') this.deleteSelected();
      else if (action === 'export') this.exportSvg();
      else if (action === 'select-all') {
        this.marked = selectAll(this.shapeOrder());
        this.render();
      } else if (action === 'invert') {
        this.marked = invert(this.marked, this.shapeOrder());
        this.render();
      } else if (action === 'delete-marked') this.deleteMarked();
      else if (action === 'union') this.combineMarked('union');
      else if (action === 'subtract') this.combineMarked('difference');
      else if (action === 'intersect') this.combineMarked('intersection');
    });

    this.paletteBar.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.draw__swatch');
      if (!target) return;
      const colour = target.getAttribute('data-colour') ?? '#000000';
      const role = target.getAttribute('data-role');
      if (role === 'fill') this.fill = colour;
      else this.stroke = colour;

      // Applied to the selection too, so choosing a colour with something
      // selected does the obvious thing rather than only affecting the next
      // shape drawn.
      if (this.selected !== null) {
        this.updateShape(this.selected, (shape) =>
          role === 'fill'
            ? { ...shape, fill: { colour } }
            : { ...shape, stroke: { colour, width: shape.stroke?.width ?? 2 } },
        );
      }
      this.render();
    });

    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    // Takes no event: where the pointer came up does not matter, only that
    // the drag ended. The move handler has already applied the final position.
    this.canvas.addEventListener('pointerup', () => this.onPointerUp());

    this.canvas.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.layerList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('.draw__layer');
      if (!target) return;

      const toggle = (event.target as HTMLElement).closest('[data-toggle]');
      const id = target.getAttribute('data-shape');

      // A modified click adjusts the BULK selection and leaves the canvas
      // where it is. Selecting a shape somebody was only adding to a batch
      // would move what they were looking at.
      const pointer = event as MouseEvent;
      if (toggle === null && id !== null && (pointer.ctrlKey || pointer.metaKey || pointer.shiftKey)) {
        this.marked = pointer.shiftKey
          ? extend(this.marked, id, this.shapeOrder())
          : toggle_(this.marked, id);
        this.render();
        return;
      }
      if (id === null) return;

      if (toggle !== null) {
        const which = toggle.getAttribute('data-toggle');
        // The keyboard equivalent of a control-click, and the only route that
        // works without a pointer at all.
        if (which === 'mark') {
          this.marked = toggle_(this.marked, id);
          this.render();
          return;
        }
        this.updateShape(id, (shape) =>
          which === 'hidden'
            ? { ...shape, hidden: !shape.hidden }
            : { ...shape, locked: !shape.locked },
        );
        this.render();
        return;
      }

      this.selected = id;
      this.render();
    });
  }

  /**
   * A pointer position in DRAWING coordinates.
   *
   * Read from the SVG's own client rect and scaled by the viewBox, so the
   * mapping stays correct whatever size the canvas is laid out at. Using the
   * event's offset would be in CSS pixels and would put every shape in the
   * wrong place the moment the window is resized.
   */
  private toDrawing(event: PointerEvent): Point {
    const box = this.canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    // Rounded to a hundredth. The division above lands one ULP away from a
    // whole number all the time, and that float reaches the exported SVG
    // verbatim as `translate(100 99.99999999999996)` - a real defect in a file
    // somebody opens elsewhere, not only an ugly number on screen.
    return {
      x: round(((event.clientX - box.left) / box.width) * this.drawing.width),
      y: round(((event.clientY - box.top) / box.height) * this.drawing.height),
    };
  }

  private onPointerDown(event: PointerEvent): void {
    this.canvas.focus();
    const point = this.toDrawing(event);
    this.dragFrom = point;

    // A handle is checked FIRST, because it sits on top of the shape it belongs
    // to and a hit test that asks the shape first can never reach one.
    const current = this.drawing.shapes.find((shape) => shape.id === this.selected);
    if (this.tool === 'select' && current !== undefined && !current.hidden) {
      const bounds = boundsOf(current);
      // The tolerance is in DRAWING units: a handle eight pixels wide on screen
      // is eight divided by the zoom here, and a fixed tolerance makes handles
      // impossible to grab when zoomed out.
      const box = this.canvas.getBoundingClientRect();
      const scale = box.width === 0 ? 1 : this.drawing.width / box.width;
      const hit = handleAt(bounds, point, 10 * scale);

      if (hit !== null) {
        const allowed = resizable(current);
        if (!allowed.ok) {
          this.setStatus(allowed.reason);
          this.dragFrom = null;
          return;
        }
        this.dragHandle = hit.handle.name;
        this.dragBounds = bounds;
        this.dragOriginal = current;
        this.dragMode = 'resize';
        return;
      }
    }

    if (this.tool === 'select') {
      const hit = shapeAt(this.drawing, point);
      this.selected = hit?.id ?? null;
      this.dragMode = hit === undefined ? null : 'move';
      this.dragOriginal = hit ?? null;
      this.render();
      return;
    }

    // Creating. The shape is inserted immediately at zero size and grown by
    // the drag, so the user sees it appear under the pointer rather than only
    // when the drag ends.
    const created = this.makeShape(this.tool, point, point);
    this.drawing = { ...this.drawing, shapes: [...this.drawing.shapes, created] };
    this.selected = created.id;
    this.dragMode = 'create';
    this.dragOriginal = created;
    this.render();
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragFrom === null || this.dragMode === null || this.dragOriginal === null) return;
    const point = this.toDrawing(event);

    if (this.dragMode === 'create') {
      const updated = this.makeShape(
        this.dragOriginal.kind === 'ellipse'
          ? 'ellipse'
          : this.dragOriginal.kind === 'line'
            ? 'line'
            : 'rectangle',
        this.dragFrom,
        point,
        this.dragOriginal.id,
      );
      this.drawing = {
        ...this.drawing,
        shapes: this.drawing.shapes.map((shape) =>
          shape.id === this.dragOriginal?.id ? updated : shape,
        ),
      };
    } else if (this.dragMode === 'resize' && this.dragHandle !== null && this.dragBounds !== null) {
      const original = this.dragOriginal;
      const from = this.dragBounds;

      if (this.dragHandle === 'rotate') {
        const centre = {
          x: (from.left + from.right) / 2,
          y: (from.top + from.bottom) / 2,
        };
        const angle = angleTo(centre, point);
        this.updateShape(original.id, () => ({
          ...original,
          // Composed onto the ORIGINAL transform each time rather than
          // accumulated, so a drag that wanders back and forth does not drift.
          transform: compose(rotationAbout(angle, centre), original.transform),
        }));
      } else {
        const next = resize(
          this.dragHandle as Parameters<typeof resize>[0],
          from,
          point,
          { proportional: event.shiftKey },
        );
        const scale = scaleFor(from, next.bounds);

        // Scaled ABOUT the anchor, which is the opposite corner - a scale about
        // the origin drags the shape across the canvas as it grows.
        const anchor = {
          x: next.bounds.left === from.left ? from.left : from.right,
          y: next.bounds.top === from.top ? from.top : from.bottom,
        };

        this.updateShape(original.id, () => ({
          ...original,
          transform: compose(
            compose(
              translation(anchor.x, anchor.y),
              compose(scaling(scale.x, scale.y), translation(-anchor.x, -anchor.y)),
            ),
            original.transform,
          ),
        }));
      }
    } else {
      const dx = point.x - this.dragFrom.x;
      const dy = point.y - this.dragFrom.y;
      const original = this.dragOriginal;
      this.updateShape(original.id, () => ({
        ...original,
        // The move is composed onto the ORIGINAL transform each time rather
        // than accumulated, so a drag that wanders does not drift.
        transform: {
          ...original.transform,
          e: original.transform.e + dx,
          f: original.transform.f + dy,
        },
      }));
    }

    this.renderCanvas();
    this.renderStatus();
  }

  private onPointerUp(): void {
    // Cleared FIRST, so an early return below cannot leave a handle grabbed -
    // which presents as the next click resizing something nobody touched.
    const wasResizing = this.dragMode === 'resize';
    this.dragHandle = null;
    this.dragBounds = null;
    if (wasResizing) {
      this.dragMode = null;
      this.dragFrom = null;
      this.dragOriginal = null;
      this.commit();
      this.setStatus('Resized.');
      return;
    }

    if (this.dragMode === 'create') {
      // A click with no drag makes a zero-size shape nobody can see or select
      // again. Give it a default size rather than leaving an invisible object
      // in the drawing.
      const created = this.drawing.shapes.find((shape) => shape.id === this.selected);
      if (created !== undefined && (created.width ?? 0) < 2 && (created.height ?? 0) < 2) {
        const points = created.points;
        const isLine = created.kind === 'line';
        this.updateShape(created.id, (shape) => ({
          ...shape,
          ...(isLine
            ? {
                points: [
                  points[0] ?? { x: 0, y: 0 },
                  { x: (points[0]?.x ?? 0) + 120, y: points[0]?.y ?? 0 },
                ],
              }
            : { width: 120, height: 80 }),
        }));
      }
      // Back to the select tool after drawing one shape, which is what every
      // drawing application does and what people expect.
      this.tool = 'select';
      this.buildToolbar();
    }

    this.dragFrom = null;
    this.dragMode = null;
    this.dragOriginal = null;
    this.commit();
  }

  private onKeyDown(event: KeyboardEvent): void {
    const shortcuts: Record<string, Tool> = { v: 'select', r: 'rectangle', e: 'ellipse', l: 'line' };
    const tool = shortcuts[event.key.toLowerCase()];
    if (tool !== undefined && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.tool = tool;
      this.buildToolbar();
      this.renderStatus();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelected();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.selected = null;
      this.render();
      return;
    }

    // Arrow keys nudge, which is the only way to position something precisely
    // with a pointer that snaps to whole pixels.
    const nudges: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const nudge = nudges[event.key];
    if (nudge !== undefined && this.selected !== null) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      this.updateShape(this.selected, (shape) => ({
        ...shape,
        transform: {
          ...shape.transform,
          e: shape.transform.e + nudge[0] * step,
          f: shape.transform.f + nudge[1] * step,
        },
      }));
      this.commit();
    }
  }

  private makeShape(kind: Tool, from: Point, to: Point, id?: string): Shape {
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    const shapeId = id ?? newShapeId();

    if (kind === 'line') {
      return {
        id: shapeId,
        kind: 'line',
        points: [from, to],
        transform: IDENTITY,
        stroke: { colour: this.stroke, width: 2, cap: 'round' },
        locked: false,
        hidden: false,
        name: 'Line',
      };
    }

    return {
      id: shapeId,
      kind: kind === 'ellipse' ? 'ellipse' : 'rectangle',
      points: [],
      width,
      height,
      // Position lives in the TRANSFORM, not in the geometry, so the width the
      // user typed stays the width the shape reports after it is moved.
      transform: translation(left, top),
      fill: { colour: this.fill },
      stroke: { colour: this.stroke, width: 2 },
      locked: false,
      hidden: false,
      name: kind === 'ellipse' ? 'Ellipse' : 'Rectangle',
    };
  }

  private updateShape(id: string, change: (shape: Shape) => Shape): void {
    this.drawing = {
      ...this.drawing,
      shapes: this.drawing.shapes.map((shape) => (shape.id === id ? change(shape) : shape)),
    };
  }

  /** The shapes on screen, newest first, matching the layer list's order. */
  private shapeOrder(): string[] {
    return [...this.drawing.shapes].reverse().map((shape) => shape.id);
  }

  private deleteMarked(): void {
    // Planned first, so a locked shape is kept and named. Silently skipping it
    // is indistinguishable from a delete that failed.
    const outcome = plan(
      this.drawing.shapes.map((shape) => ({ id: shape.id, shape })),
      this.marked,
      { protect: (entry) => (entry.shape.locked ? 'locked' : null), irreversible: true },
    );
    if (outcome.acting.length === 0) {
      this.setStatus(describePlan(outcome, 'deleted'));
      return;
    }
    const going = new Set(outcome.acting.map((entry) => entry.id));
    this.drawing = {
      ...this.drawing,
      shapes: this.drawing.shapes.filter((shape) => !going.has(shape.id)),
    };
    if (this.selected !== null && going.has(this.selected)) this.selected = null;
    this.marked = clearSelection();
    this.commit();
    this.setStatus(describePlan(outcome, 'deleted'));
  }

  private deleteSelected(): void {
    if (this.selected === null) return;
    const target = this.drawing.shapes.find((shape) => shape.id === this.selected);
    if (target?.locked === true) {
      this.setStatus('That shape is locked. Unlock it in the shape list first.');
      return;
    }
    this.drawing = {
      ...this.drawing,
      shapes: this.drawing.shapes.filter((shape) => shape.id !== this.selected),
    };
    this.selected = null;
    this.commit();
  }

  private exportSvg(): void {
    if (this.drawing.shapes.length === 0) {
      this.setStatus('Nothing to export yet.');
      return;
    }
    const svg = toSvg(this.drawing);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: 'drawing.svg' }) as HTMLAnchorElement;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);

    const hidden = this.drawing.shapes.filter((shape) => shape.hidden).length;
    const exported = this.drawing.shapes.length - hidden;
    this.setStatus(
      'Exported ' +
        exported +
        (exported === 1 ? ' shape' : ' shapes') +
        ' as SVG. Nothing was lost' +
        (hidden > 0
          ? '; ' + hidden + (hidden === 1 ? ' hidden shape was' : ' hidden shapes were') +
            ' not included'
          : '') +
        '.',
    );
  }

  private commit(): void {
    this.options.onChange?.(this.drawing);
    this.render();
  }

  // ------------------------------------------------------------- rendering --

  private render(): void {
    this.renderCanvas();
    this.renderLayers();
    this.renderStatus();
  }

  /**
   * The canvas.
   *
   * Rebuilt wholesale on every change. A drawing of a few hundred shapes
   * rebuilds faster than a frame, and a diffing renderer here would be a
   * second source of truth about what is on screen — which is exactly where a
   * drawing application starts disagreeing with its own export.
   */
  private renderCanvas(): void {
    while (this.canvas.firstChild) this.canvas.firstChild.remove();
    this.canvas.setAttribute('viewBox', '0 0 ' + this.drawing.width + ' ' + this.drawing.height);

    for (const shape of this.drawing.shapes) {
      if (shape.hidden) continue;
      const node = this.shapeNode(shape);
      if (node !== undefined) this.canvas.append(node);
    }

    // The selection outline is drawn LAST so it is never hidden behind a shape
    // painted after it.
    const selected = this.drawing.shapes.find((shape) => shape.id === this.selected);
    if (selected !== undefined && !selected.hidden) {
      const bounds = boundsOf(selected);
      this.canvas.append(this.selectionNode(bounds));

      // Handles are drawn for a LOCKED shape too. Hiding them makes a locked
      // shape look unselected; what the lock does is refuse the drag, and it
      // says why when it does.
      for (const handle of handlesFor(bounds)) {
        this.canvas.append(this.handleNode(handle, selected.locked));
      }
    }
  }

  private handleNode(
    handle: { name: string; x: number; y: number; cursor: string; label: string },
    locked: boolean,
  ): SVGElement {
    const node = document.createElementNS(SVG_NS, 'rect');
    const size = handle.name === 'rotate' ? 10 : 8;
    node.setAttribute('x', String(handle.x - size / 2));
    node.setAttribute('y', String(handle.y - size / 2));
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('class', 'draw__handle');
    node.setAttribute('data-handle', handle.name);
    node.setAttribute('data-locked', locked ? 'true' : 'false');
    // The cursor says what the drag will do BEFORE the drag happens, which is
    // the only moment it is useful.
    node.setAttribute('style', 'cursor:' + (locked ? 'not-allowed' : handle.cursor));
    // A handle is a control, so it carries its own name. One with none does not
    // exist for anybody using a screen reader.
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', handle.label + (locked ? ' (locked)' : ''));
    return node;
  }

  private shapeNode(shape: Shape): SVGElement | undefined {
    const node = document.createElementNS(
      SVG_NS,
      shape.kind === 'ellipse' ? 'ellipse' : shape.kind === 'rectangle' ? 'rect' : 'polyline',
    );

    if (shape.kind === 'rectangle') {
      node.setAttribute('x', '0');
      node.setAttribute('y', '0');
      node.setAttribute('width', String(shape.width ?? 0));
      node.setAttribute('height', String(shape.height ?? 0));
    } else if (shape.kind === 'ellipse') {
      const rx = (shape.width ?? 0) / 2;
      const ry = (shape.height ?? 0) / 2;
      node.setAttribute('cx', String(rx));
      node.setAttribute('cy', String(ry));
      node.setAttribute('rx', String(rx));
      node.setAttribute('ry', String(ry));
    } else {
      node.setAttribute(
        'points',
        shape.points.map((point) => point.x + ',' + point.y).join(' '),
      );
    }

    const { a, b, c, d, e, f } = shape.transform;
    node.setAttribute('transform', 'matrix(' + [a, b, c, d, e, f].join(' ') + ')');
    // Without an explicit none, SVG's default fill is black — every unfilled
    // outline becomes a solid block.
    node.setAttribute('fill', shape.fill?.colour ?? 'none');
    if (shape.stroke !== undefined) {
      node.setAttribute('stroke', shape.stroke.colour);
      node.setAttribute('stroke-width', String(shape.stroke.width));
      if (shape.stroke.cap !== undefined) node.setAttribute('stroke-linecap', shape.stroke.cap);
    }
    node.setAttribute('class', 'draw__shape');
    node.setAttribute('data-shape', shape.id);
    node.setAttribute('data-kind', shape.kind);
    // Each shape is a real node, so it carries its own accessible name.
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', shape.name);
    return node;
  }

  private selectionNode(bounds: Bounds): SVGElement {
    const node = document.createElementNS(SVG_NS, 'rect');
    node.setAttribute('x', String(bounds.left));
    node.setAttribute('y', String(bounds.top));
    node.setAttribute('width', String(Math.max(bounds.right - bounds.left, 1)));
    node.setAttribute('height', String(Math.max(bounds.bottom - bounds.top, 1)));
    node.setAttribute('class', 'draw__selection');
    node.setAttribute('fill', 'none');
    node.setAttribute('pointer-events', 'none');
    return node;
  }

  private renderLayers(): void {
    clear(this.layerList);

    if (this.drawing.shapes.length === 0) {
      this.layerList.append(
        el('p', { class: 'draw__empty' }, ['No shapes yet. Choose a tool and drag on the canvas.']),
      );
      return;
    }

    // Front to back, matching what the user sees: the topmost shape is the
    // first one they would reach for.
    for (let index = this.drawing.shapes.length - 1; index >= 0; index -= 1) {
      const shape = this.drawing.shapes[index] as Shape;
      this.layerList.append(
        el(
          'div',
          {
            class: 'draw__layer',
            role: 'option',
            'data-shape': shape.id,
            'data-marked': this.marked.chosen.has(shape.id) ? 'yes' : 'no',
            'data-current': shape.id === this.selected ? 'true' : 'false',
            'aria-selected': shape.id === this.selected ? 'true' : 'false',
          },
          [
            el(
              'button',
              {
                class: 'draw__layer-toggle draw__layer-mark',
                type: 'button',
                'data-toggle': 'mark',
                // The mark is carried by a real pressed state on a real
                // control, so it is not a tint a screen reader cannot see.
                'aria-pressed': this.marked.chosen.has(shape.id) ? 'true' : 'false',
                'aria-label':
                  (this.marked.chosen.has(shape.id) ? 'Unmark ' : 'Mark ') + shape.name,
              },
              [this.marked.chosen.has(shape.id) ? 'x' : ''],
            ),
            el('span', { class: 'draw__layer-name' }, [shape.name]),
            el(
              'button',
              {
                class: 'draw__layer-toggle',
                type: 'button',
                'data-toggle': 'hidden',
                'aria-pressed': shape.hidden ? 'true' : 'false',
                // Stated in words, because an icon alone is invisible to a
                // screen reader and ambiguous to everybody else.
                'aria-label': (shape.hidden ? 'Show' : 'Hide') + ' ' + shape.name,
              },
              [shape.hidden ? 'Hidden' : 'Visible'],
            ),
            el(
              'button',
              {
                class: 'draw__layer-toggle',
                type: 'button',
                'data-toggle': 'locked',
                'aria-pressed': shape.locked ? 'true' : 'false',
                'aria-label': (shape.locked ? 'Unlock' : 'Lock') + ' ' + shape.name,
              },
              [shape.locked ? 'Locked' : 'Unlocked'],
            ),
          ],
        ),
      );
    }
  }

  private renderStatus(): void {
    const selected = this.drawing.shapes.find((shape) => shape.id === this.selected);
    const parts = [
      this.drawing.shapes.length + (this.drawing.shapes.length === 1 ? ' shape' : ' shapes'),
      'Tool: ' + (TOOLS.find((entry) => entry.tool === this.tool)?.label ?? this.tool),
    ];

    if (selected !== undefined) {
      const bounds = boundsOf(selected);
      parts.push(
        selected.name +
          '  ' +
          Math.round(bounds.left) +
          ', ' +
          Math.round(bounds.top) +
          '  ' +
          Math.round(bounds.right - bounds.left) +
          ' by ' +
          Math.round(bounds.bottom - bounds.top),
      );
    } else {
      const all = unionBounds(this.drawing.shapes);
      if (all !== undefined) {
        parts.push(
          'Content ' +
            Math.round(all.right - all.left) +
            ' by ' +
            Math.round(all.bottom - all.top),
        );
      }
    }

    this.setStatus(parts.join('   '));
  }

  private setStatus(message: string): void {
    clear(this.statusLine);
    this.statusLine.append(message);
  }
}

export type { ShapeKind };

/** Drawing coordinates carry a hundredth of a unit; below that is float noise. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
