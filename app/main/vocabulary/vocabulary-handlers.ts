import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { SettingsService } from '../settings/settings-service.js';
import { VocabularyService } from './vocabulary-service.js';

export const vocabularyService = new VocabularyService();

export function registerVocabularyHandlers(ipcMain: IpcMain, settings: SettingsService): void {
  void vocabularyService.initialise().then(async () => {
    const state = vocabularyService.state();
    await settings.update((current) => ({
      ...current,
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
