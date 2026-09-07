/**
 * Anchored overlays: popovers, menus, pickers and panels.
 *
 * Four rules are encoded here rather than left to each call site, because each
 * one has cost a project real time somewhere and each one is invisible until it
 * bites:
 *
 *   1. An overlay PAINTS ITS OWN SURFACE. Background, border, elevation, shape.
 *      An overlay that renders transparent lets whatever sits behind it read
 *      straight through the text on top, which is the fastest way to make a
 *      well-built dialog look broken.
 *
 *   2. It is BOUNDED BY THE VIEWPORT and scrolls internally. Capping the height
 *      and hiding the overflow deletes the content past the cap with no
 *      scrollbar to say anything is missing — a calendar loses its last week, a
 *      menu loses its last items, and the user has no way to know.
 *
 *   3. It never covers the control that opened it. Flipping to the other side is
 *      preferred over overlapping the anchor.
 *
 *   4. Focus returns to the originating control on close, and Escape closes.
 *      Without that, keyboard users are stranded wherever the overlay was.
 */

import { el } from '../dom.js';

export type OverlaySide = 'block-end' | 'block-start' | 'inline-end' | 'inline-start';

export interface OverlayOptions {
  /** The control the overlay belongs to. Focus returns here on close. */
  anchor: HTMLElement;
  /** Preferred side. Flipped automatically when there is not room. */
  side?: OverlaySide;
  /** Accessible name for the overlay region. */
  label: string;
  /** Called after the overlay is removed. */
  onClose?: () => void;
  /** Widen the overlay to at least the anchor's width. */
  matchAnchorWidth?: boolean;
}

const GAP = 8;
const VIEWPORT_MARGIN = 12;

export class Overlay {
  readonly element: HTMLElement;

  private readonly anchor: HTMLElement;
  private readonly options: OverlayOptions;
  private open = false;
  private readonly onDocumentPointerDown: (event: PointerEvent) => void;
  private readonly onDocumentKeyDown: (event: KeyboardEvent) => void;
  private readonly onReflow: () => void;

  constructor(options: OverlayOptions) {
    this.options = options;
    this.anchor = options.anchor;

    this.element = el('div', {
      class: 'overlay',
      role: 'dialog',
      'aria-label': options.label,
      // Modal is deliberately NOT set: these are non-modal by design, so the
      // rest of the interface stays operable behind them.
      'aria-modal': 'false',
      tabindex: '-1',
    });

    this.onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (this.element.contains(target) || this.anchor.contains(target)) return;
      this.close();
    };

    this.onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };

    this.onReflow = () => this.position();
  }

  show(content: Node): void {
    if (this.open) {
      this.element.replaceChildren(content);
      this.position();
      return;
    }

    this.element.replaceChildren(content);
    document.body.append(this.element);
    this.open = true;
    this.position();

    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    window.addEventListener('resize', this.onReflow);
    // Capture phase, so a scroll in any ancestor repositions rather than
    // leaving the overlay stranded where the anchor used to be.
    window.addEventListener('scroll', this.onReflow, true);

    // Move focus in, so the keyboard is not left behind the overlay.
    const focusable = this.element.querySelector<HTMLElement>(
      'input, button, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? this.element).focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    window.removeEventListener('resize', this.onReflow);
    window.removeEventListener('scroll', this.onReflow, true);
    this.element.remove();

    // Focus returns to where it came from. Without this the keyboard is
    // stranded at the top of the document.
    this.anchor.focus();
    this.options.onClose?.();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Place the overlay beside its anchor, inside the viewport, flipping rather
   * than overlapping and shrinking rather than clipping.
   */
  private position(): void {
    const anchorBox = this.anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    if (this.options.matchAnchorWidth) {
      this.element.style.minInlineSize = anchorBox.width + 'px';
    }

    // Measure with any previous cap removed, or the overlay can only ever
    // shrink across repositions and never grow back.
    this.element.style.maxBlockSize = '';
    const box = this.element.getBoundingClientRect();

    const side = this.options.side ?? 'block-end';
    const spaceBelow = viewportHeight - anchorBox.bottom - GAP - VIEWPORT_MARGIN;
    const spaceAbove = anchorBox.top - GAP - VIEWPORT_MARGIN;

    let top: number;
    if (side === 'block-start' || (side === 'block-end' && box.height > spaceBelow && spaceAbove > spaceBelow)) {
      // Flip above rather than cover the anchor.
      top = anchorBox.top - box.height - GAP;
      this.element.style.maxBlockSize = spaceAbove + 'px';
    } else {
      top = anchorBox.bottom + GAP;
      this.element.style.maxBlockSize = spaceBelow + 'px';
    }

    let left = anchorBox.left;
    // Keep it inside the viewport horizontally without ever letting it start
    // off-screen, which would make the beginning of the content unreachable.
    if (left + box.width > viewportWidth - VIEWPORT_MARGIN) {
      left = viewportWidth - VIEWPORT_MARGIN - box.width;
    }
    left = Math.max(VIEWPORT_MARGIN, left);
    top = Math.max(VIEWPORT_MARGIN, top);

    this.element.style.insetInlineStart = left + 'px';
    this.element.style.insetBlockStart = top + 'px';
  }
}

/**
 * A resizable, draggable floating panel.
 *
 * Panels are dragged by their header and resized from their edges, and both the
 * size and the position persist. It is deliberately impossible to drag one
 * entirely off-screen: a panel parked where the pointer cannot reach it can
 * never be grabbed back.
 */
export interface PanelOptions {
  label: string;
  initialWidth?: number;
  initialHeight?: number;
  onGeometryChange?: (geometry: { x: number; y: number; width: number; height: number }) => void;
}

export class FloatingPanel {
  readonly element: HTMLElement;
  readonly body: HTMLElement;

  private readonly options: PanelOptions;

  constructor(options: PanelOptions) {
    this.options = options;

    const header = el('div', { class: 'panel__header' }, [
      el('span', { class: 'panel__title', text: options.label }),
    ]);
    this.body = el('div', { class: 'panel__body' });

    this.element = el(
      'section',
      {
        class: 'panel',
        role: 'dialog',
        'aria-label': options.label,
        tabindex: '-1',
      },
      [header, this.body, el('div', { class: 'panel__resize', 'aria-hidden': 'true' })],
    );

    this.element.style.inlineSize = (options.initialWidth ?? 420) + 'px';
    this.element.style.blockSize = (options.initialHeight ?? 320) + 'px';

    this.wireDrag(header);
    this.wireResize(this.element.querySelector('.panel__resize') as HTMLElement);
    this.wireKeyboardGeometry(header);
  }

  private clampIntoViewport(x: number, y: number): { x: number; y: number } {
    const width = this.element.offsetWidth;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    // At least a header's worth must stay reachable on every edge.
    const MIN_VISIBLE = 48;
    return {
      x: Math.min(Math.max(MIN_VISIBLE - width, x), viewportWidth - MIN_VISIBLE),
      y: Math.min(Math.max(0, y), viewportHeight - MIN_VISIBLE),
    };
  }

  private report(): void {
    this.options.onGeometryChange?.({
      x: Number.parseFloat(this.element.style.insetInlineStart || '0'),
      y: Number.parseFloat(this.element.style.insetBlockStart || '0'),
      width: this.element.offsetWidth,
      height: this.element.offsetHeight,
    });
  }

  private wireDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const box = this.element.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent): void => {
        const next = this.clampIntoViewport(
          box.left + (moveEvent.clientX - startX),
          box.top + (moveEvent.clientY - startY),
        );
        this.element.style.insetInlineStart = next.x + 'px';
        this.element.style.insetBlockStart = next.y + 'px';
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.report();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private wireResize(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = this.element.offsetWidth;
      const startHeight = this.element.offsetHeight;
      grip.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent): void => {
        this.element.style.inlineSize =
          Math.max(280, startWidth + (moveEvent.clientX - startX)) + 'px';
        this.element.style.blockSize =
          Math.max(160, startHeight + (moveEvent.clientY - startY)) + 'px';
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        this.report();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  /**
   * A keyboard path for moving and resizing, so the behaviour is not
   * pointer-only. Arrow keys move; with Shift they resize.
   */
  private wireKeyboardGeometry(handle: HTMLElement): void {
    handle.tabIndex = 0;
    handle.setAttribute('role', 'button');
    handle.setAttribute(
      'aria-description',
      'Arrow keys move this panel. Hold Shift with the arrow keys to resize it.',
    );
    handle.addEventListener('keydown', (event: KeyboardEvent) => {
      const step = event.altKey ? 1 : 16;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();

      if (event.shiftKey) {
        this.element.style.inlineSize =
          Math.max(280, this.element.offsetWidth + delta[0]) + 'px';
        this.element.style.blockSize =
          Math.max(160, this.element.offsetHeight + delta[1]) + 'px';
      } else {
        const box = this.element.getBoundingClientRect();
        const next = this.clampIntoViewport(box.left + delta[0], box.top + delta[1]);
        this.element.style.insetInlineStart = next.x + 'px';
        this.element.style.insetBlockStart = next.y + 'px';
      }
      this.report();
    });
  }
}
