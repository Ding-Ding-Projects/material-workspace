/**
 * Renderer entry point: boots the shell and renders the front screen.
 *
 * The front screen shows the running version and that version's build time
 * BEFORE any navigation, settings or authentication. That ordering is the whole
 * point — a version buried in an About dialog answers the question only for
 * somebody who already knows to ask it.
 */

import './styles/tokens.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/attention.css';
import './styles/writer.css';
import './styles/sheets.css';
import './styles/slides.css';
import './styles/notes.css';
import './styles/draw.css';
import './styles/formula.css';
import './styles/database.css';
import './styles/forms.css';
import './styles/pdf.css';
import './styles/colour-picker.css';
import './styles/appearance.css';
import './styles/narrator.css';
import './styles/tab-search.css';
import './styles/locks.css';
import './styles/history.css';
import './styles/changelog.css';
import './styles/update-banner.css';
import './styles/surface.css';
import './styles/collaboration.css';
import './styles/governance.css';

import { clear, el, formatInstant, mount, timezoneName } from './dom.js';
import { SearchField, applyPredicate, type SearchPredicate } from './components/search-field.js';
import { CommandPalette } from './components/palette/palette.js';
import { TabStrip } from './components/tabs.js';
import { SettingsSurface } from './components/settings-surface.js';
import { ContextMenu, type MenuItem } from './components/context-menu.js';
import { ElementAppearance } from './components/element-appearance.js';
import { type LayerBook, compose, layersFor } from '../shared/element-layers.js';
import {
  type ElementStep,
  type PresetBook,
  type StyleBook,
  copyStyle,
  countOverrides,
  declarationsFor,
  resetElement,
  styleIdFor,
} from '../shared/element-style.js';
import { Notifications, NotificationCentre } from './components/notifications.js';
import { AttentionModes } from './adhd.js';
import { Writer } from './apps/writer/writer.js';
import { Sheets } from './apps/sheets/sheets.js';
import { Slides } from './apps/slides/slides.js';
import { Notes } from './apps/notes/notes.js';
import { Draw } from './apps/draw/draw.js';
import { Formula } from './apps/formula/formula.js';
import { DatabaseApp } from './apps/database/database.js';
import { Forms } from './apps/forms/forms.js';
import { PdfApp } from './apps/pdf/pdf.js';
import { SuperConfirm } from './components/super-confirm.js';
import { Appearance } from './components/appearance.js';
import { NarratorSurface, browserVoices } from './components/narrator-surface.js';
import { TabSearch } from './components/tab-search.js';
import { LocksSurface } from './components/locks-surface.js';
import { HistoryPanel } from './components/history-panel.js';
import { Changelog } from './components/changelog.js';
import { UpdateBanner } from './components/update-banner.js';
import type { HistoryPanelOptions as HistoryPanelBridge } from './components/history-panel.js';
import type { StripState, TabRecord } from './tabs/model.js';
import { AUTOMATIC } from './narrator/narrator.js';
import { nextCheckDelay } from '../shared/updates.js';
import { effectiveFunnyLevel, effectiveMode, type SchoolState } from '../shared/school.js';
import { NarratorQueue, DEFAULT_PREFERENCE } from './narrator/narrator.js';
import { SAMPLE, browserSpeech } from './narrator/speech.js';
import { Collaboration } from './components/collaboration.js';
import { Governance } from './components/governance.js';
import { registerPaletteEntries } from './palette-entries.js';
import { I18n, MESSAGES, PLURAL_MESSAGES, type Message } from './i18n.js';
import {
  APPLICATION_IDS,
  defaultSettings,
  type ApplicationId,
  type WorkspaceSettings,
} from '../shared/settings.js';
import type {
  BuildProvenance,
  HistoryAction,
  HistoryEntry,
  HistoryHealth,
} from '../shared/ipc.js';

interface SettingsSnapshot {
  settings: WorkspaceSettings;
  provenance: Record<string, 'written' | 'default'>;
  loadFailure: string | null;
}

interface WorkspaceBridge {
  provenance: { get(): Promise<BuildProvenance> };
  settings: {
    get(): Promise<SettingsSnapshot>;
    update(patch: unknown): Promise<SettingsSnapshot>;
    resetKey(dotted: string): Promise<SettingsSnapshot>;
    resetAll(): Promise<SettingsSnapshot>;
    onChanged(listener: (payload: unknown) => void): () => void;
  };
  window: {
    minimise(): Promise<void>;
    toggleMaximise(): Promise<void>;
    close(): Promise<void>;
    onStateChanged(listener: (payload: unknown) => void): () => void;
  };
  history: {
    list(query: {
      limit?: number;
      since?: string;
      until?: string;
      actions?: HistoryAction[];
    }): Promise<{
      entries: HistoryEntry[];
      observedActions: { action: HistoryAction; count: number }[];
    }>;
    diff(commit: string): Promise<string>;
    restore(payload: { commit: string }): Promise<unknown>;
    label(payload: { commit: string; label: string }): Promise<unknown>;
    export(payload: { format: string }): Promise<unknown>;
    health(): Promise<HistoryHealth>;
  };
  vocabulary: {
    state(): Promise<{ state: unknown; entries: Record<string, string> }>;
  };
  shell: {
    openDataFolder(): Promise<{ path: string; opened: boolean; error: string | null }>;
    dataFolderPath(): Promise<{ path: string }>;
    openExternal(url: string): Promise<{ opened: boolean; reason: string | null }>;
  };
  accessibility: {
    state(): Promise<{ screenReaderActive: boolean }>;
    onChanged(listener: (payload: unknown) => void): () => void;
  };
  updates: {
    check(): Promise<{ ok: boolean; release?: unknown; reason?: string; offline?: boolean }>;
    download(release: unknown): Promise<{ ok: boolean; path: string | null; reason: string }>;
    staged(): Promise<{ staged: string[] }>;
    install(file: string): Promise<{ started: boolean; reason: string | null }>;
    onProgress(listener: (payload: unknown) => void): () => void;
  };
}

declare global {
  interface Window {
    workspace: WorkspaceBridge;
  }
}

/** Which applications are genuinely usable in this build. An entry here is a
 *  claim that the application opens and does its job; it is never set ahead of
 *  the implementation to make the grid look complete. */
const AVAILABLE: ReadonlySet<ApplicationId> = new Set<ApplicationId>([
  'writer',
  'sheets',
  'slides',
  'notes',
  'draw',
  'formula',
  'database',
  'forms',
  'pdf',
]);

const APPLICATION_COPY: Record<ApplicationId, { name: Message; summary: Message }> = {
  writer: { name: MESSAGES['app.writer.name'], summary: MESSAGES['app.writer.summary'] },
  sheets: { name: MESSAGES['app.sheets.name'], summary: MESSAGES['app.sheets.summary'] },
  slides: { name: MESSAGES['app.slides.name'], summary: MESSAGES['app.slides.summary'] },
  draw: { name: MESSAGES['app.draw.name'], summary: MESSAGES['app.draw.summary'] },
  formula: { name: MESSAGES['app.formula.name'], summary: MESSAGES['app.formula.summary'] },
  database: { name: MESSAGES['app.database.name'], summary: MESSAGES['app.database.summary'] },
  pdf: { name: MESSAGES['app.pdf.name'], summary: MESSAGES['app.pdf.summary'] },
  notes: { name: MESSAGES['app.notes.name'], summary: MESSAGES['app.notes.summary'] },
  forms: { name: MESSAGES['app.forms.name'], summary: MESSAGES['app.forms.summary'] },
};

const APPLICATION_ICON: Record<ApplicationId, string> = {
  writer: '\u{1F4C4}',
  sheets: '\u{1F4CA}',
  slides: '\u{1F4FD}',
  draw: '\u{270F}',
  formula: '\u{1F9EE}',
  database: '\u{1F5C3}',
  pdf: '\u{1F4D5}',
  notes: '\u{1F5D2}',
  forms: '\u{1F4CB}',
};

class Shell {
  private readonly root: HTMLElement;
  private i18n: I18n;
  private settings: WorkspaceSettings;
  private provenance: BuildProvenance;
  private historyHealth: HistoryHealth | null = null;
  private maximised = false;
  private applicationSearch: SearchField | null = null;
  private settingsProvenance: Record<string, 'written' | 'default'> = {};
  palette: CommandPalette | null = null;
  private tabs: TabStrip | null = null;
  onResetAll: (() => void) | null = null;
  /**
   * Write a settings patch. Mirrors onResetAll rather than reaching for the
   * bridge directly, so a surface inside the shell never has to know whether
   * it is running in Electron or in a test.
   */
  onPatch: ((patch: Partial<WorkspaceSettings>) => void) | null = null;
  onOpenDataFolder: (() => void) | null = null;
  private dataFolder: string | null = null;

  setDataFolder(path: string): void {
    this.dataFolder = path;
    // The locks surface is rebuilt so its recovery lines carry the real path.
    this.locksTab = null;
    this.render();
  }
  /** Survives the rebuild that every settings change triggers. */
  private settingsSection = 'language';
  /** Kept across renders so a document survives switching tabs. */
  private writer: Writer | null = null;
  private sheets: Sheets | null = null;
  private slides: Slides | null = null;
  private notes: Notes | null = null;
  private draw: Draw | null = null;
  private formula: Formula | null = null;
  private database: DatabaseApp | null = null;
  private forms: Forms | null = null;
  private pdf: PdfApp | null = null;
  /**
   * Kept across renders, exactly as the applications are.
   *
   * Writing a setting triggers a settings-changed event, which re-renders the
   * shell. Rebuilding the picker there would throw away the colour somebody
   * had just chosen and snap it back to whatever was last persisted - which,
   * mid-round-trip, is the OLD value. The surface would appear to reject the
   * choice it had just accepted. The settings surface already carries the same
   * scar in its initialSection comment.
   */
  private appearanceTab: Appearance | null = null;

  /** Kept across renders too, and disposed when the shell tears down. */
  private narratorTab: NarratorSurface | null = null;

  /** The tabs as the search model sees them. */
  private tabRecords(): TabRecord[] {
    return (this.tabs?.definitions() ?? []).map((tab) => ({
      id: tab.id,
      label: tab.label,
      searchText: tab.searchText,
    }));
  }

  /** The strip's stored order, pinning and grouping. */
  private stripState(): StripState {
    return {
      order: this.settings.tabs.order,
      pinned: this.tabs?.pinnedIds ?? this.settings.tabs.pinned,
      groups: this.settings.tabs.groups,
      collapsed: this.settings.tabs.collapsedGroups,
    };
  }
  private tabSearchTab: TabSearch | null = null;
  private locksTab: LocksSurface | null = null;
  private historyTab: HistoryPanel | null = null;
  private changelogTab: Changelog | null = null;
  onOpenExternal: ((url: string) => void) | null = null;
  onCopyText: ((text: string) => void) | null = null;

  /**
   * The update banner. Built once and kept, because a banner rebuilt on every
   * render forgets that somebody pressed Later.
   */
  readonly updates: UpdateBanner = new UpdateBanner({
    // Filled in from the artifact's own provenance once the shell has it.
    current: 'unknown',
    onCheck: () => this.onCheckForUpdates?.(),
    onDownload: () => this.onDownloadUpdate?.(),
    onRestart: () => this.onRestartForUpdate?.(),
    onOpenNotes: (url) => this.onOpenExternal?.(url),
    // Asked BEFORE restarting, because there is no after: the process is gone.
    canRestart: () => this.onHasUnsavedWork?.() !== true,
  });

  onCheckForUpdates: (() => void) | null = null;
  onDownloadUpdate: (() => void) | null = null;
  onRestartForUpdate: (() => void) | null = null;
  onHasUnsavedWork: (() => boolean) | null = null;

  /** Told by the host, never guessed. Yields the narrator while it is true. */
  setScreenReaderActive(active: boolean): void {
    this.narratorQueue.setScreenReaderActive(active);
  }
  historyBridge: HistoryPanelBridge | null = null;

  /**
   * One queue for the whole shell, so nothing ever overlaps.
   *
   * It reads the surface's CURRENT state rather than a captured copy: the
   * preference can change between queuing a line and speaking it, and a
   * captured one would speak in the voice that was chosen a moment ago.
   */
  private readonly narratorQueue = new NarratorQueue(
    browserSpeech(),
    (lang) => {
      const current = this.narratorTab?.state();
      if (current === undefined) return DEFAULT_PREFERENCE;
      return lang === 'en' ? current.english : current.cantonese;
    },
    (lang) => {
      const current = this.narratorTab?.state();
      const uri = current === undefined
        ? AUTOMATIC
        : lang === 'en'
          ? current.english.voiceUri
          : current.cantonese.voiceUri;
      return uri === AUTOMATIC ? null : uri;
    },
  );
  readonly notifications = new Notifications();
  readonly attention = new AttentionModes();

  constructor(
    root: HTMLElement,
    settings: WorkspaceSettings,
    provenance: BuildProvenance,
    vocabulary: Record<string, string>,
  ) {
    this.root = root;
    this.settings = settings;
    this.provenance = provenance;
    this.i18n = new I18n({ ...Shell.languageInputs(settings), vocabulary });
  }

  /**
   * What the language layer is actually given, School mode included.
   *
   * ONE function, used by the constructor and by applySettings, because they
   * previously built the same object twice. Two copies of a rule is one copy
   * that eventually stops matching the other, and here the symptom would be
   * School mode applying on a settings change but not on a fresh launch -
   * which is the launch a school actually cares about.
   *
   * The stored values are NEVER overwritten. Forcing English while the mode is
   * on and reading the user's own choice again when it is off is what makes a
   * term of School mode cost nobody the language they read in.
   */
  private static languageInputs(settings: WorkspaceSettings): {
    mode: WorkspaceSettings['languageMode'];
    englishLevel: WorkspaceSettings['funnyLevels']['english'];
    cantoneseLevel: WorkspaceSettings['funnyLevels']['cantonese'];
  } {
    const school: SchoolState = {
      enabled: settings.schoolMode.enabled,
      displayName: settings.schoolMode.displayName,
    };
    return {
      mode: effectiveMode(settings.languageMode, school),
      englishLevel: effectiveFunnyLevel(settings.funnyLevels.english, school),
      cantoneseLevel: effectiveFunnyLevel(settings.funnyLevels.cantonese, school),
    };
  }

  applySettings(settings: WorkspaceSettings): void {
    this.settings = settings;
    this.i18n.update(Shell.languageInputs(settings));
    this.applyDocumentAttributes();
    this.render();
  }

  /**
   * Push settings onto the document element, where the stylesheet reads them.
   * Every attribute set here has a rule that consumes it — a token nothing reads
   * is a control that silently does nothing, and no screenshot reveals it.
   */
  private applyDocumentAttributes(): void {
    const html = document.documentElement;
    const appearance = this.settings.appearance;

    const resolvedTheme =
      appearance.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : appearance.theme;

    html.setAttribute('data-theme', resolvedTheme);
    html.setAttribute('data-density', appearance.density);
    // The EFFECTIVE language, not the stored one. Setting the stored value here
    // would leave the stylesheet laying out for bilingual while every string
    // rendered in English - the layout reserving room for a second line that
    // never arrives.
    html.setAttribute('data-language', Shell.languageInputs(this.settings).mode);
    html.setAttribute('data-school', this.settings.schoolMode.enabled ? 'on' : 'off');
    html.setAttribute('data-tab-edge', this.settings.tabs.edge);
    html.setAttribute('data-reduced-motion', appearance.reducedMotion);
    html.setAttribute('data-rainbow-speed', String(appearance.rainbowSpeedLevel));
    html.setAttribute('data-rainbow', appearance.seedColor === 'rainbow' ? 'on' : 'off');
    html.style.setProperty('--workspace-font-scale', String(appearance.fontScale));
    if (appearance.fontFamily) {
      html.style.setProperty('--md-sys-typescale-plain-family', appearance.fontFamily);
    } else {
      html.style.removeProperty('--md-sys-typescale-plain-family');
    }
    html.lang = Shell.languageInputs(this.settings).mode === 'yue' ? 'zh-HK' : 'en';

    // The five attention switches have real readers in attention.css. Applying
    // them here is what stops them being controls that persist a value and
    // change nothing.
    this.attention.apply(this.settings.adhd);
  }

  currentSettings(): WorkspaceSettings {
    return this.settings;
  }

  currentProvenance(): Record<string, 'written' | 'default'> {
    return this.settingsProvenance;
  }

  setProvenance(provenance: Record<string, 'written' | 'default'>): void {
    this.settingsProvenance = provenance;
  }

  translator(): I18n {
    return this.i18n;
  }

  setWindowState(maximised: boolean): void {
    this.maximised = maximised;
    this.render();
  }

  setHistoryHealth(health: HistoryHealth): void {
    this.historyHealth = health;
    this.render();
  }

  /** The name shown to the user. Falls back to the shipped name; never used to
   *  derive a path, an identifier or an update feed. */
  private displayName(): string {
    return this.settings.displayName ?? this.i18n.t(MESSAGES['shell.appName']);
  }

  private label(message: Message, values: Record<string, string | number> = {}): HTMLElement {
    const primary = this.i18n.t(message, values);
    const secondary = this.i18n.secondary(message, values);
    if (secondary === null) return el('span', { text: primary });
    // Bilingual mode must not crowd the interface, so the secondary string is a
    // compact separate element rather than a longer concatenated label.
    return el('span', { class: 'bilingual' }, [
      el('span', { class: 'bilingual__primary', text: primary }),
      el('span', { class: 'bilingual__secondary', text: secondary }),
    ]);
  }

  private titleBar(): HTMLElement {
    const control = (
      key: 'shell.minimise' | 'shell.maximise' | 'shell.restore' | 'shell.close',
      glyph: string,
      onClick: () => void,
      extraClass = '',
    ): HTMLElement => {
      const button = el('button', {
        class: 'window-control ' + extraClass,
        type: 'button',
        'aria-label': this.i18n.accessible(MESSAGES[key]),
        title: this.i18n.accessible(MESSAGES[key]),
      });
      button.textContent = glyph;
      button.addEventListener('click', onClick);
      return button;
    };

    return el('header', { class: 'title-bar' }, [
      el('div', { class: 'title-bar__identity' }, [
        el('span', { class: 'title-bar__name', text: this.displayName() }),
      ]),
      el('div', { class: 'title-bar__spacer' }),
      el('div', { class: 'title-bar__controls' }, [
        control('shell.minimise', '─', () => void window.workspace.window.minimise()),
        control(
          this.maximised ? 'shell.restore' : 'shell.maximise',
          this.maximised ? '❐' : '□',
          () => void window.workspace.window.toggleMaximise(),
        ),
        control(
          'shell.close',
          '✕',
          () => void window.workspace.window.close(),
          'window-control--close',
        ),
      ]),
    ]);
  }

  private provenanceCard(): HTMLElement {
    const built = formatInstant(this.provenance.builtAt);
    const facts = el('dl', { class: 'facts' });

    // The unavailable message is passed in per row. One shared message meant a
    // missing commit was explained with copy written about a missing build
    // TIME, which told the reader something that was not true of that field.
    const row = (
      labelMessage: Message,
      value: string,
      unavailable = false,
      unavailableMessage: Message = MESSAGES['front.valueUnknown'],
    ): void => {
      facts.append(
        el('dt', {}, [this.label(labelMessage)]),
        el('dd', { 'data-unavailable': unavailable ? 'true' : 'false' }, [
          unavailable ? this.label(unavailableMessage) : document.createTextNode(value),
        ]),
      );
    };

    row(MESSAGES['front.version'], this.provenance.version ?? '', this.provenance.version === null);
    row(
      MESSAGES['front.updatedAt'],
      built.unavailable ? '' : built.text + ' (' + timezoneName() + ')',
      built.unavailable,
      MESSAGES['front.provenanceUnknown'],
    );
    row(
      MESSAGES['front.commit'],
      this.provenance.commitShort ?? '',
      this.provenance.commitShort === null,
    );
    row(MESSAGES['front.branch'], this.provenance.branch ?? '', this.provenance.branch === null);
    row(MESSAGES['front.signing'], this.i18n.t(MESSAGES['front.unsigned']));

    const card = el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, [this.label(MESSAGES['front.buildTitle'])]),
      facts,
    ]);

    if (this.provenance.treeDirty === true) {
      card.append(
        el('p', { class: 'notice notice--warning' }, [
          this.label(MESSAGES['front.treeDirtyWarning']),
        ]),
      );
    }
    return card;
  }

  /**
   * Render the application grid under the current filter.
   *
   * Separate from the card so filtering re-renders only the grid. Re-rendering
   * the whole card would destroy the search field the user is typing in, which
   * is a class of bug that looks like the keyboard dropping characters.
   */
  private renderApplicationGrid(grid: HTMLElement, predicate: SearchPredicate | null): void {
    clear(grid);

    const entries = APPLICATION_IDS.map((id) => ({
      id,
      // Search covers BOTH languages regardless of the active mode, so a
      // Cantonese term finds its application while the interface is in English.
      text: [
        this.i18n.english(APPLICATION_COPY[id].name),
        this.i18n.cantonese(APPLICATION_COPY[id].name),
        this.i18n.english(APPLICATION_COPY[id].summary),
        this.i18n.cantonese(APPLICATION_COPY[id].summary),
        id,
      ].join(' '),
    }));

    const visible = predicate
      ? applyPredicate(entries, predicate, (entry) => entry.text)
      : entries;

    if (visible.length === 0) {
      // An honest no-match message, never a blank surface. A blank one is
      // indistinguishable from a rendering failure.
      grid.append(
        el('p', {
          class: 'front__lede',
          role: 'status',
          text:
            predicate?.error !== null && predicate?.error !== undefined
              ? 'That pattern will not compile, so nothing was matched: ' + predicate.error
              : 'No application matches that search.',
        }),
      );
      return;
    }

    for (const entry of visible) {
      const id = entry.id;
      const available = AVAILABLE.has(id);
      const copy = APPLICATION_COPY[id];
      const card = el('button', {
        class: 'app-card',
        type: 'button',
        'data-application': id,
        'data-available': available ? 'true' : 'false',
        // A control that cannot act says exactly which condition is unmet, in
        // its own accessible description, rather than reading as broken.
        'aria-disabled': available ? 'false' : 'true',
      });
      card.append(
        el('span', { class: 'tab__icon', 'aria-hidden': 'true', text: APPLICATION_ICON[id] }),
        el('span', { class: 'app-card__name' }, [this.label(copy.name)]),
        el('span', { class: 'app-card__summary' }, [this.label(copy.summary)]),
        el('span', { class: 'app-card__state' }, [
          this.label(available ? MESSAGES['app.state.available'] : MESSAGES['app.state.building']),
        ]),
      );
      if (available) {
        card.addEventListener('click', () => this.tabs?.activate(id));
      } else {
        card.addEventListener('click', (event) => event.preventDefault());
      }
      grid.append(card);
    }
  }

  private applicationsCard(): HTMLElement {
    const grid = el('div', { class: 'app-grid' });

    // Every collection in this product carries its own search field with its own
    // anchored regular-expression builder. This one is not a demonstration: it
    // filters the grid beneath it.
    const search = new SearchField({
      id: 'application-search',
      label: 'Search applications',
      placeholder: 'Search applications',
      onChange: (predicate) => this.renderApplicationGrid(grid, predicate),
    });
    this.applicationSearch = search;

    this.renderApplicationGrid(grid, null);

    return el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, [this.label(MESSAGES['front.applicationsTitle'])]),
      el('p', { class: 'front__lede' }, [this.label(MESSAGES['front.applicationsLede'])]),
      search.element,
      grid,
    ]);
  }

  private statusBar(): HTMLElement {
    const bar = el('footer', { class: 'status-bar', role: 'status', 'aria-live': 'polite' });
    if (this.historyHealth === null) {
      bar.append(el('span', { text: '…' }));
      return bar;
    }
    if (this.historyHealth.available) {
      // Count-inflected, so a single entry does not read as "1 entries".
      const rendered = this.i18n.plural(
        PLURAL_MESSAGES['status.historyHealthy'],
        this.historyHealth.commitCount ?? 0,
      );
      const span = el('span', {});
      if (rendered.secondary === null) {
        span.textContent = rendered.primary;
      } else {
        span.append(
          el('span', { class: 'bilingual' }, [
            el('span', { class: 'bilingual__primary', text: rendered.primary }),
            el('span', { class: 'bilingual__secondary', text: rendered.secondary }),
          ]),
        );
      }
      bar.append(span);
    } else {
      bar.append(
        el('span', {}, [
          this.label(MESSAGES['status.historyUnavailable'], {
            reason: this.historyHealth.reason ?? 'unknown',
          }),
        ]),
      );
    }
    return bar;
  }

  private homePanel(): HTMLElement {
    return el('div', { class: 'front' }, [
      el('h1', { class: 'front__headline' }, [this.label(MESSAGES['front.headline'])]),
      el('p', { class: 'front__lede' }, [this.label(MESSAGES['front.lede'])]),
      this.provenanceCard(),
      this.applicationsCard(),
    ]);
  }

  render(): void {
    // The strip is rebuilt on every render, which is correct while the shell
    // itself owns so little state. The panels inside it are built once and kept
    // by TabStrip, so a tab's own state survives switching away and back.
    const previousTab = this.tabs?.active ?? 'home';

    this.tabs = new TabStrip({
      variant: 'main',
      edge: this.settings.tabs.edge,
      pinned: this.settings.tabs.pinned,
      tabs: [
        {
          id: 'home',
          label: this.i18n.t(MESSAGES['shell.homeTab']),
          searchText: [
            this.i18n.english(MESSAGES['shell.homeTab']),
            this.i18n.cantonese(MESSAGES['shell.homeTab']),
            'home start front build applications',
          ].join(' '),
          icon: '\u{1F3E0}',
          render: () => this.homePanel(),
        },
        {
          id: 'writer',
          label: this.i18n.t(MESSAGES['app.writer.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.writer.name']),
            this.i18n.cantonese(MESSAGES['app.writer.name']),
            'writer document word processor text 文書',
          ].join(' '),
          icon: APPLICATION_ICON.writer,
          fills: true,
          render: () => {
            // Built once and kept. Rebuilding on every render would discard
            // the document the user is typing into.
            if (!this.writer) {
              this.writer = new Writer({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.writer.element;
          },
        },
        {
          id: 'sheets',
          label: this.i18n.t(MESSAGES['app.sheets.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.sheets.name']),
            this.i18n.cantonese(MESSAGES['app.sheets.name']),
            'sheets spreadsheet grid formula cells calculate 試算表 公式',
          ].join(' '),
          icon: APPLICATION_ICON.sheets,
          fills: true,
          render: () => {
            // Built once and kept, for the same reason Writer is: rebuilding
            // would discard the workbook the user is working in.
            if (!this.sheets) {
              this.sheets = new Sheets({
                onChange: () => this.attention.recordActivity(),
                // Restored from the profile and written straight back to it,
                // so a column somebody widened is still that width tomorrow.
                columnWidths: Object.fromEntries(
                  Object.entries(this.settings.sheets.columnWidths).map(([key, width]) => [
                    Number(key),
                    width,
                  ]),
                ),
                onColumnWidths: (widths) => {
                  // The whole sub-object, because the patch REPLACES it: a
                  // patch carrying only the widths would drop every format the
                  // user had set, silently, the next time they dragged a
                  // column edge.
                  this.onPatch?.({
                    sheets: { ...this.settings.sheets, columnWidths: widths },
                  });
                },
                columnFormats: Object.fromEntries(
                  Object.entries(this.settings.sheets.columnFormats).map(([key, format]) => [
                    Number(key),
                    format,
                  ]),
                ) as never,
                onColumnFormats: (formats) => {
                  this.onPatch?.({
                    sheets: { ...this.settings.sheets, columnFormats: formats },
                  });
                },
              });
            }
            return this.sheets.element;
          },
        },
        {
          id: 'slides',
          label: this.i18n.t(MESSAGES['app.slides.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.slides.name']),
            this.i18n.cantonese(MESSAGES['app.slides.name']),
            'slides presentation deck present speaker notes 簡報 投影片',
          ].join(' '),
          icon: APPLICATION_ICON.slides,
          fills: true,
          render: () => {
            // Built once and kept, for the same reason as its siblings:
            // rebuilding would discard the deck being edited.
            if (!this.slides) {
              this.slides = new Slides({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.slides.element;
          },
        },
        {
          id: 'notes',
          label: this.i18n.t(MESSAGES['app.notes.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.notes.name']),
            this.i18n.cantonese(MESSAGES['app.notes.name']),
            'notes markdown tags links backlinks 筆記 標籤',
          ].join(' '),
          icon: APPLICATION_ICON.notes,
          fills: true,
          render: () => {
            if (!this.notes) {
              this.notes = new Notes({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.notes.element;
          },
        },
        {
          id: 'draw',
          label: this.i18n.t(MESSAGES['app.draw.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.draw.name']),
            this.i18n.cantonese(MESSAGES['app.draw.name']),
            'draw drawing vector shapes svg diagram 繪圖 向量',
          ].join(' '),
          icon: APPLICATION_ICON.draw,
          fills: true,
          render: () => {
            if (!this.draw) {
              this.draw = new Draw({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.draw.element;
          },
        },
        {
          id: 'formula',
          label: this.i18n.t(MESSAGES['app.formula.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.formula.name']),
            this.i18n.cantonese(MESSAGES['app.formula.name']),
            'formula equation maths mathml latex tex 公式 數學',
          ].join(' '),
          icon: APPLICATION_ICON.formula,
          fills: true,
          render: () => {
            if (!this.formula) {
              this.formula = new Formula({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.formula.element;
          },
        },
        {
          id: 'database',
          label: this.i18n.t(MESSAGES['app.database.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.database.name']),
            this.i18n.cantonese(MESSAGES['app.database.name']),
            'database tables rows query filter records 資料庫 表格',
          ].join(' '),
          icon: APPLICATION_ICON.database,
          fills: true,
          render: () => {
            if (!this.database) {
              this.database = new DatabaseApp({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.database.element;
          },
        },
        {
          id: 'forms',
          label: this.i18n.t(MESSAGES['app.forms.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.forms.name']),
            this.i18n.cantonese(MESSAGES['app.forms.name']),
            'forms survey questionnaire fields responses 表單 問卷',
          ].join(' '),
          icon: APPLICATION_ICON.forms,
          fills: true,
          render: () => {
            if (!this.forms) {
              this.forms = new Forms({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.forms.element;
          },
        },
        {
          id: 'pdf',
          label: this.i18n.t(MESSAGES['app.pdf.name']),
          searchText: [
            this.i18n.english(MESSAGES['app.pdf.name']),
            this.i18n.cantonese(MESSAGES['app.pdf.name']),
            'pdf redact redaction text extract inspect 文件 遮蓋',
          ].join(' '),
          icon: APPLICATION_ICON.pdf,
          fills: true,
          render: () => {
            if (!this.pdf) {
              this.pdf = new PdfApp({
                onChange: () => this.attention.recordActivity(),
              });
            }
            return this.pdf.element;
          },
        },
        {
          id: 'appearance',
          label: this.i18n.t({ en: 'Appearance', yue: '\u5916\u89C0' }),
          searchText:
            'appearance colour color picker theme accent seed rainbow contrast translator \u5916\u89C0 \u984F\u8272',
          icon: '\u{1F3A8}',
          fills: true,
          render: () => {
            if (this.appearanceTab === null) {
              this.appearanceTab = new Appearance({
                settings: this.settings,
                onPatch: (patch) => this.onPatch?.(patch),
              });
            }
            return this.appearanceTab.element;
          },
        },
        {
          id: 'changelog',
          label: this.i18n.t({ en: 'Changelog', yue: '\u66F4\u65B0\u8A18\u9304' }),
          searchText:
            'changelog changes released version commit what changed \u66F4\u65B0 \u8A18\u9304',
          icon: '\u{1F4DC}',
          fills: true,
          render: () => {
            if (this.changelogTab === null) {
              this.changelogTab = new Changelog({
                onCopy: (text) => this.onCopyText?.(text),
                onOpen: (url) => this.onOpenExternal?.(url),
              });
            }
            return this.changelogTab.element;
          },
        },
        {
          id: 'history',
          label: this.i18n.t({ en: 'History', yue: '\u6B77\u53F2' }),
          searchText:
            'history versions restore diff label undo timeline autosave \u6B77\u53F2 \u9084\u539F',
          icon: '\u{1F553}',
          fills: true,
          render: () => {
            const bridge = this.historyBridge;
            if (bridge === null) {
              // Honest rather than an empty list. An empty history would tell
              // somebody their work was never saved, which is alarming and
              // untrue.
              return el('p', {
                class: 'history-status',
                'data-state': 'unavailable',
                text: 'History is not reachable from this window.',
              });
            }
            if (this.historyTab === null) this.historyTab = new HistoryPanel(bridge);
            return this.historyTab.element;
          },
        },
        {
          id: 'locks',
          label: this.i18n.t({ en: 'Locks', yue: '\u9396' }),
          searchText:
            'locks lock pin password totp ladder support tickets recovery unlock \u9396 \u5BC6\u78BC',
          icon: '\u{1F512}',
          fills: true,
          render: () => {
            if (this.locksTab === null) {
              this.locksTab = new LocksSurface({
                // Filled in from the main process as soon as it answers.
                // Until then it says so, rather than printing a guess at a
                // path that would send somebody to the wrong folder.
                dataFolder: this.dataFolder ?? 'looking up the folder...',
                schoolMode: this.settings.schoolMode.enabled,
                onOpenFolder: () => {
                  // Opens it. Never deletes anything FOR them: that would be
                  // a destructive action, and it would go through the two-key
                  // gate rather than behind a joke button.
                  this.onOpenDataFolder?.();
                },
              });
            }
            return this.locksTab.element;
          },
        },
        {
          id: 'find-a-tab',
          label: this.i18n.t({ en: 'Find a tab', yue: '\u627E\u5206\u9801' }),
          searchText:
            'find tab search strip group groups everything window close bulk regex \u627E \u5206\u9801 \u641C\u5C0B',
          icon: '\u{1F50E}',
          fills: true,
          render: () => {
            if (this.tabSearchTab === null) {
              // The snapshot is taken at CALL time rather than captured, so
              // a tab pinned or grouped after this surface was built is seen.
              // A captured list is the shape that silently goes stale.
              const snapshot = () => ({
                name: 'This window',
                tabs: this.tabRecords(),
                state: this.stripState(),
                active: this.tabs?.active ?? '',
              });
              this.tabSearchTab = new TabSearch({
                current: snapshot,
                // One window today. Named honestly rather than pretending to
                // several, and the master search really does walk the list
                // rather than assuming its length.
                windows: () => [snapshot()],
                onReveal: (id) => this.tabs?.activate(id),
              });
            }
            this.tabSearchTab.refresh();
            return this.tabSearchTab.element;
          },
        },
        {
          id: 'narrator',
          label: this.i18n.t({ en: 'Narrator', yue: '\u65C1\u767D' }),
          searchText:
            'narrator speech voice spoken read aloud tts rate pitch \u65C1\u767D \u8AAA\u8A71',
          icon: '\u{1F5E3}',
          fills: true,
          render: () => {
            if (this.narratorTab === null) {
              const narrator = this.settings.narrator;
              // The stored setting uses null for "no voice chosen"; the
              // surface uses the AUTOMATIC sentinel, because a <select> has
              // to hold a string and cannot hold null. Two representations
              // for one idea, mapped once here rather than in every reader.
              const chosen = (uri: string | null): string => uri ?? AUTOMATIC;
              this.narratorTab = new NarratorSurface({
                enabled: narrator.enabled,
                language: narrator.language,
                english: {
                  voiceUri: chosen(narrator.english.voiceUri),
                  rate: narrator.rate,
                  pitch: narrator.pitch,
                },
                cantonese: {
                  voiceUri: chosen(narrator.cantonese.voiceUri),
                  rate: narrator.rate,
                  pitch: narrator.pitch,
                },
                voices: browserVoices(),
                // WIRED, because a button that looks like it works and does
                // not is the defect this project forbids everywhere else. The
                // preview speaks through the same queue and the same port the
                // narrator itself uses, so hearing it prove the whole path
                // rather than a shortcut that only exists for the button.
                onPreview: (lang) => {
                  const current = this.narratorTab?.state();
                  if (current === undefined) return;
                  const preference = lang === 'en' ? current.english : current.cantonese;
                  this.narratorQueue.clear();
                  this.narratorQueue.enqueue({
                    text: SAMPLE[lang],
                    lang,
                    category: 'info',
                    replaces: 'preview',
                  });
                  void preference;
                },
                onChange: (state) => {
                  this.onPatch?.({
                    narrator: {
                      ...narrator,
                      enabled: state.enabled,
                      language: state.language,
                      rate: state.english.rate,
                      pitch: state.english.pitch,
                      english: {
                        ...narrator.english,
                        voiceUri: state.english.voiceUri === AUTOMATIC ? null : state.english.voiceUri,
                      },
                      cantonese: {
                        ...narrator.cantonese,
                        voiceUri:
                          state.cantonese.voiceUri === AUTOMATIC ? null : state.cantonese.voiceUri,
                      },
                    },
                  } as Partial<WorkspaceSettings>);
                },
              });
            }
            return this.narratorTab.element;
          },
        },
        {
          id: 'collaboration',
          label: this.i18n.t({ en: 'Collaboration', yue: '\u5354\u4F5C' }),
          searchText:
            'collaboration share co-authoring presence offline queue realtime server \u5354\u4F5C',
          icon: '\u{1F91D}',
          fills: true,
          render: () =>
            new Collaboration({
              onChange: () => this.attention.recordActivity(),
            }).element,
        },
        {
          id: 'governance',
          label: this.i18n.t({ en: 'Governance', yue: '管治' }),
          searchText:
            'governance classification label sensitivity retention legal hold dlp scan 管治 分級 保存',
          icon: '🛡',
          fills: true,
          render: () => new Governance().element,
        },
        {
          id: 'notifications',
          label: this.i18n.t({ en: 'Notifications', yue: '通知' }),
          searchText: 'notifications alerts messages log 通知',
          icon: '🔔',
          render: () => new NotificationCentre(this.notifications).element,
        },
        {
          id: 'settings',
          label: this.i18n.t({ en: 'Settings', yue: '設定' }),
          searchText: 'settings preferences options 設定 appearance language',
          icon: '\u{2699}',
          render: () =>
            new SettingsSurface({
              i18n: this.i18n,
              shippedDefaults: defaultSettings(),
              onResetAll: () => this.onResetAll?.(),
              initialSection: this.settingsSection,
              onSectionChange: (id) => {
                this.settingsSection = id;
              },
            }).element,
        },
      ],
    });

    this.tabs.activate(previousTab);

    const statusBar = this.statusBar();
    this.attention.attach({ statusBar, notifications: this.notifications });
    this.attention.render();

    mount(
      this.root,
      this.titleBar(),
      el('div', { class: 'shell' }, [this.tabs.strip, this.tabs.panelHost]),
      // Between the content and the status bar, so it is at the edge of the
      // window rather than over anything. It never takes focus.
      this.updates.element,
      statusBar,
      this.notifications.host,
    );
    this.root.setAttribute('data-state', 'ready');

    // After the tree exists, so every element that was just rendered gets its
    // stored appearance. Applying during construction would style a subtree
    // that is replaced a moment later.
    this.applyElementStyles();
    this.installElementMenu();
  }

  // ------------------------------------------------ per-element appearance --

  private elementMenu: ContextMenu | null = null;
  private elementEditor: ElementAppearance | null = null;
  private menuInstalled = false;
  /** The element a style was copied FROM, for the paste item. */
  private copiedStyleFrom: string | null = null;

  private get styleBook(): StyleBook {
    // Falls back rather than trusting the type. A profile written by a version
    // that predates this field is a real upgrade case, and the whole shell
    // would fail to finish rendering over one missing object.
    return this.settings.appearance.elementStyles ?? {};
  }

  /**
   * Write every stored override onto the elements currently on screen.
   *
   * Through the style object, one property at a time, rather than by building
   * a text fragment and assigning it to `style` - which would reintroduce the
   * parser the style model is shaped to avoid.
   */
  private applyElementStyles(): void {
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-styled]')) {
      node.removeAttribute('style');
      node.removeAttribute('data-styled');
    }

    const ids = new Set([...Object.keys(this.styleBook), ...Object.keys(this.layerBook)]);
    if (ids.size === 0) return;

    for (const node of this.root.querySelectorAll<HTMLElement>('*')) {
      const elementId = this.styleIdOf(node);
      if (!ids.has(elementId)) continue;

      for (const [property, value] of declarationsFor(this.styleBook, elementId)) {
        node.style.setProperty(property, value);
      }

      // Layers are composed into four values and written after the properties,
      // so a stack wins over a plain background on the same element - which is
      // what a layers panel is for.
      const painted = compose(layersFor(this.layerBook, elementId));
      if (painted.backgroundImage !== '') {
        node.style.setProperty('background-image', painted.backgroundImage);
      }
      if (painted.backgroundBlend !== '') {
        node.style.setProperty('background-blend-mode', painted.backgroundBlend);
      }
      if (painted.boxShadow !== '') node.style.setProperty('box-shadow', painted.boxShadow);
      if (painted.backdropFilter !== '') {
        node.style.setProperty('backdrop-filter', painted.backdropFilter);
      }

      node.setAttribute('data-styled', elementId);
    }
  }

  /** The stable key this element's overrides are stored under. */
  private styleIdOf(node: HTMLElement): string {
    const path: ElementStep[] = [];
    let current: HTMLElement | null = node;
    while (current !== null && current !== this.root && path.length < 6) {
      const parent: HTMLElement | null = current.parentElement;
      path.push({
        tag: current.tagName.toLowerCase(),
        styleId: current.dataset['styleId'],
        // State classes are excluded deliberately: an id that changes when an
        // element is hovered or selected is an id whose stored style vanishes
        // the moment somebody points at it.
        classes: [...current.classList].filter((name) => !name.includes('--')),
        index: parent === null ? 0 : [...parent.children].indexOf(current),
      });
      current = parent;
    }
    return styleIdFor(path);
  }

  /** A name for the element, for the menu heading and the editor title. */
  private describeElement(node: HTMLElement): string {
    const label =
      node.getAttribute('aria-label') ??
      node.getAttribute('title') ??
      (node.textContent ?? '').trim().slice(0, 40);
    const kind = node.tagName.toLowerCase();
    return label === '' ? 'this ' + kind : label + ' (' + kind + ')';
  }

  /**
   * The right-click menu, by delegation from the root.
   *
   * One listener rather than a menu per surface, so EVERY rendered element has
   * one by construction. A per-surface menu is a menu that is missing wherever
   * the surface is newest.
   */
  private installElementMenu(): void {
    // The root survives every rebuild, so the listeners are installed once.
    // Adding them on each render would stack a menu per render and open
    // several at a time.
    if (this.menuInstalled) return;
    this.menuInstalled = true;

    this.root.addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      event.preventDefault();

      // Shift skips the menu and opens the editor directly, as the contract
      // asks. The menu route stays, because a modifier nobody was told about
      // is not a route.
      if (event.shiftKey) {
        this.openAppearanceEditor(target);
        return;
      }
      this.openElementMenu(target);
    });

    // The keyboard equivalent. Shift+F10 and the Menu key are what the
    // platform already trains people to press, and a pointer-only menu is a
    // menu that does not exist at all for anybody using a keyboard.
    this.root.addEventListener('keydown', (event) => {
      const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
      if (!isMenuKey) return;
      const target = document.activeElement as HTMLElement | null;
      if (target === null || !this.root.contains(target)) return;
      event.preventDefault();
      this.openElementMenu(target);
    });
  }

  private openElementMenu(target: HTMLElement): void {
    this.elementMenu?.close();

    const elementId = this.styleIdOf(target);
    const overrides = countOverrides(this.styleBook, elementId);

    const items: MenuItem[] = [
      {
        id: 'edit-appearance',
        label: 'Edit appearance...',
        shortcut: 'Shift+Right click',
        run: () => this.openAppearanceEditor(target),
      },
      {
        id: 'reset-appearance',
        label: 'Reset this element',
        // Named rather than hidden, and the reason sits on the control itself:
        // a disabled item with no explanation reads as broken, not as blocked.
        ...(overrides === 0
          ? { disabledReason: 'Nothing on this element has been customized.' }
          : {}),
        run: () => this.writeStyles(resetElement(this.styleBook, elementId)),
      },
      {
        id: 'copy-appearance',
        label: 'Copy appearance',
        ...(overrides === 0
          ? { disabledReason: 'Nothing on this element has been customized.' }
          : {}),
        run: () => {
          this.copiedStyleFrom = elementId;
          this.notifications.push({
            title: 'Appearance copied',
            // Keyed, so copying twice replaces the note rather than stacking
            // a second copy of the same sentence.
            key: 'appearance-copied',
            body:
              overrides +
              (overrides === 1 ? ' property copied.' : ' properties copied.') +
              ' Right-click another element to paste it.',
          });
        },
      },
      {
        id: 'paste-appearance',
        label: 'Paste appearance',
        // Named rather than hidden. A paste item that appears only sometimes is
        // a menu whose shape changes under the pointer.
        ...(this.copiedStyleFrom === null
          ? { disabledReason: 'Nothing has been copied yet.' }
          : {}),
        run: () => {
          if (this.copiedStyleFrom === null) return;
          // Replaces rather than merges, so a copied look lands the same way on
          // every element it is put on.
          this.writeStyles(copyStyle(this.styleBook, this.copiedStyleFrom, elementId));
        },
      },
      {
        id: 'lock-element',
        label: 'Lock this element...',
        run: () => {
          this.settingsSection = 'locks';
          this.tabs?.activate('settings');
        },
      },
    ];

    this.elementMenu = new ContextMenu({
      anchor: target,
      label: 'Menu for ' + this.describeElement(target),
      items,
      onClose: () => {
        this.elementMenu = null;
      },
    });
    this.elementMenu.open();
  }

  private openAppearanceEditor(target: HTMLElement): void {
    this.elementEditor?.close();

    this.elementEditor = new ElementAppearance({
      anchor: target,
      elementId: this.styleIdOf(target),
      elementLabel: this.describeElement(target),
      book: this.styleBook,
      presets: this.settings.appearance.stylePresets ?? {},
      layers: this.layerBook,
      fonts: this.installedFonts(),
      onChange: (book) => this.writeStyles(book),
      onPresets: (presets) => this.writePresets(presets),
      onLayers: (layers) => this.writeLayers(layers),
      onClose: () => {
        this.elementEditor = null;
      },
    });
    this.elementEditor.open();
  }

  /**
   * Persist the book AND apply it now.
   *
   * Both, because persisting alone leaves the element unchanged until the next
   * rebuild - so the editor would look broken - and applying alone loses the
   * work on restart.
   */
  private writeStyles(book: StyleBook): void {
    const styles = book as Record<string, Record<string, string>>;
    this.settings = {
      ...this.settings,
      appearance: { ...this.settings.appearance, elementStyles: styles },
    };
    this.applyElementStyles();
    this.onPatch?.({ appearance: { ...this.settings.appearance, elementStyles: styles } });
  }

  private get layerBook(): LayerBook {
    return (this.settings.appearance.elementLayers ?? {}) as LayerBook;
  }

  /** Layers persist and apply exactly as the properties do. */
  private writeLayers(layers: LayerBook): void {
    const stored = layers as unknown as Record<string, unknown[]>;
    this.settings = {
      ...this.settings,
      appearance: { ...this.settings.appearance, elementLayers: stored },
    };
    this.applyElementStyles();
    this.onPatch?.({ appearance: { ...this.settings.appearance, elementLayers: stored } });
  }

  /** Saved styles live beside the per-element overrides, and persist the same way. */
  private writePresets(presets: PresetBook): void {
    const styles = presets as Record<string, Record<string, string>>;
    this.settings = {
      ...this.settings,
      appearance: { ...this.settings.appearance, stylePresets: styles },
    };
    this.onPatch?.({ appearance: { ...this.settings.appearance, stylePresets: styles } });
  }

  /**
   * The fonts offered in the editor.
   *
   * The ones bundled with the application, which are the only ones it can
   * promise will render. Naming a face the machine does not have would produce
   * a control that appears to change nothing.
   */
  private installedFonts(): readonly string[] {
    return ['Segoe UI', 'Consolas', 'Georgia', 'Noto Sans HK'];
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('the application root element is missing');

  const bridge = window.workspace;
  if (!bridge) {
    // Never a blank screen. If the bridge is absent the renderer says so, because
    // an empty window is indistinguishable from a hang.
    root.textContent =
      'Material Workspace could not reach its main process. The application cannot continue.';
    return;
  }

  const [snapshot, provenance, vocabulary] = await Promise.all([
    bridge.settings.get(),
    bridge.provenance.get(),
    bridge.vocabulary.state().catch(() => ({ state: null, entries: {} })),
  ]);

  const shell = new Shell(root, snapshot.settings, provenance, vocabulary.entries);
  shell.setProvenance(snapshot.provenance);
  // The rejection is HANDLED, not swallowed. The first version used a bare
  // `void ... .then(...)`, so when the main process had no handler registered
  // the promise rejected into nothing and the surface simply kept showing its
  // placeholder - a lookup that had failed, presented as one still in flight.
  void bridge.shell
    .dataFolderPath()
    .then((result) => {
      const path = (result as { path?: unknown } | null)?.path;
      if (typeof path === 'string' && path !== '') shell.setDataFolder(path);
      else shell.setDataFolder('the folder could not be looked up');
    })
    .catch(() => {
      // Honest rather than a spinner that never resolves. Somebody locked out
      // needs to know the path is unavailable so they can find it themselves.
      shell.setDataFolder('the folder could not be looked up on this machine');
    });

  // The history bridge, built from the preload surface rather than reached for
  // inside the panel: the panel is then drivable with a fake and never has to
  // know whether it is running in Electron.
  shell.historyBridge = {
    list: (query) => bridge.history.list(query),
    diff: (commit) => bridge.history.diff(commit) as Promise<string>,
    restore: (commit) => bridge.history.restore({ commit }),
    label: (commit, label) => bridge.history.label({ commit, label }),
    health: () => bridge.history.health() as Promise<never>,
    onExport: () => {
      void bridge.history.export({ format: 'json' });
    },
  };

  // The updater. Checked once shortly after start-up rather than immediately:
  // a check racing the first paint costs somebody the moment they opened the
  // application for, and an update that arrives ninety seconds later is no
  // less useful.
  const runCheck = (): void => {
    shell.updates.set({ ...shell.updates.current(), stage: 'checking' });
    void bridge.updates.check().then(
      (result) => {
        if (result.ok && result.release !== undefined) {
          shell.updates.set({
            ...shell.updates.current(),
            stage: 'available',
            release: result.release as never,
            detail: '',
          });
          return;
        }
        // "Already up to date" is the ordinary outcome and is reported as
        // `none`, not as a failure - reporting it as one trains people to
        // ignore the check that will one day matter.
        const reason = result.reason ?? '';
        shell.updates.set({
          ...shell.updates.current(),
          stage: /already up to date/.test(reason)
            ? 'none'
            : result.offline === true
              ? 'offline'
              : 'failed',
          detail: reason,
        });
      },
      (error: unknown) => {
        shell.updates.set({
          ...shell.updates.current(),
          stage: 'offline',
          detail: (error as Error)?.message ?? 'the release host could not be reached',
        });
      },
    );
  };

  shell.onCheckForUpdates = runCheck;
  shell.onRestartForUpdate = () => {
    void bridge.updates.staged().then((result) => {
      const file = result.staged[0];
      if (file === undefined) {
        shell.updates.set({
          ...shell.updates.current(),
          stage: 'failed',
          detail: 'Nothing is staged to install. Download it again.',
        });
        return;
      }
      void bridge.updates.install(file).then((outcome) => {
        // Only reached when the installer did NOT start; on success this
        // window is about to go.
        if (!outcome.started) {
          shell.updates.set({
            ...shell.updates.current(),
            stage: 'failed',
            detail: outcome.reason ?? 'the installer did not start',
          });
        }
      });
    });
  };
  shell.onDownloadUpdate = () => {
    const release = shell.updates.current().release;
    if (release === null) return;
    shell.updates.set({ ...shell.updates.current(), stage: 'downloading', progress: null });
    void bridge.updates.download(release).then((result) => {
      shell.updates.set({
        ...shell.updates.current(),
        stage: result.ok ? 'ready' : 'failed',
        progress: null,
        detail: result.reason,
      });
    });
  };
  bridge.updates.onProgress((payload) => {
    const fraction = (payload as { fraction?: unknown } | null)?.fraction;
    if (typeof fraction !== 'number') return;
    const state = shell.updates.current();
    if (state.stage !== 'downloading') return;
    shell.updates.set({ ...state, progress: fraction });
  });

  /**
   * The background schedule.
   *
   * Delayed before the first check, because one racing the first paint costs
   * somebody the moment they opened the application for and an update arriving
   * twenty seconds later is no less useful.
   *
   * Then jittered and backing off, from the same function the tests exercise.
   * Every installation checking on the hour is a self-inflicted stampede on the
   * release host, and nobody notices until there are enough installations to
   * matter. A failure lengthens the wait rather than retrying immediately: an
   * unreachable feed is usually unreachable for a while, and hammering it
   * helps nobody.
   */
  let failures = 0;
  const scheduleNextCheck = (): void => {
    const delay = nextCheckDelay(failures, Math.random());
    setTimeout(() => {
      runCheck();
      // Read AFTER the check has had a moment to settle, so the count reflects
      // what happened rather than the state it started from.
      setTimeout(() => {
        const stage = shell.updates.current().stage;
        failures = stage === 'offline' || stage === 'failed' ? failures + 1 : 0;
        scheduleNextCheck();
      }, 5000);
    }, delay);
  };

  setTimeout(() => {
    runCheck();
    scheduleNextCheck();
  }, 20_000);

  // The narrator yields to a screen reader, and learns about it from the
  // operating system rather than guessing. Read once at start-up and then
  // watched, because somebody turning one on mid-session must not have to
  // restart before the narrator stops talking over it.
  const applyAccessibility = (payload: unknown): void => {
    const active = (payload as { screenReaderActive?: unknown } | null)?.screenReaderActive;
    if (typeof active === 'boolean') shell.setScreenReaderActive(active);
  };
  void bridge.accessibility.state().then(applyAccessibility, () => {
    // Unknown is treated as ABSENT rather than present. Assuming a screen
    // reader is attached would silence the narrator for everybody whose host
    // could not answer, which is a feature disabled by a failed lookup.
    shell.setScreenReaderActive(false);
  });
  bridge.accessibility.onChanged(applyAccessibility);

  shell.onOpenExternal = (url) => {
    // Handed to the host rather than navigated to in this window, which would
    // replace the application with a web page and leave no way back.
    void bridge.shell.openExternal(url);
  };

  shell.onCopyText = (text) => {
    void navigator.clipboard.writeText(text).then(
      () =>
        shell.notifications.push({
          severity: 'success',
          title: 'Copied',
          body: 'What is shown is on the clipboard, filters and all.',
        }),
      () =>
        // Reported rather than silently failing. A copy button that does
        // nothing is indistinguishable from one that worked.
        shell.notifications.push({
          severity: 'error',
          title: 'Nothing was copied',
          body: 'This machine refused access to the clipboard.',
        }),
    );
  };

  shell.onOpenDataFolder = () => {
    void bridge.shell.openDataFolder();
  };

  shell.onPatch = (patch) => {
    void bridge.settings.update(patch);
  };

  shell.onResetAll = () => {
    // THROUGH THE GATE, because this is irreversible and there is no undo for
    // it. The gate existed and nothing went through it - a destructive-action
    // confirmation that no destructive action uses is decoration, which is the
    // exact defect this project refuses everywhere else.
    void SuperConfirm.open({
      title: 'Put every setting back to the value it shipped with',
      affected:
        'Every setting in this application: language, appearance, the accent ' +
        'colour, the narrator, tabs, focus modes and saving.',
      irreversible:
        'There is no undo for this. Your documents, their history and your ' +
        'files are untouched - only the settings are reset.',
      actionLabel: 'Reset every setting',
      anchor: document.querySelector<HTMLElement>('.settings-reset-all'),
    }).then((outcome) => {
      if (!outcome.confirmed) {
        // A cancel is reported, so somebody who meant to reset and pressed
        // Escape by accident is not left wondering whether it happened.
        shell.notifications.push({
          severity: 'info',
          title: 'Nothing was reset',
          body: 'Your settings are exactly as they were.',
        });
        return;
      }
      void bridge.settings.resetAll().then(() => {
        shell.notifications.push({
          severity: 'success',
          title: 'Every setting is back to its shipped value',
          body: 'Nothing else was changed, and your documents are untouched.',
        });
      });
    });
  };
  shell.applySettings(snapshot.settings);

  // The command palette. Registered AFTER the shell has rendered once, so a
  // destination resolves against elements that actually exist.
  const palette = new CommandPalette({ i18n: shell.translator() });
  shell.palette = palette;
  palette.install();
  registerPaletteEntries({
    settings: () => shell.currentSettings(),
    provenance: () => shell.currentProvenance(),
    update: (patch) => {
      void bridge.settings.update(patch);
    },
    resetKey: (dottedPath) => {
      void bridge.settings.resetKey(dottedPath);
    },
    resetAll: () => {
      // The palette reaches the same gate. A destructive action that is safe
      // from one surface and unguarded from another is unguarded.
      void SuperConfirm.open({
        title: 'Put every setting back to the value it shipped with',
        affected: 'Every setting in this application.',
        irreversible: 'There is no undo for this. Your documents are untouched.',
        actionLabel: 'Reset every setting',
        anchor: null,
      }).then((outcome) => {
        if (outcome.confirmed) void bridge.settings.resetAll();
      });
    },
    openDataFolder: () => {
      void bridge.shell.openDataFolder();
    },
    // Resolved at activation time, never captured at registration: the shell
    // re-renders, so an element held from earlier is stale.
    find: (selector) => document.querySelector<HTMLElement>(selector),
  });

  bridge.settings.onChanged((payload) => {
    const next = payload as SettingsSnapshot;
    if (!next || !next.settings) return;
    shell.setProvenance(next.provenance ?? {});
    shell.applySettings(next.settings);
  });

  bridge.window.onStateChanged((payload) => {
    const state = payload as { maximised?: boolean };
    shell.setWindowState(Boolean(state?.maximised));
  });

  // History health is reported honestly and asynchronously: a repository that
  // cannot be created must read as a diagnosis, not as an empty archive.
  bridge.history
    .health()
    .then((health) => {
      shell.setHistoryHealth(health);
      // A real event, reported once. Not a demonstration: if document
      // history cannot start, that is exactly the thing a user needs told,
      // and it never auto-dismisses because an unread warning is an
      // undelivered one.
      if (!health.available) {
        shell.notifications.push({
          severity: 'error',
          title: 'Document history is unavailable',
          body: health.reason ?? 'No reason was reported.',
          key: 'history-health',
        });
      }
    })
    .catch((error: unknown) => {
      shell.setHistoryHealth({
        available: false,
        repositoryPath: '',
        commitCount: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
}

void boot().catch((error: unknown) => {
  const root = document.getElementById('root');
  if (root) {
    root.textContent =
      'Material Workspace failed to start: ' +
      (error instanceof Error ? error.message : String(error));
  }
});
