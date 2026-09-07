/**
 * The documentation site.
 *
 * It carries the same feature contract as the application, using the same
 * components: the tab strip, the search field, the anchored regular-expression
 * builder, the command palette and the settings surface are the SAME code. The
 * only thing that differs is where state is kept, because a browser has no
 * application-data directory.
 *
 * "It is only the docs site" is not an exemption, and reusing the components is
 * what makes that true by construction rather than by diligence.
 */

import '../app/renderer/styles/tokens.css';
import '../app/renderer/styles/shell.css';
import '../app/renderer/styles/components.css';
import './site.css';

import { clear, el, mount } from '../app/renderer/dom.js';
import { I18n, type Message } from '../app/renderer/i18n.js';
import { SearchField, type SearchPredicate } from '../app/renderer/components/search-field.js';
import { TabStrip } from '../app/renderer/components/tabs.js';
import { CommandPalette } from '../app/renderer/components/palette/palette.js';
import { SettingsSurface } from '../app/renderer/components/settings-surface.js';
import { registerPaletteEntries } from '../app/renderer/palette-entries.js';
import { paletteRegistry, revealElement } from '../app/renderer/components/palette/registry.js';
import { defaultSettings, type WorkspaceSettings } from '../app/shared/settings.js';
import { renderMarkdown } from './markdown.js';
import { SiteSettings } from './local-settings.js';

/** Injected at build time from the real docs/ tree. */
declare const SITE_ARTICLES: {
  path: string;
  title: string;
  category: string;
  source: string;
}[];
declare const SITE_BUILD: {
  version: string;
  commit: string | null;
  builtAt: string | null;
  release: { tag: string; url: string; installer: string | null; sha256: string | null } | null;
};

const store = new SiteSettings();
let i18n = new I18n({
  mode: store.settings.languageMode,
  englishLevel: store.settings.funnyLevels.english,
  cantoneseLevel: store.settings.funnyLevels.cantonese,
  vocabulary: {},
});

const M = {
  title: { en: 'Material Workspace', yue: 'Material Workspace' } as Message,
  home: { en: 'Home', yue: '主頁' } as Message,
  docs: { en: 'Documentation', yue: '說明文件' } as Message,
  settings: { en: 'Settings', yue: '設定' } as Message,
  lede: {
    en: [
      'An office suite with its own document engines. Nothing else needs to be installed.',
      'An office suite with its own document engines. Nothing else needs to be installed.',
      'An office suite that brought its own engines, so nothing else needs installing.',
      'Nine applications, all their engines written from scratch, and not one thing to install alongside.',
      'Nine applications that brought their own engines to the party. Install nothing else; it genuinely all lives in here.',
    ],
    yue: [
      '一套自帶文件引擎嘅辦公室套裝，唔使再裝第二樣嘢。',
      '一套自帶文件引擎嘅辦公室套裝，唔使再裝第二樣嘢。',
      '成套嘢自己帶埋引擎嚟，唔使你再裝多樣。',
      '九個程式，引擎全部由零寫起，一樣都唔使另外裝。',
      '九個程式，引擎自己帶晒嚟，乜都唔使裝，真係全部喺入面。',
    ],
  } as Message,
  earlyTitle: { en: 'Early build', yue: '早期版本' } as Message,
  early: {
    en: 'None of the nine applications is built yet. The shell, the settings model, the document store and the autosave history are real; every application says so on its front screen rather than opening an empty window.',
    yue: '九個程式一個都未整好。外殼、設定、文件儲存同自動儲存歷史係真嘅；每個程式喺首頁會照直講，唔會開個空窗畀你。',
  } as Message,
  downloadTitle: { en: 'Download', yue: '下載' } as Message,
  unsigned: {
    en: 'This installer is unsigned. Windows will show an unknown-publisher warning. That is deliberate and permanent for this project — verify the download against the SHA-256 below rather than against a signature.',
    yue: '呢個安裝檔未簽署，Windows 會彈「不明發行者」。係我哋特登唔簽 —— 請用下面個 SHA-256 對，唔好靠簽名。',
  } as Message,
  noRelease: {
    en: 'No release has been published yet. When one exists, its installer and its SHA-256 appear here.',
    yue: '仲未出過 release。有嘅時候，安裝檔同 SHA-256 會喺呢度。',
  } as Message,
  searchDocs: { en: 'Search the documentation', yue: '搜尋說明文件' } as Message,
  storageNote: {
    en: 'This site keeps your settings in this browser only. There is no account and nothing is sent anywhere. To reset everything, clear this site’s storage in your browser, or use the button above.',
    yue: '呢個網站淨係將你嘅設定擺喺你部瀏覽器度，無帳戶，乜都唔會傳出去。想清空就喺瀏覽器度清呢個網站嘅儲存，或者撳上面粒掣。',
  } as Message,
};

function label(message: Message): HTMLElement {
  const primary = i18n.t(message);
  const secondary = i18n.secondary(message);
  if (secondary === null) return el('span', { text: primary });
  return el('span', { class: 'bilingual' }, [
    el('span', { class: 'bilingual__primary', text: primary }),
    el('span', { class: 'bilingual__secondary', text: secondary }),
  ]);
}

/* ------------------------------------------------------------------- home */

function homePanel(): HTMLElement {
  const panel = el('div', { class: 'front' });

  panel.append(
    el('h1', { class: 'front__headline', text: 'Material Workspace' }),
    el('p', { class: 'front__lede' }, [label(M.lede)]),
  );

  panel.append(
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, [label(M.earlyTitle)]),
      el('p', { class: 'notice notice--warning' }, [label(M.early)]),
    ]),
  );

  // Download, only when a release genuinely exists. A download button pointing
  // at a candidate or a guessed URL is worse than no button.
  const download = el('section', { class: 'card' }, [
    el('h2', { class: 'card__title' }, [label(M.downloadTitle)]),
  ]);
  if (SITE_BUILD.release?.installer) {
    const link = el('a', {
      class: 'download',
      href: SITE_BUILD.release.installer,
      rel: 'noreferrer noopener',
    });
    link.textContent =
      'Download the Windows installer (' + SITE_BUILD.release.tag + ')';
    download.append(link);
    download.append(el('p', { class: 'notice notice--warning' }, [label(M.unsigned)]));
    if (SITE_BUILD.release.sha256) {
      download.append(
        el('pre', { class: 'sha', text: 'SHA-256  ' + SITE_BUILD.release.sha256 }),
      );
    }
  } else {
    download.append(el('p', { class: 'front__lede' }, [label(M.noRelease)]));
  }
  panel.append(download);

  // Build facts, exactly as the application shows them.
  const facts = el('dl', { class: 'facts' });
  const row = (name: string, value: string | null): void => {
    facts.append(
      el('dt', { text: name }),
      el('dd', { 'data-unavailable': value === null ? 'true' : 'false' }, [
        document.createTextNode(value ?? 'Not recorded for this build.'),
      ]),
    );
  };
  row('Version', SITE_BUILD.version);
  row(
    'Site built at',
    SITE_BUILD.builtAt
      ? new Intl.DateTimeFormat(undefined, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZoneName: 'short',
        }).format(new Date(SITE_BUILD.builtAt)) +
        ' (' +
        (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time') +
        ')'
      : null,
  );
  row('Commit', SITE_BUILD.commit);
  panel.append(
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'This site' }),
      facts,
    ]),
  );

  return panel;
}

/* ----------------------------------------------------------- documentation */

let docsSearchPredicate: SearchPredicate | null = null;
let activeArticle = SITE_ARTICLES[0]?.path ?? '';

function docsPanel(): HTMLElement {
  const listHost = el('nav', { class: 'docs__list', 'aria-label': 'Articles' });
  const readerHost = el('article', { class: 'docs__reader' });

  const search = new SearchField({
    id: 'docs-search',
    label: i18n.english(M.searchDocs),
    placeholder: 'Search the documentation',
    onChange: (predicate) => {
      docsSearchPredicate = predicate;
      renderList();
    },
  });

  function renderList(): void {
    clear(listHost);
    const predicate = docsSearchPredicate;

    if (predicate?.error) {
      listHost.append(
        el('p', {
          class: 'docs__empty',
          role: 'status',
          text: 'That pattern will not compile, so nothing was matched: ' + predicate.error,
        }),
      );
      return;
    }

    // Search covers the article BODY, not just its title. A documentation search
    // that only matches titles finds nothing most of the time.
    const visible =
      predicate && !predicate.empty && predicate.test
        ? SITE_ARTICLES.filter((article) =>
            predicate.test?.(article.title + ' ' + article.category + ' ' + article.source),
          )
        : SITE_ARTICLES;

    if (visible.length === 0) {
      listHost.append(
        el('p', { class: 'docs__empty', role: 'status', text: 'No article matches that search.' }),
      );
      return;
    }

    let lastCategory = '';
    for (const article of visible) {
      if (article.category !== lastCategory) {
        listHost.append(el('h3', { class: 'docs__category', text: article.category }));
        lastCategory = article.category;
      }
      const button = el('button', {
        class: 'docs__item',
        type: 'button',
        'data-article': article.path,
        'aria-current': article.path === activeArticle ? 'page' : 'false',
      });
      button.textContent = article.title;
      button.addEventListener('click', () => {
        activeArticle = article.path;
        renderList();
        renderReader();
      });
      listHost.append(button);
    }
  }

  function renderReader(): void {
    clear(readerHost);
    const article = SITE_ARTICLES.find((entry) => entry.path === activeArticle);
    if (!article) {
      readerHost.append(el('p', { text: 'Choose an article.' }));
      return;
    }
    const rendered = renderMarkdown(article.source);

    // A table of contents, because a long article is a page a reader navigates.
    const headings = rendered.headings.filter((heading) => heading.level === 2);
    if (headings.length > 2) {
      const toc = el('nav', { class: 'docs__toc', 'aria-label': 'On this page' }, [
        el('p', { class: 'docs__toc-title', text: 'On this page' }),
      ]);
      for (const heading of headings) {
        const link = el('a', { href: '#' + heading.id, text: heading.text });
        toc.append(link);
      }
      readerHost.append(toc);
    }

    readerHost.append(rendered.fragment);

    // Article-to-article links resolve INSIDE the site rather than 404ing.
    for (const anchor of readerHost.querySelectorAll<HTMLAnchorElement>('[data-article-link]')) {
      const href = anchor.getAttribute('data-article-link') ?? '';
      anchor.addEventListener('click', (event) => {
        const target = resolveArticleLink(article.path, href);
        if (!target) return; // let an unresolvable link behave normally
        event.preventDefault();
        activeArticle = target;
        renderList();
        renderReader();
        readerHost.scrollIntoView({ block: 'start' });
      });
    }
  }

  renderList();
  renderReader();

  return el('div', { class: 'docs' }, [
    el('div', { class: 'docs__sidebar' }, [search.element, listHost]),
    readerHost,
  ]);
}

/** Resolve a relative link between articles against the real article set. */
function resolveArticleLink(from: string, href: string): string | null {
  if (/^https?:/.test(href)) return null;
  const base = from.split('/').slice(0, -1);
  const parts = href.split('#')[0]?.split('/') ?? [];
  const resolved = [...base];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part.length > 0) resolved.push(part);
  }
  const candidate = resolved.join('/');
  return SITE_ARTICLES.some((article) => article.path === candidate) ? candidate : null;
}

/* ------------------------------------------------------------------- shell */

let tabs: TabStrip | null = null;

function applyDocumentAttributes(settings: WorkspaceSettings): void {
  const html = document.documentElement;
  const appearance = settings.appearance;
  const resolvedTheme =
    appearance.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : appearance.theme;

  html.setAttribute('data-theme', resolvedTheme);
  html.setAttribute('data-density', appearance.density);
  html.setAttribute('data-language', settings.languageMode);
  html.setAttribute('data-tab-edge', settings.tabs.edge);
  html.setAttribute('data-reduced-motion', appearance.reducedMotion);
  html.setAttribute('data-rainbow-speed', String(appearance.rainbowSpeedLevel));
  html.setAttribute('data-rainbow', appearance.seedColor === 'rainbow' ? 'on' : 'off');
  html.style.setProperty('--workspace-font-scale', String(appearance.fontScale));
  html.lang = settings.languageMode === 'yue' ? 'zh-HK' : 'en';
}

function render(): void {
  const root = document.getElementById('root');
  if (!root) return;

  const previous = tabs?.active ?? 'home';

  tabs = new TabStrip({
    variant: 'main',
    edge: store.settings.tabs.edge,
    tabs: [
      {
        id: 'home',
        label: i18n.t(M.home),
        searchText: 'home start download install version',
        icon: '\u{1F3E0}',
        render: () => homePanel(),
      },
      {
        id: 'docs',
        label: i18n.t(M.docs),
        searchText: 'documentation docs articles help 說明文件',
        icon: '\u{1F4D6}',
        render: () => docsPanel(),
      },
      {
        id: 'settings',
        label: i18n.t(M.settings),
        searchText: 'settings preferences appearance language 設定',
        icon: '\u{2699}',
        render: () => {
          const surface = new SettingsSurface({
            i18n,
            shippedDefaults: defaultSettings(),
            onResetAll: () => store.resetAll(),
          });
          // The browser has no application-data folder, so the recovery route
          // is named exactly rather than left as a gap.
          const note = el('p', { class: 'settings__provenance' }, [label(M.storageNote)]);
          return el('div', {}, [surface.element, note]);
        },
      },
    ],
  });
  tabs.activate(previous);

  mount(
    root,
    el('header', { class: 'title-bar' }, [
      el('div', { class: 'title-bar__identity' }, [
        el('span', { class: 'title-bar__name', text: 'Material Workspace' }),
      ]),
      el('div', { class: 'title-bar__spacer' }),
      el('a', {
        class: 'title-bar__link',
        href: 'https://github.com/Ding-Ding-Projects/material-workspace',
        rel: 'noreferrer noopener',
        text: 'Source',
      }),
    ]),
    el('div', { class: 'shell' }, [tabs.strip, tabs.panelHost]),
  );
  root.setAttribute('data-state', 'ready');
}

function boot(): void {
  applyDocumentAttributes(store.settings);
  render();

  const palette = new CommandPalette({ i18n });
  palette.install();

  registerPaletteEntries({
    settings: () => store.settings,
    provenance: () => store.snapshot().provenance,
    update: (patch) => store.update(patch),
    resetKey: (path) => store.resetKey(path),
    resetAll: () => store.resetAll(),
    // There is no folder to open in a browser. Rather than shipping a control
    // that looks like it works and does nothing, this says what to do instead.
    openDataFolder: () => {
      window.alert(
        'This site keeps settings in this browser only, so there is no folder to open. ' +
          'To clear everything, use "Reset everything to defaults", or clear this site’s ' +
          'storage in your browser settings.',
      );
    },
    find: (selector) => document.querySelector<HTMLElement>(selector),
  });

  store.onChange((snapshot) => {
    i18n = new I18n({
      mode: snapshot.settings.languageMode,
      englishLevel: snapshot.settings.funnyLevels.english,
      cantoneseLevel: snapshot.settings.funnyLevels.cantonese,
      vocabulary: {},
    });
    applyDocumentAttributes(snapshot.settings);
    render();
  });

  void paletteRegistry;
  void revealElement;
}

boot();
