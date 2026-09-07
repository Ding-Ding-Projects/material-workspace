/**
 * The single narrow bridge between the renderer and the main process.
 *
 * Nothing here forwards an arbitrary channel name. Every method is an explicit
 * function with an explicit channel, because a generic invoke(channel, payload)
 * hands the renderer the whole main-process surface and turns one cross-site
 * scripting hole into full local code execution.
 *
 * Two failure modes this file is written against:
 *
 *   - A promise that never settles. Every request over this boundary carries a
 *     deadline that REJECTS. A catch cannot save a caller from a pending
 *     promise, so a hung request without one stops the caller silently — no
 *     error, no log, nothing to distinguish it from a slow machine.
 *   - A success flag derived from the path chosen rather than the outcome. The
 *     bridge returns what the main process actually reported, never a locally
 *     computed guess about whether it worked.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';

/** Generous enough for the slowest legitimate case. Killing a slow-but-working
 *  request turns a slow feature into a broken one, and that failure looks like
 *  flakiness, which is far harder to chase than a hang. */
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 180_000;

function invoke<T>(channel: string, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          'the request on "' +
            channel +
            '" did not answer within ' +
            timeoutMs +
            'ms. The operation may still be running; nothing was assumed about its result.',
        ),
      );
    }, timeoutMs);

    ipcRenderer
      .invoke(channel, payload)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value as T);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  provenance: {
    get: () => invoke(IPC.provenanceGet),
  },

  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch: unknown) => invoke(IPC.settingsUpdate, patch),
    resetKey: (dotted: string) => invoke(IPC.settingsResetKey, dotted),
    resetAll: () => invoke(IPC.settingsResetAll),
    onChanged: (listener: (payload: unknown) => void) => subscribe(IPC.settingsChanged, listener),
  },

  window: {
    minimise: () => invoke(IPC.windowMinimise),
    toggleMaximise: () => invoke(IPC.windowToggleMaximise),
    close: () => invoke(IPC.windowClose),
    onStateChanged: (listener: (payload: unknown) => void) =>
      subscribe(IPC.windowStateChanged, listener),
  },

  documents: {
    list: () => invoke(IPC.documentList),
    create: (payload: unknown) => invoke(IPC.documentCreate, payload),
    open: (id: string) => invoke(IPC.documentOpen, id),
    save: (payload: unknown) => invoke(IPC.documentSave, payload, LONG_TIMEOUT_MS),
    rename: (payload: unknown) => invoke(IPC.documentRename, payload),
    remove: (id: string) => invoke(IPC.documentDelete, id),
  },

  history: {
    list: (query: unknown) => invoke(IPC.historyList, query, LONG_TIMEOUT_MS),
    diff: (commit: string) => invoke(IPC.historyDiff, commit, LONG_TIMEOUT_MS),
    restore: (payload: unknown) => invoke(IPC.historyRestore, payload, LONG_TIMEOUT_MS),
    label: (payload: unknown) => invoke(IPC.historyLabel, payload),
    prune: (payload: unknown) => invoke(IPC.historyPrune, payload, LONG_TIMEOUT_MS),
    export: (payload: unknown) => invoke(IPC.historyExport, payload, LONG_TIMEOUT_MS),
    health: () => invoke(IPC.historyHealth),
  },

  vocabulary: {
    load: (payload: unknown) => invoke(IPC.vocabularyLoad, payload),
    clear: () => invoke(IPC.vocabularyClear),
    state: () => invoke(IPC.vocabularyState),
  },

  audit: {
    append: (payload: unknown) => invoke(IPC.auditAppend, payload),
    list: (query: unknown) => invoke(IPC.auditList, query),
    verify: () => invoke(IPC.auditVerify, undefined, LONG_TIMEOUT_MS),
  },

  shell: {
    openDataFolder: () => invoke(IPC.shellOpenDataFolder),
    dataFolderPath: () => invoke(IPC.shellDataFolderPath),
    openExternal: (url: string) => invoke(IPC.shellOpenExternal, url),
  },

  updates: {
    check: () => invoke(IPC.updateCheck, undefined, LONG_TIMEOUT_MS),
    download: (release: unknown) => invoke(IPC.updateDownload, release, LONG_TIMEOUT_MS),
    staged: () => invoke(IPC.updateStaged),
    install: (file: string) => invoke(IPC.updateInstall, file),
    onProgress: (listener: (payload: unknown) => void) => subscribe(IPC.updateProgress, listener),
  },

  accessibility: {
    state: () => invoke(IPC.accessibilityState),
    onChanged: (listener: (payload: unknown) => void) =>
      subscribe(IPC.accessibilityChanged, listener),
    revealPath: (target: string) => invoke(IPC.shellRevealPath, target),
  },
} as const;

contextBridge.exposeInMainWorld('workspace', api);

export type WorkspaceBridge = typeof api;
