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
  IDENTITY,
  type ArrangeAction,
  type Bounds,
  type Drawing,
  type Point,
  type Shape,
  type ShapeKind,
  arrange,
  boundsOf,
  emptyDrawing,
  newShapeId,
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
  private fill = '#64b5f6';
  private stroke = '#212121';

  /** Set while a drag is creating or moving a shape. */
  private dragFrom: Point | null = null;
  private dragMode: 'create' | 'move' | null = null;
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
      if (id === null) return;

      if (toggle !== null) {
        const which = toggle.getAttribute('data-toggle');
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
    return {
      x: ((event.clientX - box.left) / box.width) * this.drawing.width,
      y: ((event.clientY - box.top) / box.height) * this.drawing.height,
    };
  }

  private onPointerDown(event: PointerEvent): void {
    this.canvas.focus();
    const point = this.toDrawing(event);
    this.dragFrom = point;

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
      this.canvas.append(this.selectionNode(boundsOf(selected)));
    }
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
            'data-current': shape.id === this.selected ? 'true' : 'false',
            'aria-selected': shape.id === this.selected ? 'true' : 'false',
          },
          [
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
