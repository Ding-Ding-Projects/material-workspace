/**
 * The persisted settings model, shared by the main process and the renderer.
 *
 * Every field here is a contract obligation rather than a preference somebody
 * liked the sound of. The comments say which one, so a later reader can tell a
 * removable convenience from a thing the product must carry.
 *
 * Defaults are deliberate:
 *   - Both funny levels ship at 5. That is the specified default, not a joke.
 *   - The narrator ships OFF. It is an accommodation, not an opinion.
 *   - Every ADHD mode ships OFF, independently. A mode that switches itself on
 *     has decided something about the user it has no standing to decide.
 *   - School mode ships OFF and its name ships as the shipped name.
 */

export type LanguageMode = 'en' | 'yue' | 'bilingual';

/** 1 is fully professional, 5 is maximum playfulness. */
export type FunnyLevel = 1 | 2 | 3 | 4 | 5;

import { readLayerBook } from './element-layers.js';
import { accept } from './element-style.js';

export type ThemeMode = 'light' | 'dark' | 'system';

export type Density = 'comfortable' | 'standard' | 'compact';

export type TabEdge = 'left' | 'right' | 'top' | 'bottom';

export type NarratorLanguage = 'en' | 'yue' | 'both';

export interface NarratorVoiceChoice {
  /** The platform's stable voice identity, never its display name. Names are
   *  not unique across engines and platforms localize them, so a profile
   *  written on one install silently stops matching on another. */
  voiceUri: string | null;
  /** Remembered only so the UI can say WHICH voice is missing when a chosen
   *  voice is not installed here. Never used for matching. */
  lastKnownName: string | null;
}

export interface NarratorSettings {
  enabled: boolean;
  language: NarratorLanguage;
  english: NarratorVoiceChoice;
  cantonese: NarratorVoiceChoice;
  /** Platform-documented ranges; defaults are the voice's own normal delivery. */
  rate: number;
  pitch: number;
}

export interface FunnyLevels {
  english: FunnyLevel;
  cantonese: FunnyLevel;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  density: Density;
  /** Seed colour for the Material scheme, or the animated-rainbow sentinel. */
  seedColor: string;
  fontFamily: string | null;
  fontScale: number;
  fontWeight: number;
  reducedMotion: 'system' | 'on' | 'off';
  /** Global, so every rainbow surface turns together. Set per element they
   *  drift apart by however long apart they were mounted, and a screen showing
   *  six different hues reads as a rendering fault. */
  rainbowSpeedLevel: 1 | 2 | 3 | 4 | 5;
  /**
   * Per-element overrides, keyed by the element's stable style id.
   *
   * Stored as DATA rather than as CSS text. See `element-style.ts` for why:
   * a stylesheet fragment in a settings file is a parser and an injection
   * surface, and it cannot be read back into a control.
   */
  elementStyles: Record<string, Record<string, string>>;
  /** Saved styles, keyed by the name the user gave them. */
  stylePresets: Record<string, Record<string, string>>;
  /** Ordered decoration layers, keyed by the element's stable style id. */
  elementLayers: Record<string, unknown[]>;
}

export interface TabSettings {
  edge: TabEdge;
  order: string[];
  pinned: string[];
  groups: TabGroup[];
  collapsedGroups: string[];
}

export interface TabGroup {
  id: string;
  name: string;
  color: string;
  members: string[];
}

/** Every mode independently toggleable. Never one master switch: attention
 *  difficulties do not arrive as a single setting, and bundling them means most
 *  people turn the whole thing off to escape the one part that does not suit. */
export interface AdhdModes {
  focus: boolean;
  lowStimulation: boolean;
  timeAwareness: boolean;
  oneThingAtATime: boolean;
  momentum: boolean;
}

export interface SchoolMode {
  enabled: boolean;
  /** The user may rename it. After a rename every surface uses only this name
   *  and must not reveal the shipped one. */
  displayName: string;
  /** Presence only. The credential itself lives in the OS credential store. */
  credentialConfigured: boolean;
}

export interface PersonalVocabularyState {
  /** No file loaded means original shipped wording, everywhere, always. There
   *  are no built-in mappings, samples or templates. */
  loaded: boolean;
  entryCount: number;
  schemaVersion: number | null;
  /** Never the source path or its contents — neither may be persisted outside
   *  the validated private cache. */
}

export interface DimSumState {
  /** Not opt-out. Recorded only so one launch cannot fire twice. */
  lastShownLaunchId: string | null;
}

export interface AutosaveSettings {
  enabled: boolean;
  /** Debounce plus a settle detector, so a burst of typing is one commit and
   *  not four hundred. */
  debounceMs: number;
  settleMs: number;
  retainDays: number | null;
}

export interface CollaborationSettings {
  enabled: boolean;
  serverUrl: string | null;
  /** Presence only; the token lives in the OS credential store. */
  credentialConfigured: boolean;
}

export interface WorkspaceSettings {
  schema: 'material-workspace/settings@1';
  languageMode: LanguageMode;
  funnyLevels: FunnyLevels;
  dialogEmoji: boolean;
  schoolMode: SchoolMode;
  narrator: NarratorSettings;
  appearance: AppearanceSettings;
  tabs: TabSettings;
  adhd: AdhdModes;
  personalVocabulary: PersonalVocabularyState;
  dimSum: DimSumState;
  autosave: AutosaveSettings;
  collaboration: CollaborationSettings;
  /** Display only. Never reaches identity, paths, or the update feed. */
  displayName: string | null;
}

export const APPLICATION_IDS = [
  'writer',
  'sheets',
  'slides',
  'draw',
  'formula',
  'database',
  'pdf',
  'notes',
  'forms',
] as const;

export type ApplicationId = (typeof APPLICATION_IDS)[number];

export function defaultSettings(): WorkspaceSettings {
  return {
    schema: 'material-workspace/settings@1',
    languageMode: 'en',
    funnyLevels: { english: 5, cantonese: 5 },
    dialogEmoji: true,
    schoolMode: {
      enabled: false,
      displayName: 'School mode',
      credentialConfigured: false,
    },
    narrator: {
      enabled: false,
      language: 'en',
      english: { voiceUri: null, lastKnownName: null },
      cantonese: { voiceUri: null, lastKnownName: null },
      rate: 1,
      pitch: 1,
    },
    appearance: {
      theme: 'system',
      density: 'standard',
      seedColor: '#4F6BED',
      fontFamily: null,
      fontScale: 1,
      fontWeight: 400,
      reducedMotion: 'system',
      rainbowSpeedLevel: 3,
      elementStyles: {},
      stylePresets: {},
      elementLayers: {},
    },
    tabs: {
      edge: 'left',
      order: [],
      pinned: [],
      groups: [],
      collapsedGroups: [],
    },
    adhd: {
      focus: false,
      lowStimulation: false,
      timeAwareness: false,
      oneThingAtATime: false,
      momentum: false,
    },
    personalVocabulary: { loaded: false, entryCount: 0, schemaVersion: null },
    dimSum: { lastShownLaunchId: null },
    autosave: {
      enabled: true,
      debounceMs: 1200,
      settleMs: 2500,
      retainDays: null,
    },
    collaboration: { enabled: false, serverUrl: null, credentialConfigured: false },
    displayName: null,
  };
}

const FUNNY_LEVELS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

function asFunnyLevel(value: unknown, fallback: FunnyLevel): FunnyLevel {
  return typeof value === 'number' && FUNNY_LEVELS.has(value) ? (value as FunnyLevel) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function asOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Normalise unknown input into valid settings. Never throws: a corrupt field
 * falls back to its default rather than taking the whole profile down, because
 * one bad colour should not cost somebody every other preference they set.
 */
export function normaliseSettings(input: unknown): WorkspaceSettings {
  const base = defaultSettings();
  if (typeof input !== 'object' || input === null) return base;
  const raw = input as Record<string, unknown>;

  const funny = (raw.funnyLevels ?? {}) as Record<string, unknown>;
  const school = (raw.schoolMode ?? {}) as Record<string, unknown>;
  const narrator = (raw.narrator ?? {}) as Record<string, unknown>;
  const appearance = (raw.appearance ?? {}) as Record<string, unknown>;
  const tabs = (raw.tabs ?? {}) as Record<string, unknown>;
  const adhd = (raw.adhd ?? {}) as Record<string, unknown>;
  const vocabulary = (raw.personalVocabulary ?? {}) as Record<string, unknown>;
  const dimSum = (raw.dimSum ?? {}) as Record<string, unknown>;
  const autosave = (raw.autosave ?? {}) as Record<string, unknown>;
  const collaboration = (raw.collaboration ?? {}) as Record<string, unknown>;

  const englishVoice = (narrator.english ?? {}) as Record<string, unknown>;
  const cantoneseVoice = (narrator.cantonese ?? {}) as Record<string, unknown>;

  return {
    schema: 'material-workspace/settings@1',
    languageMode: asOneOf(raw.languageMode, ['en', 'yue', 'bilingual'], base.languageMode),
    funnyLevels: {
      english: asFunnyLevel(funny.english, base.funnyLevels.english),
      cantonese: asFunnyLevel(funny.cantonese, base.funnyLevels.cantonese),
    },
    dialogEmoji: asBoolean(raw.dialogEmoji, base.dialogEmoji),
    schoolMode: {
      enabled: asBoolean(school.enabled, base.schoolMode.enabled),
      displayName: asString(school.displayName, base.schoolMode.displayName),
      credentialConfigured: asBoolean(
        school.credentialConfigured,
        base.schoolMode.credentialConfigured,
      ),
    },
    narrator: {
      enabled: asBoolean(narrator.enabled, base.narrator.enabled),
      language: asOneOf(narrator.language, ['en', 'yue', 'both'], base.narrator.language),
      english: {
        voiceUri: asNullableString(englishVoice.voiceUri),
        lastKnownName: asNullableString(englishVoice.lastKnownName),
      },
      cantonese: {
        voiceUri: asNullableString(cantoneseVoice.voiceUri),
        lastKnownName: asNullableString(cantoneseVoice.lastKnownName),
      },
      rate: asNumberInRange(narrator.rate, 0.1, 10, base.narrator.rate),
      pitch: asNumberInRange(narrator.pitch, 0, 2, base.narrator.pitch),
    },
    appearance: {
      theme: asOneOf(appearance.theme, ['light', 'dark', 'system'], base.appearance.theme),
      density: asOneOf(
        appearance.density,
        ['comfortable', 'standard', 'compact'],
        base.appearance.density,
      ),
      seedColor: asString(appearance.seedColor, base.appearance.seedColor),
      fontFamily: asNullableString(appearance.fontFamily),
      fontScale: asNumberInRange(appearance.fontScale, 0.5, 3, base.appearance.fontScale),
      fontWeight: asNumberInRange(appearance.fontWeight, 100, 900, base.appearance.fontWeight),
      reducedMotion: asOneOf(
        appearance.reducedMotion,
        ['system', 'on', 'off'],
        base.appearance.reducedMotion,
      ),
      rainbowSpeedLevel: (asNumberInRange(
        appearance.rainbowSpeedLevel,
        1,
        5,
        base.appearance.rainbowSpeedLevel,
      ) | 0) as 1 | 2 | 3 | 4 | 5,
      // Re-validated through the style model on the way in, so a settings file
      // edited by hand cannot put anything into a style attribute that the
      // editor itself would have refused.
      elementStyles: asElementStyles(appearance.elementStyles),
      // Same treatment: a preset is a style, and a style reaches a style
      // attribute.
      stylePresets: asElementStyles(appearance.stylePresets),
      // A layer's colour reaches a style attribute exactly as a property's
      // does, so it goes through the same closed notations rather than being
      // trusted because it came from the settings file.
      elementLayers: readLayerBook(
        appearance.elementLayers,
        (raw) => accept('color', raw).ok,
      ) as Record<string, unknown[]>,
    },
    tabs: {
      edge: asOneOf(tabs.edge, ['left', 'right', 'top', 'bottom'], base.tabs.edge),
      order: asStringArray(tabs.order),
      pinned: asStringArray(tabs.pinned),
      groups: Array.isArray(tabs.groups)
        ? tabs.groups
            .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
            .map((g) => ({
              id: asString(g.id, ''),
              name: asString(g.name, 'Group'),
              color: asString(g.color, '#4F6BED'),
              members: asStringArray(g.members),
            }))
            .filter((g) => g.id.length > 0)
        : [],
      collapsedGroups: asStringArray(tabs.collapsedGroups),
    },
    adhd: {
      focus: asBoolean(adhd.focus, base.adhd.focus),
      lowStimulation: asBoolean(adhd.lowStimulation, base.adhd.lowStimulation),
      timeAwareness: asBoolean(adhd.timeAwareness, base.adhd.timeAwareness),
      oneThingAtATime: asBoolean(adhd.oneThingAtATime, base.adhd.oneThingAtATime),
      momentum: asBoolean(adhd.momentum, base.adhd.momentum),
    },
    personalVocabulary: {
      loaded: asBoolean(vocabulary.loaded, false),
      entryCount: asNumberInRange(vocabulary.entryCount, 0, 100000, 0),
      schemaVersion:
        typeof vocabulary.schemaVersion === 'number' ? vocabulary.schemaVersion : null,
    },
    dimSum: { lastShownLaunchId: asNullableString(dimSum.lastShownLaunchId) },
    autosave: {
      enabled: asBoolean(autosave.enabled, base.autosave.enabled),
      debounceMs: asNumberInRange(autosave.debounceMs, 200, 60000, base.autosave.debounceMs),
      settleMs: asNumberInRange(autosave.settleMs, 200, 120000, base.autosave.settleMs),
      retainDays:
        typeof autosave.retainDays === 'number' && Number.isFinite(autosave.retainDays)
          ? Math.max(1, Math.min(36500, autosave.retainDays))
          : null,
    },
    collaboration: {
      enabled: asBoolean(collaboration.enabled, base.collaboration.enabled),
      serverUrl: asNullableString(collaboration.serverUrl),
      credentialConfigured: asBoolean(collaboration.credentialConfigured, false),
    },
    displayName: asNullableString(raw.displayName),
  };
}

/**
 * Per-element overrides, checked value by value.
 *
 * This is the one settings field whose contents reach a style attribute, so it
 * does not get the ordinary "is it a string" treatment. Anything the style
 * model would refuse from the editor is refused here too, and the rest is kept
 * rather than the whole book being thrown away over one bad entry.
 */
function asElementStyles(value: unknown): Record<string, Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const book: Record<string, Record<string, string>> = {};
  for (const [elementId, style] of Object.entries(value as Record<string, unknown>)) {
    if (typeof style !== 'object' || style === null || Array.isArray(style)) continue;
    for (const [propertyId, raw] of Object.entries(style as Record<string, unknown>)) {
      if (typeof raw !== 'string') continue;
      const accepted = accept(propertyId, raw);
      if (!accepted.ok) continue;
      book[elementId] = { ...(book[elementId] ?? {}), [propertyId]: accepted.value };
    }
  }
  return book;
}
