/**
 * The presentation model.
 *
 * A slide is a list of positioned ELEMENTS, not a document flow. That is the
 * one structural decision everything else follows from, and it is the opposite
 * of the text engine's design on purpose: a paragraph reflows when the page
 * changes, and a slide element does not move when anything else does.
 *
 * Positions are stored in a normalised 0..1 space rather than in pixels or
 * points. A presentation is shown at whatever size the screen happens to be —
 * a laptop, a projector at 4:3, a hall at 16:9 — and pixel coordinates mean
 * rebuilding the geometry at every one of them, with a rounding error at each
 * step. Normalised coordinates scale exactly and are resolution-independent by
 * construction.
 */

export type SlideSize = '16:9' | '4:3';

export interface SlideGeometry {
  /** Points, for export and for print. The screen uses the ratio only. */
  readonly width: number;
  readonly height: number;
}

export const GEOMETRY: Readonly<Record<SlideSize, SlideGeometry>> = {
  // 13.333 x 7.5 inches and 10 x 7.5 inches, the two standard sizes.
  '16:9': { width: 960, height: 540 },
  '4:3': { width: 720, height: 540 },
};

/** A rectangle in normalised slide space. All four are 0..1. */
export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextStyle {
  /** Points at the slide's own scale, so it scales with the slide. */
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly align?: 'start' | 'center' | 'end';
  readonly colour?: string;
}

export type SlideElement =
  | {
      readonly kind: 'text';
      readonly id: string;
      readonly frame: Frame;
      readonly text: string;
      readonly style: TextStyle;
      /** Title elements are what an outline view and a contents slide read. */
      readonly role?: 'title' | 'subtitle' | 'body';
    }
  | {
      readonly kind: 'shape';
      readonly id: string;
      readonly frame: Frame;
      readonly shape: 'rectangle' | 'ellipse' | 'line' | 'arrow';
      readonly fill?: string;
      readonly stroke?: string;
    }
  | {
      readonly kind: 'image';
      readonly id: string;
      readonly frame: Frame;
      /** A data URL. Presentations must open with no network. */
      readonly source: string;
      readonly alt: string;
    };

export type LayoutName =
  | 'title'
  | 'titleAndContent'
  | 'twoContent'
  | 'sectionHeader'
  | 'blank';

export interface Slide {
  readonly id: string;
  readonly layout: LayoutName;
  readonly elements: readonly SlideElement[];
  /**
   * Speaker notes. Shown only on the presenter's own screen, never on the
   * one the audience is looking at — which is the entire point of them and
   * the thing that is easiest to get wrong.
   */
  readonly notes: string;
  /** Seconds. Zero means advance on a keypress rather than on a timer. */
  readonly advanceAfter: number;
  readonly transition: 'none' | 'fade' | 'push';
  /** A hidden slide stays in the file and is skipped when presenting. */
  readonly hidden: boolean;
}

export interface Presentation {
  readonly schema: 'material-workspace/slides@1';
  readonly size: SlideSize;
  readonly slides: readonly Slide[];
}

let counter = 0;

export function newElementId(): string {
  counter += 1;
  return 'e' + counter.toString(36);
}

export function newSlideId(): string {
  counter += 1;
  return 's' + counter.toString(36);
}

/**
 * Where each layout puts its placeholders.
 *
 * Kept as data rather than as code that positions things, so adding a layout
 * is adding a row. It also means a slide's geometry can be checked against its
 * layout without running any of the rendering.
 */
export const LAYOUTS: Readonly<
  Record<LayoutName, readonly { role: 'title' | 'subtitle' | 'body'; frame: Frame }[]>
> = {
  title: [
    { role: 'title', frame: { x: 0.08, y: 0.32, width: 0.84, height: 0.22 } },
    { role: 'subtitle', frame: { x: 0.08, y: 0.56, width: 0.84, height: 0.14 } },
  ],
  titleAndContent: [
    { role: 'title', frame: { x: 0.06, y: 0.07, width: 0.88, height: 0.16 } },
    { role: 'body', frame: { x: 0.06, y: 0.28, width: 0.88, height: 0.62 } },
  ],
  twoContent: [
    { role: 'title', frame: { x: 0.06, y: 0.07, width: 0.88, height: 0.16 } },
    { role: 'body', frame: { x: 0.06, y: 0.28, width: 0.42, height: 0.62 } },
    { role: 'body', frame: { x: 0.52, y: 0.28, width: 0.42, height: 0.62 } },
  ],
  sectionHeader: [
    { role: 'title', frame: { x: 0.08, y: 0.4, width: 0.84, height: 0.2 } },
  ],
  blank: [],
};

const DEFAULT_SIZE: Readonly<Record<'title' | 'subtitle' | 'body', number>> = {
  title: 40,
  subtitle: 22,
  body: 20,
};

export function emptyPresentation(size: SlideSize = '16:9'): Presentation {
  return {
    schema: 'material-workspace/slides@1',
    size,
    slides: [newSlide('title')],
  };
}

export function newSlide(layout: LayoutName): Slide {
  return {
    id: newSlideId(),
    layout,
    elements: LAYOUTS[layout].map((placeholder) => ({
      kind: 'text' as const,
      id: newElementId(),
      frame: placeholder.frame,
      text: '',
      role: placeholder.role,
      style: {
        size: DEFAULT_SIZE[placeholder.role],
        bold: placeholder.role === 'title',
        align: placeholder.role === 'title' ? 'start' : 'start',
      },
    })),
    notes: '',
    advanceAfter: 0,
    transition: 'none',
    hidden: false,
  };
}

/** The title of a slide, for the outline and the slide list. */
export function slideTitle(slide: Slide, fallbackIndex: number): string {
  for (const element of slide.elements) {
    if (element.kind !== 'text') continue;
    if (element.role === 'title' && element.text.trim().length > 0) return element.text.trim();
  }
  // Any text at all is better than "Slide 7" for finding a slide again.
  for (const element of slide.elements) {
    if (element.kind === 'text' && element.text.trim().length > 0) {
      const first = element.text.trim().split('\n')[0] ?? '';
      return first.length > 60 ? first.slice(0, 57) + '...' : first;
    }
  }
  return 'Slide ' + (fallbackIndex + 1);
}

/** The slides an audience actually sees, in order. */
export function visibleSlides(presentation: Presentation): Slide[] {
  return presentation.slides.filter((slide) => !slide.hidden);
}

/**
 * How long the whole presentation runs, when every slide is timed.
 *
 * Returns undefined when any visible slide advances on a keypress, because a
 * total that silently treats those as zero would tell a presenter their
 * forty-minute talk takes four minutes.
 */
export function totalDuration(presentation: Presentation): number | undefined {
  const slides = visibleSlides(presentation);
  if (slides.length === 0) return 0;
  if (slides.some((slide) => slide.advanceAfter <= 0)) return undefined;
  return slides.reduce((total, slide) => total + slide.advanceAfter, 0);
}

/** Convert a normalised frame to pixels at a given rendered slide size. */
export function frameToPixels(
  frame: Frame,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: frame.x * width,
    top: frame.y * height,
    width: frame.width * width,
    height: frame.height * height,
  };
}

/**
 * Font size in pixels at a given rendered slide width.
 *
 * Text has to scale with the slide or a presentation authored on a laptop is
 * unreadable on a projector. Scaling from the WIDTH rather than the height
 * keeps the relationship to line length constant, which is what actually
 * governs readability.
 */
export function fontSizeToPixels(
  size: number,
  renderedWidth: number,
  geometry: SlideGeometry,
): number {
  return (size * renderedWidth) / geometry.width;
}

/** Clamp a frame into the slide, so an element cannot be dragged off it. */
export function clampFrame(frame: Frame): Frame {
  const width = Math.min(Math.max(frame.width, 0.02), 1);
  const height = Math.min(Math.max(frame.height, 0.02), 1);
  return {
    width,
    height,
    x: Math.min(Math.max(frame.x, 0), 1 - width),
    y: Math.min(Math.max(frame.y, 0), 1 - height),
  };
}
