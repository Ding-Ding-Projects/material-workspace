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

import { clear, el, formatInstant, mount, timezoneName } from './dom.js';
import { SearchField, applyPredicate, type SearchPredicate } from './components/search-field.js';
import { CommandPalette } from './components/palette/palette.js';
import { TabStrip } from './components/tabs.js';
import { SettingsSurface } from './components/settings-surface.js';
import { Notifications, NotificationCentre } from './components/notifications.js';
import { AttentionModes } from './adhd.js';
import { registerPaletteEntries } from './palette-entries.js';
import { I18n, MESSAGES, PLURAL_MESSAGES, type Message } from './i18n.js';
import {
  APPLICATION_IDS,
  defaultSettings,
  type ApplicationId,
  type WorkspaceSettings,
} from '../shared/settings.js';
import type { BuildProvenance, HistoryHealth } from '../shared/ipc.js';

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
  history: { health(): Promise<HistoryHealth> };
  vocabulary: {
    state(): Promise<{ state: unknown; entries: Record<string, string> }>;
  };
  shell: {
    openDataFolder(): Promise<{ path: string; opened: boolean; error: string | null }>;
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
const AVAILABLE: ReadonlySet<ApplicationId> = new Set<ApplicationId>([]);

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
  /** Survives the rebuild that every settings change triggers. */
  private settingsSection = 'language';
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
    this.i18n = new I18n({
      mode: settings.languageMode,
      englishLevel: settings.funnyLevels.english,
      cantoneseLevel: settings.funnyLevels.cantonese,
      vocabulary,
    });
  }

  applySettings(settings: WorkspaceSettings): void {
    this.settings = settings;
    this.i18n.update({
      mode: settings.languageMode,
      englishLevel: settings.funnyLevels.english,
      cantoneseLevel: settings.funnyLevels.cantonese,
    });
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
    html.setAttribute('data-language', this.settings.languageMode);
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
    html.lang = this.settings.languageMode === 'yue' ? 'zh-HK' : 'en';

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
      if (!available) {
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
      statusBar,
      this.notifications.host,
    );
    this.root.setAttribute('data-state', 'ready');
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
  shell.onResetAll = () => {
    void bridge.settings.resetAll().then(() => {
      shell.notifications.push({
        severity: 'success',
        title: 'Every setting is back to its shipped value',
        body: 'Nothing else was changed, and your documents are untouched.',
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
      void bridge.settings.resetAll();
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
