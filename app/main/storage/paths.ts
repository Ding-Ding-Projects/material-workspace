/**
 * Where this application keeps its own data.
 *
 * Two rules are load-bearing here.
 *
 * 1. IDENTITY and DISPLAY are separate values and neither may read the other.
 *
 *    The user can rename this application — it is a label, and every other label
 *    the app renders is theirs to change. But a rename must move nothing: not
 *    the directory data lives in, not the installer or package identifier, not
 *    the update feed. A project whose data directory was derived from its
 *    product name discovers, the first time somebody renames it, that every
 *    stored profile, credential and history has been orphaned.
 *
 * 2. This module does NOT import Electron.
 *
 *    Storage is not a GUI concern. Importing the app object here would drag the
 *    whole framework into every module that needs a path — including the history
 *    engine, whose tests must be able to run under plain Node against a real git
 *    binary. The base directory is injected once at startup by the process that
 *    genuinely knows it, and there is a correct platform fallback for every
 *    other caller.
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Immutable. Renaming the app must never change this value. */
export const APPLICATION_IDENTITY = 'material-workspace';

/** The shipped name. Used where the REAL product must be identified — a
 *  diagnostic report, a crash log, an issue the user files — because a reader
 *  of those has no idea what a renamed title refers to. */
export const SHIPPED_PRODUCT_NAME = 'Material Workspace';

let configuredRoot: string | null = null;

/**
 * Called once from the main process with the platform's per-user data
 * directory. Everything else derives from it.
 */
export function configureDataRoot(baseDirectory: string): void {
  configuredRoot = path.join(baseDirectory, APPLICATION_IDENTITY);
}

/** Used by tests to point the whole tree at a temporary directory. */
export function overrideDataRootForTesting(absoluteRoot: string): void {
  configuredRoot = absoluteRoot;
}

function platformFallback(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, APPLICATION_IDENTITY);
    return path.join(os.homedir(), 'AppData', 'Roaming', APPLICATION_IDENTITY);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APPLICATION_IDENTITY);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg ?? path.join(os.homedir(), '.config'), APPLICATION_IDENTITY);
}

/** Root of everything this application owns on disk. */
export function dataRoot(): string {
  return configuredRoot ?? platformFallback();
}

/** Settings, appearance, locks and other small persisted state. */
export function settingsDir(): string {
  return path.join(dataRoot(), 'settings');
}

/** The isolated Git repository that carries document autosave history.
 *  Deliberately NOT inside any folder the user owns. */
export function historyRepoDir(): string {
  return path.join(dataRoot(), 'history');
}

/** Documents created inside the application, before the user exports them. */
export function workspaceDir(): string {
  return path.join(dataRoot(), 'workspace');
}

/** Derived caches. Safe to delete; never the only copy of anything. */
export function cacheDir(): string {
  return path.join(dataRoot(), 'cache');
}

/** The tamper-evident governance audit log. */
export function auditDir(): string {
  return path.join(dataRoot(), 'audit');
}

/** Where the recovery route tells a locked-out user to look. Shown verbatim in
 *  the unlock prompt and in Support Tickets, because "app data" is not an
 *  instruction anybody can follow. */
export function recoveryFolderForDisplay(): string {
  return dataRoot();
}
