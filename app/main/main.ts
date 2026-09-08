/**
 * Main process entry point.
 *
 * Window security is set explicitly rather than relying on defaults, because a
 * default that changes between Electron majors changes the security posture of
 * the whole application without anybody editing this file.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { readFeed } from '../shared/updates.js';
import { checkForUpdate, downloadUpdate } from './updates/update-service.js';
import packageJson from '../../package.json' with { type: 'json' };
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { IPC, type BuildProvenance } from '../shared/ipc.js';
import { SettingsService } from './settings/settings-service.js';
import { registerDocumentHandlers } from './documents/document-handlers.js';
import { registerHistoryHandlers } from './history/history-handlers.js';
import { registerAuditHandlers } from './governance/audit-handlers.js';
import { registerVocabularyHandlers } from './vocabulary/vocabulary-handlers.js';
import { configureDataRoot, dataRoot, SHIPPED_PRODUCT_NAME } from './storage/paths.js';

/**
 * The dist root, resolved from this file at run time.
 *
 * __dirname rather than import.meta.url: this bundle is emitted as CommonJS,
 * and import.meta is EMPTY in a CJS output. esbuild warns about it, but the
 * failure it produces at run time is a path resolved from undefined, which
 * surfaces as a window that never loads rather than as an error naming the
 * cause. main.cjs sits at dist/main/, so one dirname reaches dist.
 */
declare const __dirname: string;
const DIST = path.dirname(__dirname);

const settingsService = new SettingsService();
let mainWindow: BrowserWindow | null = null;

/**
 * Read the provenance frozen into this artifact at build time.
 *
 * A missing or unparseable file yields nulls, and the front screen then shows an
 * honest unavailable state. It never falls back to the current time: an invented
 * timestamp is indistinguishable from a real one to a reader, which makes it
 * worse than no timestamp at all.
 */
function readProvenance(): BuildProvenance {
  const unavailable: BuildProvenance = {
    schema: 'material-workspace/provenance@1',
    version: null,
    commit: null,
    commitShort: null,
    branch: null,
    builtAt: null,
    builtAtSource: null,
    treeDirty: null,
    signed: false,
    signingNote:
      'Code signing is permanently out of scope for this project. Installers are unsigned and Windows will show an unknown-publisher warning.',
  };
  try {
    const raw = fs.readFileSync(path.join(DIST, 'provenance.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuildProvenance>;
    return { ...unavailable, ...parsed, signed: false };
  } catch {
    return unavailable;
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#101418',
    // A custom Material title bar is product chrome; the operating system's own
    // title bar is never exposed as this application's chrome.
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(DIST, 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  const emitState = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC.windowStateChanged, {
      maximised: window.isMaximized(),
      fullScreen: window.isFullScreen(),
      focused: window.isFocused(),
    });
  };
  window.on('maximize', emitState);
  window.on('unmaximize', emitState);
  window.on('enter-full-screen', emitState);
  window.on('leave-full-screen', emitState);
  window.on('focus', emitState);
  window.on('blur', emitState);

  // Nothing in this application opens a third-party page in-process.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  void window.loadFile(path.join(DIST, 'renderer', 'index.html'));
  return window;
}

function registerCoreHandlers(): void {
  ipcMain.handle(IPC.provenanceGet, () => readProvenance());

  ipcMain.handle(IPC.settingsGet, () => settingsService.snapshot());
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) {
      throw new Error('settings update requires an object patch');
    }
    return settingsService.update((current) => ({
      ...current,
      ...(patch as Record<string, unknown>),
    }) as typeof current);
  });
  ipcMain.handle(IPC.settingsResetKey, async (_event, dotted: unknown) => {
    if (typeof dotted !== 'string') throw new Error('reset requires a settings key');
    return settingsService.resetKey(dotted);
  });
  ipcMain.handle(IPC.settingsResetAll, () => settingsService.resetAll());

  ipcMain.handle(IPC.windowMinimise, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IPC.windowToggleMaximise, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  /**
   * Open a link in the user's own browser.
   *
   * ALLOWLISTED, because handing a renderer an arbitrary-URL opener is a hole
   * rather than a convenience: `file:` reads the disk, a custom scheme can
   * launch another installed application, and `javascript:` is what it sounds
   * like. What this needs to open is a commit on the repository the changelog
   * was generated from, so that is all it opens.
   */
  ipcMain.handle(IPC.shellOpenExternal, async (_event, raw: unknown) => {
    if (typeof raw !== 'string') return { opened: false, reason: 'not a link' };

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { opened: false, reason: 'not a link' };
    }

    // Scheme first. Everything else is only meaningful once the scheme is one
    // a browser would treat as a web page.
    if (url.protocol !== 'https:') {
      return { opened: false, reason: 'only https links are opened' };
    }
    // Exact host, not a suffix match: `github.com.example.invalid` ends with
    // the string and is somebody else's machine entirely.
    if (url.hostname !== 'github.com') {
      return { opened: false, reason: 'only links to the repository host are opened' };
    }
    if (url.username !== '' || url.password !== '') {
      return { opened: false, reason: 'links carrying credentials are refused' };
    }

    await shell.openExternal(url.toString());
    return { opened: true, reason: null };
  });

  /**
   * Whether assistive technology is attached.
   *
   * Read from the operating system through Electron rather than guessed in the
   * renderer. A guess here would be a guess about somebody's accessibility
   * setup, which is the last thing to guess about - and the consequence of
   * getting it wrong is the narrator talking over the screen reader they
   * actually rely on.
   */
  /**
   * Where releases live, read from the package rather than hard-coded.
   *
   * A slug typed into the source is a slug that stops matching the moment the
   * the repository is renamed or forked, and the symptom is an updater that checks
   * somebody else's releases - or nobody's - without saying so.
   */
  const releaseSlug = (): string | null => {
    const raw = (packageJson as { repository?: { url?: unknown } }).repository?.url;
    if (typeof raw !== 'string') return null;
    const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(raw);
    return match === null ? null : match[1] + '/' + match[2];
  };

  /**
   * The update handlers.
   *
   * Checking and downloading only. NOTHING here installs, runs the installer,
   * or restarts the application - the staged file waits in the data folder
   * until somebody presses the button, because an application that installs
   * itself has decided its convenience outranks whatever the person had open.
   */
  ipcMain.handle(IPC.updateCheck, async () => {
    const slug = releaseSlug();
    if (slug === null) {
      return { ok: false, reason: 'this build names no release repository', offline: false };
    }
    return checkForUpdate({ slug }, app.getVersion());
  });

  ipcMain.handle(IPC.updateDownload, async (event, raw: unknown) => {
    // Re-validated here rather than trusted from the renderer. A release object
    // arriving over IPC is input like any other, and this one names a URL that
    // is about to be fetched.
    const feed = readFeed(raw, '0.0.0');
    if (!feed.ok) return { ok: false, path: null, reason: feed.reason };

    const into = path.join(dataRoot(), 'updates');
    return downloadUpdate(feed.release, into, {
      onProgress: (fraction) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.updateProgress, { fraction });
        }
      },
    });
  });

  ipcMain.handle(IPC.updateStaged, async () => {
    const into = path.join(dataRoot(), 'updates');
    try {
      const names = await fs.promises.readdir(into);
      return { staged: names.filter((name) => name.endsWith('.exe')) };
    } catch {
      // A missing folder is "nothing staged", which is the ordinary case
      // rather than a failure worth reporting.
      return { staged: [] };
    }
  });

  /**
   * Run a staged installer and quit.
   *
   * Every part of this is deliberate:
   *
   *   - Only a file the updater itself staged may be run. The renderer names
   *     one, and the name is resolved INSIDE the staging directory and checked
   *     to be there - handing a renderer "run this path" would be handing it
   *     arbitrary code execution with the application's own privileges.
   *   - The application QUITS rather than staying open. A Windows installer
   *     cannot replace files a running process holds, so staying would produce
   *     an install that half works and reports success.
   *   - It runs only when asked. Nothing on this path fires on a timer.
   */
  ipcMain.handle(IPC.updateInstall, async (_event, raw: unknown) => {
    if (typeof raw !== 'string' || raw === '') {
      return { started: false, reason: 'no staged installer was named' };
    }

    const into = path.join(dataRoot(), 'updates');
    // Resolved from the BASENAME, so a name carrying separators or parent
    // references cannot reach outside the staging folder however it is spelt.
    const resolved = path.join(into, path.basename(raw));
    if (path.dirname(resolved) !== into || !resolved.toLowerCase().endsWith('.exe')) {
      return { started: false, reason: 'that is not a staged installer' };
    }
    if (!fs.existsSync(resolved)) {
      return { started: false, reason: 'that installer is no longer staged' };
    }

    const error = await shell.openPath(resolved);
    if (error !== '') return { started: false, reason: error };

    // Quit AFTER the installer has been handed off, and on a tick, so this
    // reply reaches the renderer before the process goes.
    setTimeout(() => app.quit(), 250);
    return { started: true, reason: null };
  });

  // Pushed when it CHANGES, not only polled. Somebody turning a screen reader
  // on mid-session must not have to restart the application before the
  // narrator stops talking over it.
  app.on('accessibility-support-changed', (_event, enabled) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.accessibilityChanged, { screenReaderActive: enabled });
    }
  });

  ipcMain.handle(IPC.accessibilityState, () => ({
    screenReaderActive: app.accessibilitySupportEnabled,
  }));

  ipcMain.handle(IPC.shellDataFolderPath, () => {
    // The real path, so recovery advice can name the folder rather than
    // gesturing at "app data". Somebody who has to find it while locked out is
    // exactly the person least able to go hunting for it.
    return { path: dataRoot() };
  });

  ipcMain.handle(IPC.shellOpenDataFolder, async () => {
    const target = dataRoot();
    await fs.promises.mkdir(target, { recursive: true });
    // Open the folder and stand back. The application never deletes it for the
    // user; that deletion is the user's own act in their own file manager.
    const error = await shell.openPath(target);
    return { path: target, opened: error === '', error: error === '' ? null : error };
  });
  ipcMain.handle(IPC.shellRevealPath, (_event, target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error('a path is required');
    }
    shell.showItemInFolder(target);
    return { revealed: true };
  });
}

function forwardSettingsChanges(): void {
  settingsService.on('changed', (snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.settingsChanged, snapshot);
    }
  });
}

// A second instance must not race the first over the same data directory or the
// same history repository.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.setName(SHIPPED_PRODUCT_NAME);

  app.whenReady().then(async () => {
    // The storage layer does not import Electron, so the process that knows
    // the platform path injects it once, here, before anything reads a path.
    configureDataRoot(app.getPath('appData'));
    await settingsService.initialise();
    registerCoreHandlers();
    registerDocumentHandlers(ipcMain);
    registerHistoryHandlers(ipcMain, settingsService);
    registerAuditHandlers(ipcMain);
    registerVocabularyHandlers(ipcMain, settingsService);
    forwardSettingsChanges();

    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => settingsService.dispose());
}
