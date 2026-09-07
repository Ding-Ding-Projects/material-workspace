import type { IpcMain } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { IPC, type HistoryAction } from '../../shared/ipc.js';
import type { SettingsService } from '../settings/settings-service.js';
import { GitHistory } from './git-history.js';
import { documentService } from '../documents/document-handlers.js';
import { cacheDir } from '../storage/paths.js';
import { writeFileAtomic } from '../storage/atomic-file.js';

export const gitHistory = new GitHistory();

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<HistoryAction>([
  'created',
  'autosaved',
  'updated',
  'renamed',
  'deleted',
  'restored',
  'discarded',
  'imported',
  'settings-changed',
  'label-added',
]);

function parseActions(value: unknown): HistoryAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter(
    (entry): entry is HistoryAction => typeof entry === 'string' && KNOWN_ACTIONS.has(entry),
  );
  return actions.length > 0 ? actions : undefined;
}

/** Accept the locale's typed date and a plain ISO date alike; report a partial
 *  or invalid entry rather than silently discarding the filter. */
function parseDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(label + ' must be a date');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(label + ' was not a date this application could read: ' + value);
  }
  return parsed.toISOString();
}

export function registerHistoryHandlers(ipcMain: IpcMain, settings: SettingsService): void {
  // Keep the autosave cadence in step with the setting, live.
  void settings.read().then((current) => {
    documentService.configure({
      debounceMs: current.autosave.debounceMs,
      settleMs: current.autosave.settleMs,
    });
  });
  settings.on('changed', (snapshot: { settings: { autosave: { debounceMs: number; settleMs: number } } }) => {
    documentService.configure({
      debounceMs: snapshot.settings.autosave.debounceMs,
      settleMs: snapshot.settings.autosave.settleMs,
    });
  });

  ipcMain.handle(IPC.historyList, async (_event, query: unknown) => {
    const request = (typeof query === 'object' && query !== null ? query : {}) as Record<
      string,
      unknown
    >;
    const entries = await gitHistory.list({
      limit: typeof request.limit === 'number' ? request.limit : 500,
      since: parseDate(request.since, 'The "from" date'),
      until: parseDate(request.until, 'The "to" date'),
      actions: parseActions(request.actions),
    });
    // The action filter is derived from the history that actually exists, never
    // from a hard-coded list that drifts away from what is recorded.
    const observed = await gitHistory.observedActions();
    return { entries, observedActions: observed };
  });

  ipcMain.handle(IPC.historyDiff, (_event, commit: unknown) => {
    if (typeof commit !== 'string') throw new Error('a commit identifier is required');
    return gitHistory.diff(commit);
  });

  ipcMain.handle(IPC.historyRestore, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('restoring requires a commit and a path');
    }
    const { commit, relativePath } = payload as Record<string, unknown>;
    if (typeof commit !== 'string') throw new Error('a commit identifier is required');
    if (typeof relativePath !== 'string') throw new Error('a path is required');
    return gitHistory.restore(commit, relativePath);
  });

  ipcMain.handle(IPC.historyLabel, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('labelling requires a commit and a label');
    }
    const { commit, label } = payload as Record<string, unknown>;
    if (typeof commit !== 'string') throw new Error('a commit identifier is required');
    if (typeof label !== 'string') throw new Error('a label is required');
    return gitHistory.label(commit, label);
  });

  ipcMain.handle(IPC.historyPrune, () => {
    // Deliberately not implemented as a silent no-op. Pruning destroys history,
    // so it goes through the destructive-action gate in the renderer and lands
    // here only once that gate has been satisfied. Until that gate ships, this
    // says so rather than pretending to prune.
    throw new Error(
      'Pruning is not available yet. It destroys history permanently, so it ships together with the two-key confirmation gate rather than before it.',
    );
  });

  ipcMain.handle(IPC.historyExport, async (_event, payload: unknown) => {
    const request = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
      string,
      unknown
    >;
    const entries = await gitHistory.list({
      limit: typeof request.limit === 'number' ? request.limit : 5000,
      since: parseDate(request.since, 'The "from" date'),
      until: parseDate(request.until, 'The "to" date'),
      actions: parseActions(request.actions),
    });

    const format = typeof request.format === 'string' ? request.format : 'json';
    const target = path.join(cacheDir(), 'exports');
    await fsp.mkdir(target, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    let file: string;
    let contents: string;
    if (format === 'csv') {
      file = path.join(target, 'history-' + stamp + '.csv');
      const escape = (value: string): string => '"' + value.replace(/"/g, '""') + '"';
      contents =
        'commit,at,action,subject,document,label\n' +
        entries
          .map((entry) =>
            [
              entry.commit,
              entry.at,
              entry.action,
              entry.subject,
              entry.documentId ?? '',
              entry.label ?? '',
            ]
              .map(escape)
              .join(','),
          )
          .join('\n') +
        '\n';
    } else if (format === 'markdown') {
      file = path.join(target, 'history-' + stamp + '.md');
      contents =
        '# Document history export\n\n' +
        'Exported ' +
        new Date().toISOString() +
        '. Range and filters as applied in the history panel.\n\n' +
        entries
          .map(
            (entry) =>
              '- `' +
              entry.shortCommit +
              '` ' +
              entry.at +
              ' — **' +
              entry.action +
              '** ' +
              entry.subject,
          )
          .join('\n') +
        '\n';
    } else {
      file = path.join(target, 'history-' + stamp + '.json');
      contents = JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2) + '\n';
    }

    await writeFileAtomic(file, contents);
    return { file, entryCount: entries.length, format };
  });

  ipcMain.handle(IPC.historyHealth, () => gitHistory.health());
}
