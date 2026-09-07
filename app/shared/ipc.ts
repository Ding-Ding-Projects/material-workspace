/**
 * The complete list of channels crossing the process boundary.
 *
 * One list, in shared code, so the preload bridge and the main-process handlers
 * cannot drift. A unit test that injects a fake bridge proves the screen and
 * nothing about this seam, so the seam is kept small enough to read and is
 * exercised against the real built application rather than a stub.
 */

export const IPC = {
  provenanceGet: 'provenance:get',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsResetKey: 'settings:reset-key',
  settingsResetAll: 'settings:reset-all',
  settingsChanged: 'settings:changed',

  windowMinimise: 'window:minimise',
  windowToggleMaximise: 'window:toggle-maximise',
  windowClose: 'window:close',
  windowStateChanged: 'window:state-changed',

  documentList: 'document:list',
  documentCreate: 'document:create',
  documentOpen: 'document:open',
  documentSave: 'document:save',
  documentRename: 'document:rename',
  documentDelete: 'document:delete',

  historyList: 'history:list',
  historyDiff: 'history:diff',
  historyRestore: 'history:restore',
  historyLabel: 'history:label',
  historyPrune: 'history:prune',
  historyExport: 'history:export',
  historyHealth: 'history:health',

  vocabularyLoad: 'vocabulary:load',
  vocabularyClear: 'vocabulary:clear',
  vocabularyState: 'vocabulary:state',

  shellOpenDataFolder: 'shell:open-data-folder',
  /** The data folder's real path, so recovery advice can NAME it. */
  shellDataFolderPath: 'shell:data-folder-path',
  shellRevealPath: 'shell:reveal-path',
  /** Open an https link in the user's own browser, allowlisted. */
  shellOpenExternal: 'shell:open-external',

  auditAppend: 'audit:append',
  auditList: 'audit:list',
  auditVerify: 'audit:verify',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface BuildProvenance {
  schema: 'material-workspace/provenance@1';
  version: string | null;
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  /** UTC ISO 8601. The moment the running artifact was built — never launch
   *  time, never a file mtime. Null when it genuinely could not be resolved,
   *  so the front screen shows an honest unavailable state. */
  builtAt: string | null;
  builtAtSource: 'release-pipeline' | 'commit-date' | 'build-clock' | null;
  treeDirty: boolean | null;
  signed: false;
  signingNote: string;
}

export interface DocumentSummary {
  id: string;
  application: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
}

export type HistoryAction =
  | 'created'
  | 'autosaved'
  | 'updated'
  | 'renamed'
  | 'deleted'
  | 'restored'
  | 'discarded'
  | 'imported'
  | 'settings-changed'
  | 'label-added';

export interface HistoryEntry {
  commit: string;
  shortCommit: string;
  action: HistoryAction;
  subject: string;
  documentId: string | null;
  at: string;
  label: string | null;
}

export interface HistoryHealth {
  available: boolean;
  repositoryPath: string;
  commitCount: number | null;
  /** Named exactly when unavailable, so a broken history reads as a diagnosis
   *  rather than as an empty archive. */
  reason: string | null;
}
