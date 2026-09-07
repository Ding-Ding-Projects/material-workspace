/**
 * Layers, for one element.
 *
 * The stack half of the per-element appearance editor: several decorations on
 * one element, ordered, each hideable, lockable, reorderable, with its own
 * opacity and blend mode - and composited without any of them destroying the
 * others.
 *
 * WHAT THIS IS AND IS NOT, SAID PLAINLY. It is Photoshop's *model* - an ordered,
 * non-destructive stack - applied to what an interface element can genuinely
 * paint. It is NOT an image editor: there are no pixels here, so there is no
 * brush, no eraser, and no rasterizing. A mask is the shape of the element
 * itself, because a DOM element has exactly one shape and cannot be cut into an
 * arbitrary one without becoming a picture of itself.
 *
 * Building the pixel version would mean rendering the element to a canvas and
 * showing an image where the control used to be, which would break every
 * accessible name, every focus ring and every text selection on it. That trade
 * is refused rather than half-made, and the documentation says so.
 *
 * THE ORDERING TRAP, WRITTEN DOWN BECAUSE IT IS EASY TO REVERSE. The list runs
 * TOP FIRST, exactly as a layers panel reads. CSS `background-image` also
 * paints its first layer on top. So the list order and the CSS order are the
 * same, and anybody who "fixes" this by reversing it will put every stack
 * upside down while every test that only counts layers keeps passing.
 */

export type LayerKind = 'fill' | 'gradient' | 'shadow' | 'innerShadow' | 'ring' | 'blur';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

export interface Layer {
  readonly id: string;
  /** The user's name for it. Editable, and never load-bearing. */
  readonly name: string;
  readonly kind: LayerKind;
  readonly visible: boolean;
  /** A locked layer cannot be edited, moved or deleted until it is unlocked. */
  readonly locked: boolean;
  /** 0 to 1. */
  readonly opacity: number;
  readonly blend: BlendMode;
  /** For fill, gradient, shadow, innerShadow and ring. */
  readonly colour: string;
  /** For gradient: the second stop. */
  readonly colourTwo?: string;
  /** For gradient: the angle in degrees. */
  readonly angle?: number;
  /** For shadow and innerShadow: offset and blur, in pixels. */
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly blur?: number;
  /** For ring: its width, in pixels. For blur: its radius. */
  readonly size?: number;
}

export const LAYER_KINDS: readonly { readonly kind: LayerKind; readonly label: string }[] = [
  { kind: 'fill', label: 'Solid fill' },
  { kind: 'gradient', label: 'Gradient fill' },
  { kind: 'shadow', label: 'Drop shadow' },
  { kind: 'innerShadow', label: 'Inner shadow' },
  { kind: 'ring', label: 'Ring' },
  { kind: 'blur', label: 'Backdrop blur' },
];

/** A new layer of a kind, with values that are visible rather than invisible. */
export function newLayer(kind: LayerKind, id: string): Layer {
  const base = {
    id,
    name: LAYER_KINDS.find((entry) => entry.kind === kind)?.label ?? kind,
    kind,
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal' as BlendMode,
    // A default that can actually be SEEN. A new layer that renders nothing is
    // indistinguishable from one that failed to be added, and the user's next
    // move is to add another.
    colour: '#4f6bed',
  };

  switch (kind) {
    case 'gradient':
      return { ...base, colourTwo: '#c62828', angle: 90 };
    case 'shadow':
      return { ...base, colour: 'rgba(0,0,0,0.35)', offsetX: 0, offsetY: 4, blur: 12 };
    case 'innerShadow':
      return { ...base, colour: 'rgba(0,0,0,0.35)', offsetX: 0, offsetY: 2, blur: 6 };
    case 'ring':
      return { ...base, size: 2 };
    case 'blur':
      return { ...base, size: 6 };
    default:
      return base;
  }
}

// ------------------------------------------------------------- the stack --

/** Every element's layers, keyed by the element's stable style id. */
export type LayerBook = Readonly<Record<string, readonly Layer[]>>;

export const NO_LAYERS: LayerBook = {};

export interface Refusal {
  readonly ok: false;
  readonly reason: string;
}

export function layersFor(book: LayerBook, elementId: string): readonly Layer[] {
  return book[elementId] ?? [];
}

export function addLayer(book: LayerBook, elementId: string, layer: Layer): LayerBook {
  // Added at the TOP, which is where a new layer goes in every editor that has
  // ever had layers, and where somebody who just pressed the button is looking.
  return { ...book, [elementId]: [layer, ...layersFor(book, elementId)] };
}

/**
 * Change one layer.
 *
 * Refuses a locked layer rather than quietly ignoring the change. A lock that
 * silently swallows an edit is worse than no lock: the user watches a control
 * move and nothing happen, and has no way to learn why.
 */
export function updateLayer(
  book: LayerBook,
  elementId: string,
  layerId: string,
  change: Partial<Layer>,
): { readonly book: LayerBook } | Refusal {
  const layers = layersFor(book, elementId);
  const existing = layers.find((layer) => layer.id === layerId);
  if (existing === undefined) return { ok: false, reason: 'that layer is not on this element' };

  // Unlocking is always allowed - otherwise a locked layer could never be
  // unlocked, which is a lock nobody can undo.
  const unlocking = change.locked === false;
  if (existing.locked && !unlocking) {
    return { ok: false, reason: existing.name + ' is locked. Unlock it to change it.' };
  }

  const opacity = change.opacity;
  if (opacity !== undefined && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) {
    return { ok: false, reason: 'opacity runs from 0 to 1' };
  }

  return {
    book: {
      ...book,
      [elementId]: layers.map((layer) =>
        layer.id === layerId ? { ...layer, ...change } : layer,
      ),
    },
  };
}

export function removeLayer(
  book: LayerBook,
  elementId: string,
  layerId: string,
): { readonly book: LayerBook } | Refusal {
  const layers = layersFor(book, elementId);
  const existing = layers.find((layer) => layer.id === layerId);
  if (existing === undefined) return { ok: false, reason: 'that layer is not on this element' };
  if (existing.locked) {
    return { ok: false, reason: existing.name + ' is locked. Unlock it to remove it.' };
  }

  const kept = layers.filter((layer) => layer.id !== layerId);
  const next = { ...book };
  // An element with no layers left is removed rather than kept as an empty
  // array, so an exported theme does not accumulate entries that say nothing.
  if (kept.length === 0) delete next[elementId];
  else next[elementId] = kept;
  return { book: next };
}

/**
 * Move a layer up or down the stack.
 *
 * Clamped at both ends rather than wrapping. A layer that jumps from the top to
 * the bottom because somebody pressed up once too often is a surprise nobody
 * wants from an ordering control.
 */
export function moveLayer(
  book: LayerBook,
  elementId: string,
  layerId: string,
  direction: 'up' | 'down',
): { readonly book: LayerBook } | Refusal {
  const layers = [...layersFor(book, elementId)];
  const at = layers.findIndex((layer) => layer.id === layerId);
  if (at < 0) return { ok: false, reason: 'that layer is not on this element' };
  if ((layers[at] as Layer).locked) {
    return { ok: false, reason: (layers[at] as Layer).name + ' is locked. Unlock it to move it.' };
  }

  const to = direction === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= layers.length) {
    return { ok: false, reason: 'that layer is already at the ' + (direction === 'up' ? 'top' : 'bottom') };
  }

  const moved = layers[at] as Layer;
  layers.splice(at, 1);
  layers.splice(to, 0, moved);
  return { book: { ...book, [elementId]: layers } };
}

export function duplicateLayer(
  book: LayerBook,
  elementId: string,
  layerId: string,
  newId: string,
): { readonly book: LayerBook } | Refusal {
  const layers = layersFor(book, elementId);
  const at = layers.findIndex((layer) => layer.id === layerId);
  if (at < 0) return { ok: false, reason: 'that layer is not on this element' };

  const source = layers[at] as Layer;
  // The copy is never locked, whatever the original was. A duplicate that
  // arrives locked cannot be edited, which is the one thing somebody duplicating
  // a layer is about to do.
  const copy: Layer = { ...source, id: newId, name: source.name + ' copy', locked: false };
  const next = [...layers];
  next.splice(at, 0, copy);
  return { book: { ...book, [elementId]: next } };
}

// --------------------------------------------------------------- painting --

export interface Composed {
  readonly backgroundImage: string;
  readonly backgroundBlend: string;
  readonly boxShadow: string;
  readonly backdropFilter: string;
}

/**
 * Turn a stack into the four CSS values that paint it.
 *
 * A hidden layer contributes NOTHING - not a transparent copy of itself, which
 * would still occupy a slot and shift every blend mode after it by one.
 */
export function compose(layers: readonly Layer[]): Composed {
  const images: string[] = [];
  const blends: string[] = [];
  const shadows: string[] = [];
  const filters: string[] = [];

  for (const layer of layers) {
    if (!layer.visible) continue;
    const colour = withOpacity(layer.colour, layer.opacity);

    switch (layer.kind) {
      case 'fill':
        // A flat gradient rather than `background-color`, because only
        // background-image stacks. A colour written to background-color would
        // sit under every layer and could never be ordered.
        images.push('linear-gradient(' + colour + ', ' + colour + ')');
        blends.push(layer.blend);
        break;

      case 'gradient':
        images.push(
          'linear-gradient(' +
            (layer.angle ?? 90) +
            'deg, ' +
            colour +
            ', ' +
            withOpacity(layer.colourTwo ?? layer.colour, layer.opacity) +
            ')',
        );
        blends.push(layer.blend);
        break;

      case 'shadow':
        shadows.push(
          (layer.offsetX ?? 0) + 'px ' + (layer.offsetY ?? 0) + 'px ' + (layer.blur ?? 0) + 'px ' + colour,
        );
        break;

      case 'innerShadow':
        shadows.push(
          'inset ' +
            (layer.offsetX ?? 0) + 'px ' + (layer.offsetY ?? 0) + 'px ' + (layer.blur ?? 0) + 'px ' + colour,
        );
        break;

      case 'ring':
        // An inset shadow with no blur and a spread, which follows the
        // element's own corner radius. A border would change the box size and
        // move everything beside it.
        shadows.push('inset 0 0 0 ' + (layer.size ?? 1) + 'px ' + colour);
        break;

      case 'blur':
        filters.push('blur(' + (layer.size ?? 0) + 'px)');
        break;
    }
  }

  return {
    backgroundImage: images.join(', '),
    // Only emitted when something is actually blended, so an ordinary stack
    // does not carry a list of "normal" nobody needs.
    backgroundBlend: blends.some((mode) => mode !== 'normal') ? blends.join(', ') : '',
    boxShadow: shadows.join(', '),
    backdropFilter: filters.join(' '),
  };
}

/**
 * Fold a layer's opacity into its colour.
 *
 * Per-layer rather than through the element's own `opacity`, which would fade
 * the element's text and its children along with the decoration - the classic
 * mistake, and the one that makes a layer stack unusable on anything that
 * contains words.
 */
export function withOpacity(colour: string, opacity: number): string {
  if (opacity >= 1) return colour;
  const clamped = Math.max(0, Math.min(1, opacity));

  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex !== null) {
    const value = hex[1] as string;
    const channel = Math.round(clamped * 255).toString(16).padStart(2, '0');
    return '#' + value + channel;
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(colour);
  if (rgb !== null) {
    const parts = (rgb[1] as string).split(/[,\s/]+/).filter((part) => part !== '');
    const [r, g, b] = parts;
    const existing = parts.length > 3 ? Number(parts[3]) : 1;
    const combined = (Number.isFinite(existing) ? existing : 1) * clamped;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + Number(combined.toFixed(3)) + ')';
  }

  // A notation this does not recognise is left EXACTLY as it is rather than
  // guessed at. A wrong colour is worse than a colour at full strength, and
  // the layer still renders.
  return colour;
}

/** Whether the stack paints anything at all, for the "is this customized" readout. */
export function countVisible(layers: readonly Layer[]): number {
  return layers.filter((layer) => layer.visible).length;
}

// ------------------------------------------------------------- reading in --

/**
 * Read a stored layer book back, keeping only what is genuinely a layer.
 *
 * Layer colours reach a style attribute exactly as element properties do, so
 * they go through the same closed notations rather than being trusted because
 * they came from the settings file. That file is an ordinary file that anybody
 * can open in an editor.
 */
export function readLayerBook(value: unknown, acceptColour: (raw: string) => boolean): LayerBook {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const book: Record<string, Layer[]> = {};
  for (const [elementId, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept: Layer[] = [];

    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const raw = entry as Record<string, unknown>;

      const kind = raw['kind'];
      if (!LAYER_KINDS.some((candidate) => candidate.kind === kind)) continue;
      if (typeof raw['id'] !== 'string' || raw['id'] === '') continue;

      const colour = typeof raw['colour'] === 'string' ? raw['colour'] : '';
      if (!acceptColour(colour)) continue;

      const second = raw['colourTwo'];
      const secondColour =
        typeof second === 'string' && acceptColour(second) ? second : undefined;

      kept.push({
        id: raw['id'],
        name: typeof raw['name'] === 'string' ? raw['name'].slice(0, 60) : String(kind),
        kind: kind as LayerKind,
        visible: raw['visible'] !== false,
        locked: raw['locked'] === true,
        opacity: number(raw['opacity'], 0, 1, 1),
        blend: BLEND_MODES.includes(raw['blend'] as BlendMode)
          ? (raw['blend'] as BlendMode)
          : 'normal',
        colour,
        ...(secondColour === undefined ? {} : { colourTwo: secondColour }),
        angle: number(raw['angle'], -360, 360, 90),
        offsetX: number(raw['offsetX'], -200, 200, 0),
        offsetY: number(raw['offsetY'], -200, 200, 0),
        blur: number(raw['blur'], 0, 200, 0),
        size: number(raw['size'], 0, 200, 0),
      });
    }

    if (kept.length > 0) book[elementId] = kept;
  }
  return book;
}

function number(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
