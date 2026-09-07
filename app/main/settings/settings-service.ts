/**
 * The one owner of persisted settings.
 *
 * Two behaviours here are contract obligations rather than conveniences:
 *
 * 1. School mode and the app display name are SHARED state that propagates
 *    LIVE. Turning School mode on anywhere turns it on everywhere, and an
 *    application already running picks the change up without a restart. An app
 *    that only reads the record at startup sits in the wrong mode beside one
 *    that switched correctly, which is the exact failure that being universal
 *    exists to prevent. So the file is watched, not merely read.
 *
 * 2. Every settings element must be able to say whether its current value was
 *    actually written by somebody or is a compiled-in fallback, naming the real
 *    value. That provenance is computed here, from the raw file, before
 *    normalisation fills the gaps — afterwards it is impossible to tell the two
 *    apart, which is why it cannot be done later.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  defaultSettings,
  normaliseSettings,
  type WorkspaceSettings,
} from '../../shared/settings.js';
import { JsonStore } from '../storage/json-store.js';
import { settingsDir } from '../storage/paths.js';

export type SettingsProvenance = Record<string, 'written' | 'default'>;

export interface SettingsSnapshot {
  settings: WorkspaceSettings;
  provenance: SettingsProvenance;
  /** Non-null when the stored file could not be used, so the surface can say so
   *  rather than letting a corrupt profile look like a fresh install. */
  loadFailure: string | null;
}

/** Dotted paths whose provenance the settings surfaces display. */
const PROVENANCE_KEYS = [
  'languageMode',
  'funnyLevels.english',
  'funnyLevels.cantonese',
  'dialogEmoji',
  'schoolMode.enabled',
  'schoolMode.displayName',
  'narrator.enabled',
  'narrator.language',
  'narrator.english.voiceUri',
  'narrator.cantonese.voiceUri',
  'narrator.rate',
  'narrator.pitch',
  'appearance.theme',
  'appearance.density',
  'appearance.seedColor',
  'appearance.fontFamily',
  'appearance.fontScale',
  'appearance.fontWeight',
  'appearance.reducedMotion',
  'appearance.rainbowSpeedLevel',
  'tabs.edge',
  'adhd.focus',
  'adhd.lowStimulation',
  'adhd.timeAwareness',
  'adhd.oneThingAtATime',
  'adhd.momentum',
  'autosave.enabled',
  'autosave.debounceMs',
  'autosave.settleMs',
  'autosave.retainDays',
  'collaboration.enabled',
  'collaboration.serverUrl',
  'displayName',
] as const;

function readDotted(source: unknown, dotted: string): unknown {
  let cursor: unknown = source;
  for (const segment of dotted.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export class SettingsService extends EventEmitter {
  /**
   * Resolved in initialise(), never in the constructor.
   *
   * The data root is injected by the main process once Electron is ready, and
   * this service is constructed at module load — earlier than that. Computing
   * the path in the constructor would capture the platform FALLBACK. On
   * Windows the fallback and the injected value happen to be identical, so it
   * would appear to work here and quietly write to the wrong place elsewhere:
   * the worst kind of defect, correct on the machine that wrote it.
   */
  private store: JsonStore<WorkspaceSettings> | null = null;
  private file: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private rawOnDisk: unknown = undefined;
  private reloadTimer: NodeJS.Timeout | null = null;

  private requireStore(): JsonStore<WorkspaceSettings> {
    if (!this.store) {
      throw new Error(
        'SettingsService was used before initialise() ran, so its data directory is not known yet.',
      );
    }
    return this.store;
  }

  async initialise(): Promise<void> {
    this.file = path.join(settingsDir(), 'settings.json');
    this.store = new JsonStore<WorkspaceSettings>({
      file: this.file,
      fallback: defaultSettings,
      validate: normaliseSettings,
    });
    await fsp.mkdir(settingsDir(), { recursive: true });
    await this.refreshRaw();
    await this.store.read();
    this.startWatching();
  }

  private async refreshRaw(): Promise<void> {
    try {
      this.rawOnDisk = JSON.parse(await fsp.readFile(this.file ?? '', 'utf8'));
    } catch {
      this.rawOnDisk = undefined;
    }
  }

  /**
   * Watch for changes made by another window or another application in the
   * suite, so shared state propagates live. Debounced, because an atomic
   * replace produces more than one filesystem event.
   */
  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(settingsDir(), (_event, filename) => {
        if (filename && !String(filename).startsWith('settings.json')) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          void this.reloadFromDisk();
        }, 120);
      });
    } catch {
      // A platform without directory watching still works; it simply does not
      // propagate live. Saying so beats pretending it does.
      this.emit('watch-unavailable');
    }
  }

  private async reloadFromDisk(): Promise<void> {
    this.requireStore().invalidate();
    await this.refreshRaw();
    const settings = await this.requireStore().read();
    this.emit('changed', await this.snapshotFrom(settings));
  }

  private async snapshotFrom(settings: WorkspaceSettings): Promise<SettingsSnapshot> {
    const provenance: SettingsProvenance = {};
    for (const key of PROVENANCE_KEYS) {
      provenance[key] = readDotted(this.rawOnDisk, key) === undefined ? 'default' : 'written';
    }
    return { settings, provenance, loadFailure: this.requireStore().lastLoadFailure };
  }

  async snapshot(): Promise<SettingsSnapshot> {
    return this.snapshotFrom(await this.requireStore().read());
  }

  async read(): Promise<WorkspaceSettings> {
    return this.requireStore().read();
  }

  async update(mutate: (current: WorkspaceSettings) => WorkspaceSettings): Promise<SettingsSnapshot> {
    const next = await this.requireStore().update(mutate);
    await this.refreshRaw();
    const snapshot = await this.snapshotFrom(next);
    this.emit('changed', snapshot);
    return snapshot;
  }

  /** Reset one dotted path back to its shipped default. */
  async resetKey(dotted: string): Promise<SettingsSnapshot> {
    const fallback = defaultSettings();
    const replacement = readDotted(fallback, dotted);
    return this.update((current) => {
      // Through unknown: WorkspaceSettings has no index signature, and asserting
      // one directly would be a claim the type does not support.
      const clone = structuredClone(current) as unknown as Record<string, unknown>;
      const segments = dotted.split('.');
      const last = segments.pop();
      if (!last) return current;
      let cursor: Record<string, unknown> = clone;
      for (const segment of segments) {
        const next = cursor[segment];
        if (typeof next !== 'object' || next === null) return current;
        cursor = next as Record<string, unknown>;
      }
      cursor[last] = replacement;
      return clone as unknown as WorkspaceSettings;
    });
  }

  async resetAll(): Promise<SettingsSnapshot> {
    return this.update(() => defaultSettings());
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}
