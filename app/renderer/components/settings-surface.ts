/**
 * The settings surface.
 *
 * Built from the SAME registry the command palette reads, so the two can never
 * drift. A settings page with its own hand-maintained copy of every control
 * diverges the first time somebody adds a setting to one and not the other, and
 * the divergence is silent because both still look complete.
 *
 * Three contract obligations are visible in every row:
 *
 *   1. The control is the real control, wired to the real bridge.
 *   2. Its explanation sits behind progressive disclosure — present when asked
 *      for, out of the way when not.
 *   3. A provenance line says whether the value was genuinely changed or is the
 *      compiled-in fallback, NAMING the shipped value. "Default" on its own
 *      tells a reader nothing they can act on.
 *
 * The surface is tabbed, and each tab has its own search field with its own
 * anchored regular-expression builder. "It is only settings" is not an exemption
 * from the tab contract, and neither is "it is a small section".
 */

import { clear, el } from '../dom.js';
import type { I18n, Message } from '../i18n.js';
import { SearchField, type SearchPredicate } from './search-field.js';
import { TabStrip, type TabDefinition } from './tabs.js';
import { paletteRegistry, type PaletteEntry, type SettingEntry } from './palette/registry.js';
import type { WorkspaceSettings } from '../../shared/settings.js';

export interface SettingsSurfaceOptions {
  i18n: I18n;
  /**
   * Which section to open on.
   *
   * Passed in rather than always starting at the first one, because changing
   * a setting re-renders the shell and rebuilds this surface. Without it, a
   * user who toggles anything in Appearance is thrown back to Language and
   * loses their place — every single time they change something.
   */
  initialSection?: string;
  onSectionChange?: (id: string) => void;
  /** The shipped defaults, so a row can name the value it would fall back to. */
  shippedDefaults: WorkspaceSettings;
  onResetAll: () => void;
}

interface Section {
  id: string;
  title: Message;
  icon: string;
  /** Which registry groups belong to this section. */
  groups: string[];
}

const SECTIONS: Section[] = [
  {
    id: 'language',
    title: { en: 'Language', yue: '語言' },
    icon: '\u{1F5E3}',
    groups: ['Language'],
  },
  {
    id: 'appearance',
    title: { en: 'Appearance', yue: '外觀' },
    icon: '\u{1F3A8}',
    groups: ['Appearance'],
  },
  {
    id: 'attention',
    title: { en: 'Focus and attention', yue: '專注' },
    icon: '\u{1F9E0}',
    groups: ['Focus and attention'],
  },
  {
    id: 'saving',
    title: { en: 'Saving', yue: '儲存' },
    icon: '\u{1F4BE}',
    groups: ['Saving'],
  },
  {
    id: 'navigation',
    title: { en: 'Navigation', yue: '導覽' },
    icon: '\u{1F9ED}',
    groups: ['Navigation'],
  },
];

/**
 * Plain-language explanations, keyed by settings path.
 *
 * Written to say what the setting DOES, never to restate its own label. "Theme:
 * sets the theme" is a row that has taken up space and told the reader nothing.
 */
const EXPLANATIONS: Record<string, Message> = {
  languageMode: {
    en: 'Which language the interface is written in. Bilingual shows English with a compact Cantonese line beneath each label.',
    yue: '介面用邊種語言。雙語會喺每個標籤下面加一行細細嘅廣東話。',
  },
  'funnyLevels.english': {
    en: 'How playful the English copy is, from 1 (fully professional) to 5. It changes the wording only — every message still names exactly what happened and what your options are, including errors and warnings.',
    yue: '英文寫得幾搞笑，1 係完全正經，5 最玩得。只係改個講法，每句嘢一樣會講清楚發生咗乜同你有咩揀，錯誤同警告都一樣。',
  },
  'funnyLevels.cantonese': {
    en: 'How playful the Cantonese copy is, from 1 to 5. Set independently of the English level, because they are read by different people in different moods.',
    yue: '廣東話寫得幾搞笑，1 至 5。同英文嗰個分開設定。',
  },
  dialogEmoji: {
    en: 'Adds a relevant emoji to dialogs and message boxes. Emoji never appear in buttons, field labels or anything assistive technology reads as information.',
    yue: '喺對話框加個相關嘅表情符號。掣、欄位標籤同輔助技術讀嘅嘢一律唔會有。',
  },
  'appearance.theme': {
    en: 'Light, dark, or whichever the operating system is currently using.',
    yue: '淺色、深色，或者跟返作業系統而家用緊嗰個。',
  },
  'appearance.density': {
    en: 'How much space rows and controls take. Compact draws smaller controls but never shrinks the area you can actually click or tap.',
    yue: '啲行同掣有幾疏。緊湊會畫細啲，但你撳得到嘅範圍唔會縮細。',
  },
  'appearance.fontScale': {
    en: 'Multiplies every text size in the interface. 1 is the shipped size.',
    yue: '成個介面嘅字體大細倍數，1 就係出廠大細。',
  },
  'appearance.reducedMotion': {
    en: 'Reduces or removes animation. Following the system is the default, so an operating-system preference you have already set is honoured without asking again.',
    yue: '減少或者取消動畫。預設跟系統，你喺系統設定過就唔使再講一次。',
  },
  'appearance.rainbowSpeedLevel': {
    en: 'How fast the animated rainbow colour cycles, when it is chosen. Every rainbow surface turns together. Under reduced motion it settles on one hue rather than merely slowing down, because a slow cycle is still motion.',
    yue: '揀咗彩虹色嗰陣轉幾快，所有彩虹位一齊轉。減少動態效果嗰陣會停喺一隻色，唔係轉慢啲 —— 轉得慢都仲係郁緊。',
  },
  'tabs.edge': {
    en: 'Which edge the tab strip docks to. Left is the default: a screen is wider than it is tall, so a vertical strip shows more tabs legibly.',
    yue: '分頁列擺喺邊一邊。預設左邊 —— 個芒闊過高，直排放得落多啲分頁。',
  },
  'adhd.focus': {
    en: 'Brings whatever you are working on forward and pushes the rest back. It dims and de-emphasises; it never hides anything you cannot get back in one action.',
    yue: '突出你做緊嗰樣，其他推後。只係暗啲，唔會收埋你一撳攞唔返嘅嘢。',
  },
  'adhd.lowStimulation': {
    en: 'Fewer moving things, quieter colour, and notifications reduced to the ones that genuinely need you.',
    yue: '少啲郁動、色淡啲、通知淨係留低真係要你理嗰啲。',
  },
  'adhd.timeAwareness': {
    en: 'Shows elapsed time where the work is, not buried in a settings page. It states a number; it never nags about it.',
    yue: '喺你做緊嘢嗰度顯示用咗幾耐。淨係報個數，唔會囉嗦。',
  },
  'adhd.oneThingAtATime': {
    en: 'Keeps a single visible next action, chosen by you rather than guessed at, and it survives a context switch.',
    yue: '淨係擺一個下一步喺度，你自己揀，走開咗返嚟都仲喺度。',
  },
  'adhd.momentum': {
    en: 'A gentle, dismissible prompt when something has sat untouched. Saying "not now" is respected for a stated period, not for thirty seconds.',
    yue: '有嘢擺耐咗會輕輕提你一句，撳走得。話咗「唔係而家」就真係有段時間唔嘈你。',
  },
  'autosave.enabled': {
    en: 'Records every change into a Git repository this application owns, kept beside its own data and never inside your folders. History is append-only, so restoring adds a new entry rather than erasing anything.',
    yue: '將每次改動記入呢個程式自己嘅 Git 倉，擺喺自己資料夾，唔會入你啲資料夾。歷史係只加唔改，還原係加多一筆，唔會抹走嘢。',
  },
  'autosave.debounceMs': {
    en: 'How long typing must pause before a change is recorded. A burst of typing becomes one entry rather than four hundred.',
    yue: '停手幾耐先記一筆。連續打字會變一筆，唔係四百筆。',
  },
  'autosave.settleMs': {
    en: 'The longest a change can wait before it is recorded anyway, so an unbroken hour of typing is not left unrecorded.',
    yue: '最耐等幾耐都一定記一次，唔會打成個鐘都乜都無記低。',
  },
};

function formatShipped(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null) return 'not set';
  return String(value);
}

function dotted(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export class SettingsSurface {
  readonly element: HTMLElement;

  private readonly options: SettingsSurfaceOptions;
  private readonly i18n: I18n;
  private readonly sectionBodies = new Map<string, HTMLElement>();
  private readonly predicates = new Map<string, SearchPredicate | null>();
  private tabs: TabStrip | null = null;

  constructor(options: SettingsSurfaceOptions) {
    this.options = options;
    this.i18n = options.i18n;

    const definitions: TabDefinition[] = SECTIONS.map((section) => ({
      id: section.id,
      label: this.i18n.t(section.title),
      searchText: [
        this.i18n.english(section.title),
        this.i18n.cantonese(section.title),
        section.id,
      ].join(' '),
      icon: section.icon,
      render: () => this.renderSection(section),
    }));

    this.tabs = new TabStrip({
      edge: 'top',
      tabs: definitions,
      onActivate: (id) => options.onSectionChange?.(id),
    });
    if (options.initialSection) this.tabs.activate(options.initialSection);

    this.element = el('div', { class: 'settings' }, [
      el('div', { class: 'settings__header' }, [
        el('h2', { class: 'card__title', text: this.i18n.t({ en: 'Settings', yue: '設定' }) }),
        this.renderResetAll(),
      ]),
      el('div', { class: 'settings__tabs' }, [this.tabs.strip]),
      this.tabs.panelHost,
    ]);

    // Rebuild a section when the registry changes, so a setting added by another
    // surface appears here without a restart.
    paletteRegistry.onChange(() => this.refreshAll());
  }

  private renderResetAll(): HTMLElement {
    const button = el('button', { class: 'settings__reset-all', type: 'button' });
    button.textContent = this.i18n.t({
      en: 'Reset everything to defaults',
      yue: '全部還原做預設',
    });
    button.addEventListener('click', () => this.options.onResetAll());
    return button;
  }

  /** Re-render every built section in place, preserving each one's search. */
  refreshAll(): void {
    for (const section of SECTIONS) {
      const body = this.sectionBodies.get(section.id);
      if (body) this.renderRows(section, body);
    }
  }

  private renderSection(section: Section): HTMLElement {
    const body = el('div', { class: 'settings__rows' });
    this.sectionBodies.set(section.id, body);

    // Each settings surface carries its own search, with its own anchored
    // builder. Not shared with any other field on the page.
    const search = new SearchField({
      id: 'settings-search-' + section.id,
      label: 'Search ' + this.i18n.english(section.title) + ' settings',
      placeholder: 'Search these settings',
      onChange: (predicate) => {
        this.predicates.set(section.id, predicate);
        this.renderRows(section, body);
      },
    });

    this.renderRows(section, body);

    return el('section', { class: 'settings__section' }, [search.element, body]);
  }

  private entriesFor(section: Section): SettingEntry[] {
    return paletteRegistry
      .all()
      .filter((entry): entry is SettingEntry => entry.kind === 'setting')
      .filter((entry) => section.groups.includes(this.i18n.english(entry.group)));
  }

  private renderRows(section: Section, body: HTMLElement): void {
    clear(body);
    const predicate = this.predicates.get(section.id) ?? null;
    const all = this.entriesFor(section);

    if (predicate?.error) {
      body.append(
        el('p', {
          class: 'settings__empty',
          role: 'status',
          text: 'That pattern will not compile, so nothing was matched: ' + predicate.error,
        }),
      );
      return;
    }

    const visible =
      predicate && !predicate.empty && predicate.test
        ? all.filter((entry) => {
            const text = [
              this.i18n.english(entry.title),
              this.i18n.cantonese(entry.title),
              entry.path,
              ...(entry.keywords ?? []),
            ].join(' ');
            return predicate.test?.(text) ?? false;
          })
        : all;

    if (visible.length === 0) {
      // Where a match exists on ANOTHER tab, say so, so the user can navigate
      // rather than concluding the setting does not exist.
      const elsewhere =
        predicate && !predicate.empty && predicate.test
          ? paletteRegistry
              .all()
              .filter((entry): entry is SettingEntry => entry.kind === 'setting')
              .filter((entry) =>
                predicate.test?.(
                  [this.i18n.english(entry.title), this.i18n.cantonese(entry.title)].join(' '),
                ),
              )
          : [];

      body.append(
        el('p', { class: 'settings__empty', role: 'status' }, [
          document.createTextNode(
            elsewhere.length > 0
              ? 'Nothing here matches, but ' +
                (elsewhere.length === 1 ? 'one setting does' : elsewhere.length + ' settings do') +
                ' on another tab: '
              : 'No setting here matches that search.',
          ),
          elsewhere.length > 0
            ? document.createTextNode(
                elsewhere.map((entry) => this.i18n.t(entry.title)).join(', ') + '.',
              )
            : null,
        ]),
      );
      return;
    }

    for (const entry of visible) body.append(this.renderRow(entry));
  }

  private renderRow(entry: SettingEntry): HTMLElement {
    const rowId = 'setting-row-' + entry.id;
    const row = el('div', { class: 'settings__row', id: rowId, 'data-path': entry.path });

    const controlId = 'settings-control-' + entry.id;
    const label = el('label', {
      class: 'settings__row-label',
      for: controlId,
      text: this.i18n.t(entry.title),
    });

    row.append(el('div', { class: 'settings__row-head' }, [label, this.renderControl(entry, controlId)]));

    // The explanation, behind progressive disclosure: present when asked for,
    // out of the way when not.
    const explanation = EXPLANATIONS[entry.path];
    if (explanation) {
      row.append(
        el('details', { class: 'settings__explanation' }, [
          el('summary', { text: this.i18n.t({ en: 'What this does', yue: '呢個係做乜' }) }),
          el('p', { text: this.i18n.t(explanation) }),
        ]),
      );
    }

    // Provenance, NAMING the shipped value rather than saying only "default".
    const provenance = entry.provenance();
    const shipped = formatShipped(dotted(this.options.shippedDefaults, entry.path));
    row.append(
      el('p', { class: 'settings__provenance', 'data-provenance': provenance }, [
        document.createTextNode(
          provenance === 'default'
            ? 'This is the value the application ships with (' + shipped + '). Nobody has changed it.'
            : 'This value was changed and saved. The shipped value is ' + shipped + '.',
        ),
      ]),
    );

    if (provenance === 'written') {
      const reset = el('button', { class: 'settings__reset', type: 'button' });
      reset.textContent = this.i18n.t({ en: 'Reset this', yue: '還原呢項' });
      reset.setAttribute(
        'aria-label',
        this.i18n.accessible(entry.title) + ' — reset to the shipped value ' + shipped,
      );
      reset.addEventListener('click', () => entry.reset());
      row.append(reset);
    }

    return row;
  }

  private renderControl(entry: SettingEntry, controlId: string): HTMLElement {
    const control = entry.control;
    const wrapper = el('div', { class: 'settings__control' });

    if (control.type === 'switch') {
      const input = el('input', { type: 'checkbox', id: controlId }) as HTMLInputElement;
      input.checked = control.get();
      input.addEventListener('change', () => control.set(input.checked));
      wrapper.append(input);
    } else if (control.type === 'stepper') {
      const input = el('input', {
        type: 'number',
        id: controlId,
        min: String(control.min),
        max: String(control.max),
        step: String(control.step),
      }) as HTMLInputElement;
      input.value = String(control.get());
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) control.set(value);
      });
      wrapper.append(input);
    } else if (control.type === 'choice') {
      const select = el('select', { id: controlId }) as HTMLSelectElement;
      for (const option of control.options) {
        select.append(el('option', { value: option.value, text: this.i18n.t(option.label) }));
      }
      select.value = control.get();
      select.addEventListener('change', () => control.set(select.value));
      wrapper.append(select);
    } else {
      const input = el('input', {
        type: 'text',
        id: controlId,
        placeholder: control.placeholder ?? '',
      }) as HTMLInputElement;
      input.value = control.get();
      input.addEventListener('change', () => control.set(input.value));
      wrapper.append(input);
    }

    return wrapper;
  }
}

/** Present for the completeness inventory: the sections this surface ships. */
export function settingsSectionIds(): string[] {
  return SECTIONS.map((section) => section.id);
}

export type { PaletteEntry };
