/**
 * Per-element appearance.
 *
 * Every rendered element is the user's to restyle, so this is the model behind
 * the "Edit appearance..." editor: which properties exist, what each one
 * accepts, how a value becomes CSS, and what happens when a property cannot be
 * honoured on this platform.
 *
 * THREE RULES DECIDE THE SHAPE OF EVERYTHING BELOW.
 *
 * A value the user set is never silently dropped. A property the platform
 * cannot render STAYS VISIBLE with an exact capability explanation, because a
 * control that vanishes reads as a build that forgot it rather than as a
 * limitation somebody decided.
 *
 * Nothing here is destructive. An override is stored beside the shipped value
 * rather than replacing it, so reset is real - and reset per property, per
 * element and globally are three separate, always-available actions.
 *
 * And the record is DATA, never CSS text. Storing a stylesheet fragment would
 * mean parsing it back to show a control, and would put an injection surface
 * inside a settings file. A value that cannot be expressed as one of the kinds
 * below is a value this editor does not offer.
 */

export type PropertyKind = 'colour' | 'length' | 'number' | 'choice' | 'toggle';

export type PropertyGroup = 'Typography' | 'Text' | 'Colour' | 'Spacing' | 'Shape' | 'Effects';

export interface PropertyDefinition {
  /** Stable key. Stored, exported, and never shown to the user. */
  readonly id: string;
  /** Shown to the user. */
  readonly label: string;
  readonly kind: PropertyKind;
  /** The CSS property this writes. */
  readonly css: string;
  /** Grouped in the editor so a long list stays navigable. */
  readonly group: PropertyGroup;
  /** For a length or number: the range the editor allows. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** For a length: the unit appended to the number. */
  readonly unit?: string;
  /** For a choice: the values offered, in the order they are shown. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** For a toggle: what the two states write. */
  readonly on?: string;
  readonly off?: string;
  /**
   * Why this property cannot be relied on, when it cannot.
   *
   * Present means limited. The control is still rendered, still shows the
   * stored value, and says this out loud rather than disappearing.
   */
  readonly unsupported?: string;
}

/**
 * Every property the editor offers.
 *
 * Word-depth on the typography side: family, size, weight, style, the three
 * decoration lines with their own style and colour, capitalization, small
 * caps, the vertical positions, and the four spacing measures that decide
 * whether a paragraph is readable.
 */
export const PROPERTIES: readonly PropertyDefinition[] = [
  // ------------------------------------------------------------ typography --
  {
    id: 'fontFamily',
    label: 'Font',
    kind: 'choice',
    css: 'font-family',
    group: 'Typography',
    // Filled at run time from the fonts the machine actually has. An empty
    // list here is correct: this module has no business guessing what is
    // installed, and a hard-coded list is a list that is wrong somewhere.
    options: [],
  },
  {
    id: 'fontSize',
    label: 'Size',
    kind: 'length',
    css: 'font-size',
    group: 'Typography',
    min: 6,
    max: 96,
    step: 0.5,
    unit: 'px',
  },
  {
    id: 'fontWeight',
    label: 'Weight',
    kind: 'number',
    css: 'font-weight',
    group: 'Typography',
    min: 100,
    max: 900,
    step: 50,
  },
  {
    id: 'fontStyle',
    label: 'Style',
    kind: 'choice',
    css: 'font-style',
    group: 'Typography',
    options: [
      { value: 'normal', label: 'Upright' },
      { value: 'italic', label: 'Italic' },
      { value: 'oblique 14deg', label: 'Oblique' },
    ],
  },
  {
    id: 'fontVariantCaps',
    label: 'Small caps',
    kind: 'toggle',
    css: 'font-variant-caps',
    group: 'Typography',
    on: 'small-caps',
    off: 'normal',
  },
  {
    id: 'textTransform',
    label: 'Capitalization',
    kind: 'choice',
    css: 'text-transform',
    group: 'Typography',
    options: [
      { value: 'none', label: 'As written' },
      { value: 'capitalize', label: 'Capitalize Each Word' },
      { value: 'uppercase', label: 'UPPER CASE' },
      { value: 'lowercase', label: 'lower case' },
    ],
  },

  // ------------------------------------------------------------------ text --
  {
    id: 'textDecorationLine',
    label: 'Lines',
    kind: 'choice',
    css: 'text-decoration-line',
    group: 'Text',
    options: [
      { value: 'none', label: 'None' },
      { value: 'underline', label: 'Underline' },
      { value: 'line-through', label: 'Strikethrough' },
      { value: 'overline', label: 'Overline' },
      { value: 'underline line-through', label: 'Underline and strikethrough' },
    ],
  },
  {
    id: 'textDecorationStyle',
    label: 'Line style',
    kind: 'choice',
    css: 'text-decoration-style',
    group: 'Text',
    options: [
      { value: 'solid', label: 'Solid' },
      { value: 'double', label: 'Double' },
      { value: 'dotted', label: 'Dotted' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'wavy', label: 'Wavy' },
    ],
  },
  {
    id: 'textDecorationColor',
    label: 'Line colour',
    kind: 'colour',
    css: 'text-decoration-color',
    group: 'Text',
  },
  {
    id: 'verticalAlign',
    label: 'Vertical position',
    kind: 'choice',
    css: 'vertical-align',
    group: 'Text',
    options: [
      { value: 'baseline', label: 'On the baseline' },
      { value: 'super', label: 'Superscript' },
      { value: 'sub', label: 'Subscript' },
    ],
  },
  {
    id: 'textAlign',
    label: 'Alignment',
    kind: 'choice',
    css: 'text-align',
    group: 'Text',
    options: [
      { value: 'start', label: 'Start' },
      { value: 'center', label: 'Centre' },
      { value: 'end', label: 'End' },
      { value: 'justify', label: 'Justified' },
    ],
  },
  {
    id: 'direction',
    label: 'Direction',
    kind: 'choice',
    css: 'direction',
    group: 'Text',
    options: [
      { value: 'ltr', label: 'Left to right' },
      { value: 'rtl', label: 'Right to left' },
    ],
  },

  // ---------------------------------------------------------------- colour --
  { id: 'color', label: 'Text colour', kind: 'colour', css: 'color', group: 'Colour' },
  {
    id: 'backgroundColor',
    label: 'Highlight',
    kind: 'colour',
    css: 'background-color',
    group: 'Colour',
  },
  {
    id: 'borderColor',
    label: 'Border colour',
    kind: 'colour',
    css: 'border-color',
    group: 'Colour',
  },

  // --------------------------------------------------------------- spacing --
  {
    id: 'letterSpacing',
    label: 'Character spacing',
    kind: 'length',
    css: 'letter-spacing',
    group: 'Spacing',
    min: -2,
    max: 12,
    step: 0.1,
    unit: 'px',
  },
  {
    id: 'wordSpacing',
    label: 'Word spacing',
    kind: 'length',
    css: 'word-spacing',
    group: 'Spacing',
    min: -4,
    max: 32,
    step: 0.5,
    unit: 'px',
  },
  {
    id: 'lineHeight',
    label: 'Line height',
    kind: 'number',
    css: 'line-height',
    group: 'Spacing',
    min: 0.8,
    max: 4,
    step: 0.05,
  },
  {
    id: 'padding',
    label: 'Inner space',
    kind: 'length',
    css: 'padding',
    group: 'Spacing',
    min: 0,
    max: 64,
    step: 1,
    unit: 'px',
  },

  // ----------------------------------------------------------------- shape --
  {
    id: 'borderRadius',
    label: 'Corner radius',
    kind: 'length',
    css: 'border-radius',
    group: 'Shape',
    min: 0,
    max: 64,
    step: 1,
    unit: 'px',
  },
  {
    id: 'borderWidth',
    label: 'Border width',
    kind: 'length',
    css: 'border-width',
    group: 'Shape',
    min: 0,
    max: 12,
    step: 1,
    unit: 'px',
  },
  {
    id: 'borderStyle',
    label: 'Border style',
    kind: 'choice',
    css: 'border-style',
    group: 'Shape',
    options: [
      { value: 'none', label: 'None' },
      { value: 'solid', label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
      { value: 'double', label: 'Double' },
    ],
  },

  // --------------------------------------------------------------- effects --
  {
    id: 'boxShadow',
    label: 'Shadow',
    kind: 'choice',
    css: 'box-shadow',
    group: 'Effects',
    options: [
      { value: 'none', label: 'None' },
      { value: '0 1px 2px rgba(0,0,0,0.3)', label: 'Close' },
      { value: '0 4px 12px rgba(0,0,0,0.3)', label: 'Lifted' },
      { value: '0 12px 32px rgba(0,0,0,0.35)', label: 'Floating' },
    ],
  },
  {
    id: 'opacity',
    label: 'Opacity',
    kind: 'number',
    css: 'opacity',
    group: 'Effects',
    min: 0.1,
    max: 1,
    step: 0.05,
  },
  {
    id: 'textShadow',
    label: 'Glow',
    kind: 'choice',
    css: 'text-shadow',
    group: 'Effects',
    options: [
      { value: 'none', label: 'None' },
      { value: '0 0 4px currentColor', label: 'Soft' },
      { value: '0 0 10px currentColor', label: 'Strong' },
    ],
  },
  {
    id: 'textStroke',
    label: 'Outline',
    kind: 'length',
    css: '-webkit-text-stroke-width',
    group: 'Effects',
    min: 0,
    max: 4,
    step: 0.25,
    unit: 'px',
    // Named rather than hidden. This is a prefixed property with no standard
    // equivalent, so it renders in this engine and would be ignored elsewhere -
    // and a control that disappears reads as a build that forgot it.
    unsupported:
      'Text outline is a non-standard property. It renders here, and a copy of this ' +
      'theme opened in another engine may ignore it.',
  },
];

const BY_ID = new Map(PROPERTIES.map((property) => [property.id, property]));

export function propertyFor(id: string): PropertyDefinition | undefined {
  return BY_ID.get(id);
}

/** One element's overrides. Keyed by property id, holding the raw value. */
export type ElementStyle = Readonly<Record<string, string>>;

/** Every element that has been restyled, keyed by its stable element id. */
export type StyleBook = Readonly<Record<string, ElementStyle>>;

export const NO_STYLES: StyleBook = {};

// ------------------------------------------------------------- validating --

export interface Rejection {
  readonly ok: false;
  readonly reason: string;
}

export type Acceptance = { readonly ok: true; readonly value: string } | Rejection;

/**
 * Check one value against its property.
 *
 * Returns the value it will actually store, which is not always the value
 * handed in: a number is normalised so that "12" and "12.0" cannot become two
 * different stored values that render identically.
 */
export function accept(id: string, raw: string): Acceptance {
  const property = BY_ID.get(id);
  if (property === undefined) return { ok: false, reason: 'there is no property called ' + id };

  const value = raw.trim();
  if (value === '') return { ok: false, reason: 'an empty value would not change anything' };

  switch (property.kind) {
    case 'colour':
      return acceptColour(value);

    case 'toggle':
      if (value !== property.on && value !== property.off) {
        return { ok: false, reason: 'that is not one of the two states' };
      }
      return { ok: true, value };

    case 'choice': {
      // An empty options list means the list is supplied at run time, so any
      // plain value is allowed. Refusing here would make the font picker
      // unusable, since this module cannot know what is installed.
      const options = property.options ?? [];
      if (options.length === 0) return acceptFreeChoice(value);
      if (!options.some((option) => option.value === value)) {
        return { ok: false, reason: 'that is not one of the choices offered' };
      }
      return { ok: true, value };
    }

    case 'length':
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) return { ok: false, reason: 'that is not a number' };
      const min = property.min ?? -Infinity;
      const max = property.max ?? Infinity;
      if (number < min || number > max) {
        return { ok: false, reason: 'the range is ' + min + ' to ' + max };
      }
      // Normalised, so 12 and 12.0 cannot be stored as two different values
      // that render the same.
      return { ok: true, value: String(number) };
    }
  }
}

/**
 * A run-time choice, such as an installed font name.
 *
 * Letters, digits, spaces and a few punctuation marks fonts really use. NOT
 * free text: this value is written into a style attribute, so a stored setting
 * edited by hand - or arriving through an import - must not be able to carry a
 * semicolon, a brace, a url(), or anything else that ends one declaration and
 * begins another.
 */
function acceptFreeChoice(value: string): Acceptance {
  if (value.length > 96) return { ok: false, reason: 'that name is too long to be a font' };
  if (!/^[A-Za-z0-9 _.,'-]+$/.test(value)) {
    return { ok: false, reason: 'a font name cannot contain punctuation that ends a declaration' };
  }
  return { ok: true, value };
}

/**
 * Colours only in notations that cannot carry anything but a colour.
 *
 * NOT a general CSS value check. A stored style is written into a style
 * attribute, so accepting free text here would let a settings file - which can
 * be edited by hand, or arrive through an import - smuggle in a url(), an
 * image, or an expression. Every notation below is a fixed shape with no room
 * for a nested function call.
 */
function acceptColour(value: string): Acceptance {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const functional = /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-z%.,/ +-]+\)$/i;
  const named = /^[a-z]+$/i;

  if (hex.test(value) || functional.test(value) || named.test(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    reason: 'a colour must be a hex value, a colour function, or a colour name',
  };
}

// ---------------------------------------------------------------- writing --

/** Set one property on one element, without touching anything else. */
export function setProperty(
  book: StyleBook,
  elementId: string,
  propertyId: string,
  raw: string,
): { readonly book: StyleBook } | Rejection {
  const accepted = accept(propertyId, raw);
  if (!accepted.ok) return accepted;

  const existing = book[elementId] ?? {};
  return {
    book: {
      ...book,
      [elementId]: { ...existing, [propertyId]: accepted.value },
    },
  };
}

/** Reset ONE property, leaving the element's other overrides in place. */
export function resetProperty(book: StyleBook, elementId: string, propertyId: string): StyleBook {
  const existing = book[elementId];
  if (existing === undefined || !(propertyId in existing)) return book;

  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (key !== propertyId) kept[key] = value;
  }

  const next = { ...book };
  // An element with nothing left is REMOVED rather than kept as an empty
  // record, so an exported theme does not accumulate entries that say nothing.
  if (Object.keys(kept).length === 0) delete next[elementId];
  else next[elementId] = kept;
  return next;
}

/** Reset one element completely. */
export function resetElement(book: StyleBook, elementId: string): StyleBook {
  if (!(elementId in book)) return book;
  const next = { ...book };
  delete next[elementId];
  return next;
}

/** Reset everything. */
export function resetAll(): StyleBook {
  return NO_STYLES;
}

/** Copy every override from one element onto another. */
export function copyStyle(book: StyleBook, from: string, to: string): StyleBook {
  const source = book[from];
  if (source === undefined) return resetElement(book, to);
  return { ...book, [to]: { ...source } };
}

// --------------------------------------------------------------- applying --

/**
 * The declarations for one element, as property/value pairs.
 *
 * Returned as pairs rather than as a string so the caller writes them through
 * the style object, which cannot be talked into parsing anything. Building a
 * text fragment and assigning it to `style` would reintroduce the parser this
 * whole module is shaped to avoid.
 */
export function declarationsFor(
  book: StyleBook,
  elementId: string,
): readonly (readonly [string, string])[] {
  const style = book[elementId];
  if (style === undefined) return [];

  const declarations: (readonly [string, string])[] = [];
  for (const [id, value] of Object.entries(style)) {
    const property = BY_ID.get(id);
    if (property === undefined) continue;
    declarations.push([property.css, value + (property.unit ?? '')]);
  }
  return declarations;
}

/** How many properties are overridden, for the "this is customized" readout. */
export function countOverrides(book: StyleBook, elementId: string): number {
  return Object.keys(book[elementId] ?? {}).length;
}

// ------------------------------------------------------ export and import --

export interface ThemeFile {
  readonly kind: 'material-workspace-element-theme';
  readonly version: 1;
  readonly styles: StyleBook;
}

export function exportTheme(book: StyleBook): ThemeFile {
  return { kind: 'material-workspace-element-theme', version: 1, styles: book };
}

export interface ImportResult {
  readonly book: StyleBook;
  /**
   * What the file carried that this version will not apply.
   *
   * Reported rather than dropped. An import that silently discards half a
   * theme is an import that looks like it worked.
   */
  readonly skipped: readonly string[];
}

/**
 * Read a theme file back, keeping only what this version can honour.
 *
 * Every value goes through `accept` again, so a file edited by hand cannot put
 * anything into a style attribute that the editor itself would have refused.
 */
export function importTheme(payload: unknown): ImportResult | Rejection {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'that file is not a theme' };
  }

  const file = payload as { kind?: unknown; version?: unknown; styles?: unknown };
  if (file.kind !== 'material-workspace-element-theme') {
    return { ok: false, reason: 'that file is not a theme for this application' };
  }
  if (file.version !== 1) {
    return { ok: false, reason: 'that theme was written by a different version' };
  }
  if (typeof file.styles !== 'object' || file.styles === null) {
    return { ok: false, reason: 'that theme carries no styles' };
  }

  const book: Record<string, Record<string, string>> = {};
  const skipped: string[] = [];

  for (const [elementId, style] of Object.entries(file.styles as Record<string, unknown>)) {
    if (typeof style !== 'object' || style === null) {
      skipped.push(elementId + ': not a set of properties');
      continue;
    }
    for (const [propertyId, value] of Object.entries(style as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        skipped.push(elementId + '.' + propertyId + ': not a value');
        continue;
      }
      const accepted = accept(propertyId, value);
      if (!accepted.ok) {
        skipped.push(elementId + '.' + propertyId + ': ' + accepted.reason);
        continue;
      }
      book[elementId] = { ...(book[elementId] ?? {}), [propertyId]: accepted.value };
    }
  }

  return { book, skipped };
}

// ------------------------------------------------------- identifying one --

export interface ElementStep {
  readonly tag: string;
  /** The element's own explicit style id, when it declares one. */
  readonly styleId?: string | undefined;
  /** Stable class names only. A state class must not reach this. */
  readonly classes?: readonly string[] | undefined;
  /** Position among siblings, used only when nothing better exists. */
  readonly index?: number | undefined;
}

/**
 * The key one element's overrides are stored under.
 *
 * An explicit `data-style-id` wins outright and stops the walk, because that is
 * a promise the surface made about identity. Everything else is a fallback,
 * and the fallback is deliberately SHORT: the nearest few steps, by class where
 * a class exists.
 *
 * WHY NOT A FULL PATH. A path from the document root encodes every wrapper
 * between here and there, so inserting one container - a layout change nobody
 * thinks of as breaking anything - renames every stored style beneath it and
 * the user's work silently stops applying. A short key can collide; a long one
 * is guaranteed to break. Collisions are visible and fixable by giving the
 * surface an explicit id, so that is the failure worth having.
 */
export function styleIdFor(path: readonly ElementStep[]): string {
  const parts: string[] = [];

  for (const step of path) {
    if (step.styleId !== undefined && step.styleId !== '') return step.styleId;

    const classes = (step.classes ?? []).filter((name) => name !== '');
    parts.push(
      classes.length > 0 ? classes[0] as string : step.tag + ':' + (step.index ?? 0),
    );
    // Three steps is enough to separate the same class in two panels without
    // encoding the whole layout above it.
    if (parts.length === 3) break;
  }

  return parts.length === 0 ? 'unknown' : parts.join('>');
}
