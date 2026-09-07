import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { SettingsService } from '../settings/settings-service.js';
import { VocabularyService } from './vocabulary-service.js';

export const vocabularyService = new VocabularyService();

export function registerVocabularyHandlers(ipcMain: IpcMain, settings: SettingsService): void {
  void vocabularyService.initialise().then(async () => {
    const state = vocabularyService.state();
    const current = await settings.read();

    // Only write when something ACTUALLY changed.
    //
    // Writing unconditionally at startup persists the entire settings object on
    // first launch, which makes every value look as though somebody set it. The
    // settings surfaces then report "set" for a profile nobody has touched,
    // which is the opposite of what that signal is for.
    const unchanged =
      current.personalVocabulary.loaded === state.loaded &&
      current.personalVocabulary.entryCount === state.entryCount &&
      current.personalVocabulary.schemaVersion === state.schemaVersion;
    if (unchanged) return;

    await settings.update((existing) => ({
      ...existing,
      personalVocabulary: {
        loaded: state.loaded,
        entryCount: state.entryCount,
        schemaVersion: state.schemaVersion,
      },
    }));
  });

  ipcMain.handle(IPC.vocabularyLoad, async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('the file contents are required');
    }
    const { contents } = payload as Record<string, unknown>;
    if (!(contents instanceof Uint8Array) && typeof contents !== 'string') {
      throw new Error('the file contents must be text or bytes');
    }
    const bytes =
      typeof contents === 'string' ? Buffer.from(contents, 'utf8') : Buffer.from(contents);

    const state = await vocabularyService.load(bytes);
    await settings.update((current) => ({
      ...current,
      personalVocabulary: {
        loaded: state.loaded,
        entryCount: state.entryCount,
        schemaVersion: state.schemaVersion,
      },
    }));
    // The entries travel to the renderer so it can apply them at its text
    // boundary. They are never written to settings, a log, an export or a
    // capture, and the source path never reaches this process at all.
    return { state, entries: vocabularyService.entries() };
  });

  ipcMain.handle(IPC.vocabularyClear, async () => {
    const state = await vocabularyService.clear();
    await settings.update((current) => ({
      ...current,
      personalVocabulary: {
        loaded: false,
        entryCount: 0,
        schemaVersion: null,
      },
    }));
    return { state, entries: {} };
  });

  ipcMain.handle(IPC.vocabularyState, () => ({
    state: vocabularyService.state(),
    entries: vocabularyService.entries(),
  }));
}
