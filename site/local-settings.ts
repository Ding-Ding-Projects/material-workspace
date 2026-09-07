/**
 * Per-visitor settings for the documentation site.
 *
 * The site carries the same feature contract as the application, so it needs the
 * same settings model. What it does NOT have is an operating-system credential
 * store or an application-data directory, so state lives in this browser's local
 * storage — and every surface that would otherwise point at a data folder says
 * so plainly and names the real recovery route instead.
 *
 * Naming that difference is the point. A contract that "cannot apply" to a
 * surface is documented with the exact reason rather than left as a silent gap
 * that reads as an oversight to the next person and as a decision to nobody.
 */

import {
  defaultSettings,
  normaliseSettings,
  type WorkspaceSettings,
} from '../app/shared/settings.js';

const STORAGE_KEY = 'material-workspace.site.settings';

export interface SiteSettingsSnapshot {
  settings: WorkspaceSettings;
  provenance: Record<string, 'written' | 'default'>;
  loadFailure: string | null;
}

const PROVENANCE_KEYS = [
  'languageMode',
  'funnyLevels.english',
  'funnyLevels.cantonese',
  'dialogEmoji',
  'appearance.theme',
  'appearance.density',
  'appearance.fontScale',
  'appearance.reducedMotion',
  'appearance.rainbowSpeedLevel',
  'tabs.edge',
  'adhd.focus',
  'adhd.lowStimulation',
  'adhd.timeAwareness',
  'adhd.oneThingAtATime',
  'adhd.momentum',
] as const;

function readDotted(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export class SiteSettings {
  private current: WorkspaceSettings = defaultSettings();
  private raw: unknown = undefined;
  private failure: string | null = null;
  private readonly listeners = new Set<(snapshot: SiteSettingsSnapshot) => void>();

  constructor() {
    this.load();
    // Another tab of this site is another window of the same product, so a
    // change there propagates here live rather than at the next reload.
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      this.load();
      this.emit();
    });
  }

  private load(): void {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private browsing, or storage disabled entirely. The site still works;
      // it simply cannot remember anything, and says so where it matters.
      this.failure = 'this browser is not allowing local storage, so nothing can be remembered';
      this.current = defaultSettings();
      this.raw = undefined;
      return;
    }

    if (stored === null) {
      this.current = defaultSettings();
      this.raw = undefined;
      this.failure = null;
      return;
    }

    try {
      this.raw = JSON.parse(stored);
      this.current = normaliseSettings(this.raw);
      this.failure = null;
    } catch {
      this.raw = undefined;
      this.current = defaultSettings();
      this.failure = 'the saved settings could not be read, so the shipped values are in use';
    }
  }

  snapshot(): SiteSettingsSnapshot {
    const provenance: Record<string, 'written' | 'default'> = {};
    const shipped = defaultSettings();
    for (const key of PROVENANCE_KEYS) {
      // Both signals, exactly as the application requires: present on disk AND
      // different from the shipped value.
      const present = readDotted(this.raw, key) !== undefined;
      const differs =
        JSON.stringify(readDotted(this.current, key)) !== JSON.stringify(readDotted(shipped, key));
      provenance[key] = present && differs ? 'written' : 'default';
    }
    return { settings: this.current, provenance, loadFailure: this.failure };
  }

  get settings(): WorkspaceSettings {
    return this.current;
  }

  update(patch: Record<string, unknown>): void {
    this.current = normaliseSettings({ ...this.current, ...patch });
    this.persist();
    this.emit();
  }

  resetKey(path: string): void {
    const shipped = defaultSettings();
    const replacement = readDotted(shipped, path);
    const clone = structuredClone(this.current) as unknown as Record<string, unknown>;
    const segments = path.split('.');
    const last = segments.pop();
    if (!last) return;
    let cursor: Record<string, unknown> = clone;
    for (const segment of segments) {
      const next = cursor[segment];
      if (typeof next !== 'object' || next === null) return;
      cursor = next as Record<string, unknown>;
    }
    cursor[last] = replacement;
    this.current = normaliseSettings(clone);
    this.persist();
    this.emit();
  }

  resetAll(): void {
    this.current = defaultSettings();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing was stored to begin with */
    }
    this.raw = undefined;
    this.emit();
  }

  private persist(): void {
    try {
      const serialized = JSON.stringify(this.current);
      window.localStorage.setItem(STORAGE_KEY, serialized);
      this.raw = JSON.parse(serialized);
      this.failure = null;
    } catch {
      this.failure = 'this browser refused to save the change, so it will not survive a reload';
    }
  }

  onChange(listener: (snapshot: SiteSettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Named in the reset copy, because "clear site data" is not an instruction
   *  anybody can follow without knowing what to clear. */
  static get storageKey(): string {
    return STORAGE_KEY;
  }
}
