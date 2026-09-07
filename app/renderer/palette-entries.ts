/**
 * What this build registers with the command palette.
 *
 * Every setting row here is wired to the REAL settings bridge, so changing it
 * from the palette writes the same file the settings surface writes and the
 * interface updates live. Two paths to one value that disagree is the defect
 * this arrangement exists to make impossible.
 *
 * Nothing is registered speculatively. A row appears only when the thing it
 * points at genuinely exists, because a palette entry that teleports nowhere is
 * a decorative control with extra steps.
 */

import type { Message } from './i18n.js';
import type { WorkspaceSettings } from '../shared/settings.js';
import { paletteRegistry, type PaletteEntry } from './components/palette/registry.js';

export interface EntryContext {
  settings: () => WorkspaceSettings;
  provenance: () => Record<string, 'written' | 'default'>;
  update: (patch: Record<string, unknown>) => void;
  resetKey: (dotted: string) => void;
  resetAll: () => void;
  openDataFolder: () => void;
  /** Resolve a destination element at activation time, never at registration
   *  time: the shell re-renders, so an element captured early is stale. */
  find: (selector: string) => HTMLElement | null;
}

const G = {
  appearance: { en: 'Appearance', yue: '外觀' } as Message,
  language: { en: 'Language', yue: '語言' } as Message,
  saving: { en: 'Saving', yue: '儲存' } as Message,
  focus: { en: 'Focus and attention', yue: '專注' } as Message,
  navigation: { en: 'Navigation', yue: '導覽' } as Message,
  application: { en: 'Application', yue: '應用程式' } as Message,
};

function dotted(settings: WorkspaceSettings, path: string): unknown {
  let cursor: unknown = settings;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Build a patch that sets one dotted path, preserving its siblings. */
function patchFor(settings: WorkspaceSettings, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.');
  const root = segments[0];
  if (!root) return {};
  if (segments.length === 1) return { [root]: value };

  const branch = structuredClone(
    (settings as unknown as Record<string, unknown>)[root],
  ) as Record<string, unknown>;
  let cursor = branch;
  for (const segment of segments.slice(1, -1)) {
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null) return {};
    cursor = next as Record<string, unknown>;
  }
  const last = segments.at(-1);
  if (!last) return {};
  cursor[last] = value;
  return { [root]: branch };
}

export function registerPaletteEntries(context: EntryContext): () => void {
  const entries: PaletteEntry[] = [];

  const settingSwitch = (
    id: string,
    title: Message,
    group: Message,
    path: string,
    keywords: string[] = [],
  ): PaletteEntry => ({
    id,
    kind: 'setting',
    title,
    group,
    keywords,
    path,
    control: {
      type: 'switch',
      get: () => Boolean(dotted(context.settings(), path)),
      set: (value) => context.update(patchFor(context.settings(), path, value)),
    },
    provenance: () => context.provenance()[path] ?? 'default',
    reset: () => context.resetKey(path),
  });

  const settingChoice = (
    id: string,
    title: Message,
    group: Message,
    path: string,
    options: { value: string; label: Message }[],
    keywords: string[] = [],
  ): PaletteEntry => ({
    id,
    kind: 'setting',
    title,
    group,
    keywords,
    path,
    control: {
      type: 'choice',
      get: () => String(dotted(context.settings(), path) ?? ''),
      set: (value) => context.update(patchFor(context.settings(), path, value)),
      options,
    },
    provenance: () => context.provenance()[path] ?? 'default',
    reset: () => context.resetKey(path),
  });

  const settingStepper = (
    id: string,
    title: Message,
    group: Message,
    path: string,
    bounds: { min: number; max: number; step: number },
    keywords: string[] = [],
  ): PaletteEntry => ({
    id,
    kind: 'setting',
    title,
    group,
    keywords,
    path,
    control: {
      type: 'stepper',
      get: () => Number(dotted(context.settings(), path) ?? 0),
      set: (value) => context.update(patchFor(context.settings(), path, value)),
      ...bounds,
    },
    provenance: () => context.provenance()[path] ?? 'default',
    reset: () => context.resetKey(path),
  });

  // ---- language -----------------------------------------------------------
  entries.push(
    settingChoice(
      'setting.languageMode',
      { en: 'Language mode', yue: '語言模式' },
      G.language,
      'languageMode',
      [
        { value: 'en', label: { en: 'English', yue: '英文' } },
        { value: 'yue', label: { en: 'Cantonese', yue: '廣東話' } },
        { value: 'bilingual', label: { en: 'Both together', yue: '雙語' } },
      ],
      ['cantonese', 'english', 'bilingual', '語言'],
    ),
    settingStepper(
      'setting.funny.english',
      { en: 'Funny level, English', yue: '英文搞笑程度' },
      G.language,
      'funnyLevels.english',
      { min: 1, max: 5, step: 1 },
      ['humour', 'humor', 'tone', 'serious', 'playful'],
    ),
    settingStepper(
      'setting.funny.cantonese',
      { en: 'Funny level, Cantonese', yue: '廣東話搞笑程度' },
      G.language,
      'funnyLevels.cantonese',
      { min: 1, max: 5, step: 1 },
      ['humour', 'humor', 'tone', 'serious', 'playful'],
    ),
    settingSwitch(
      'setting.dialogEmoji',
      { en: 'Show emojis in dialogs and message boxes', yue: '對話框顯示表情符號' },
      G.language,
      'dialogEmoji',
      ['emoji', 'dialog', 'message box'],
    ),
  );

  // ---- appearance ---------------------------------------------------------
  entries.push(
    settingChoice(
      'setting.theme',
      { en: 'Theme', yue: '主題' },
      G.appearance,
      'appearance.theme',
      [
        { value: 'system', label: { en: 'Follow the system', yue: '跟系統' } },
        { value: 'light', label: { en: 'Light', yue: '淺色' } },
        { value: 'dark', label: { en: 'Dark', yue: '深色' } },
      ],
      ['dark', 'light', 'colour', 'color'],
    ),
    settingChoice(
      'setting.density',
      { en: 'Density', yue: '密度' },
      G.appearance,
      'appearance.density',
      [
        { value: 'comfortable', label: { en: 'Comfortable', yue: '寬鬆' } },
        { value: 'standard', label: { en: 'Standard', yue: '標準' } },
        { value: 'compact', label: { en: 'Compact', yue: '緊湊' } },
      ],
      ['spacing', 'compact', 'comfortable'],
    ),
    settingStepper(
      'setting.fontScale',
      { en: 'Text size', yue: '文字大小' },
      G.appearance,
      'appearance.fontScale',
      { min: 0.5, max: 3, step: 0.05 },
      ['font', 'scale', 'bigger', 'smaller', 'zoom'],
    ),
    settingChoice(
      'setting.reducedMotion',
      { en: 'Reduced motion', yue: '減少動態效果' },
      G.appearance,
      'appearance.reducedMotion',
      [
        { value: 'system', label: { en: 'Follow the system', yue: '跟系統' } },
        { value: 'on', label: { en: 'Always reduce motion', yue: '一律減少' } },
        { value: 'off', label: { en: 'Never reduce motion', yue: '一律唔減' } },
      ],
      ['animation', 'motion', 'accessibility'],
    ),
    settingStepper(
      'setting.rainbowSpeed',
      { en: 'Rainbow speed', yue: '彩虹速度' },
      G.appearance,
      'appearance.rainbowSpeedLevel',
      { min: 1, max: 5, step: 1 },
      ['rainbow', 'animated', 'colour cycle'],
    ),
    settingChoice(
      'setting.tabEdge',
      { en: 'Tab strip edge', yue: '分頁列位置' },
      G.navigation,
      'tabs.edge',
      [
        { value: 'left', label: { en: 'Left', yue: '左邊' } },
        { value: 'right', label: { en: 'Right', yue: '右邊' } },
        { value: 'top', label: { en: 'Top', yue: '頂部' } },
        { value: 'bottom', label: { en: 'Bottom', yue: '底部' } },
      ],
      ['dock', 'tabs', 'sidebar'],
    ),
  );

  // ---- attention ----------------------------------------------------------
  // Every one is independent. Never a single master switch: attention
  // difficulties do not arrive as one setting, and bundling them means most
  // people turn the whole thing off to escape the one part that does not suit.
  const adhd: [string, Message, string][] = [
    ['focus', { en: 'Focus: bring the current thing forward', yue: '專注：突出而家做緊嘅嘢' }, 'adhd.focus'],
    [
      'lowStimulation',
      { en: 'Low stimulation: fewer moving things', yue: '低刺激：少啲郁動' },
      'adhd.lowStimulation',
    ],
    [
      'timeAwareness',
      { en: 'Time awareness: show elapsed time where work happens', yue: '時間感：顯示已用時間' },
      'adhd.timeAwareness',
    ],
    [
      'oneThingAtATime',
      { en: 'One thing at a time: a single visible next action', yue: '一次做一樣：淨係顯示下一步' },
      'adhd.oneThingAtATime',
    ],
    [
      'momentum',
      { en: 'Momentum: a gentle nudge when nothing has changed', yue: '推一推：耐咗無郁就提你' },
      'adhd.momentum',
    ],
  ];
  for (const [key, title, path] of adhd) {
    entries.push(
      settingSwitch('setting.adhd.' + key, title, G.focus, path, [
        'adhd',
        'attention',
        'accessibility',
      ]),
    );
  }

  // ---- saving -------------------------------------------------------------
  entries.push(
    settingSwitch(
      'setting.autosave.enabled',
      { en: 'Autosave into the local history', yue: '自動儲存入本機歷史' },
      G.saving,
      'autosave.enabled',
      ['autosave', 'git', 'history', 'version'],
    ),
    settingStepper(
      'setting.autosave.debounce',
      { en: 'Autosave debounce, milliseconds', yue: '自動儲存延遲（毫秒）' },
      G.saving,
      'autosave.debounceMs',
      { min: 200, max: 60000, step: 100 },
      ['autosave', 'delay', 'debounce'],
    ),
    settingStepper(
      'setting.autosave.settle',
      { en: 'Autosave settle ceiling, milliseconds', yue: '自動儲存最長等候（毫秒）' },
      G.saving,
      'autosave.settleMs',
      { min: 200, max: 120000, step: 100 },
      ['autosave', 'settle', 'ceiling'],
    ),
  );

  // ---- destinations -------------------------------------------------------
  entries.push(
    {
      id: 'destination.build',
      kind: 'destination',
      title: { en: 'This build: version and provenance', yue: '呢個版本：版本同來源' },
      group: G.application,
      keywords: ['version', 'commit', 'build', 'about', 'signing'],
      reveal: () => context.find('.facts'),
    },
    {
      id: 'destination.applications',
      kind: 'destination',
      title: { en: 'Applications', yue: '應用程式' },
      group: G.application,
      keywords: ['writer', 'sheets', 'slides', 'pdf', 'apps'],
      reveal: () => context.find('.app-grid'),
    },
    {
      id: 'destination.applicationSearch',
      kind: 'destination',
      title: { en: 'Search applications', yue: '搜尋應用程式' },
      group: G.application,
      keywords: ['search', 'filter', 'regex'],
      reveal: () => context.find('#application-search'),
    },
  );

  // ---- commands -----------------------------------------------------------
  entries.push(
    {
      id: 'command.openDataFolder',
      kind: 'command',
      title: { en: 'Open the application data folder', yue: '打開應用程式資料夾' },
      group: G.application,
      keywords: ['data', 'folder', 'reset', 'appdata', 'recovery'],
      shortcut: null,
      run: () => context.openDataFolder(),
    },
    {
      id: 'command.resetAllSettings',
      kind: 'command',
      title: { en: 'Reset every setting to its shipped default', yue: '所有設定還原做出廠預設' },
      group: G.appearance,
      keywords: ['reset', 'default', 'restore'],
      shortcut: null,
      run: () => context.resetAll(),
    },
    {
      id: 'command.openPalette',
      kind: 'command',
      title: { en: 'Command palette', yue: '指令面板' },
      group: G.navigation,
      keywords: ['palette', 'command', 'search everything'],
      // The shortcut that ACTUALLY works, never one inferred from a similar
      // command: a wrong shortcut trains a user to press a key that does nothing.
      shortcut: 'Ctrl+Shift+F',
      run: () => undefined,
    },
  );

  return paletteRegistry.registerAll(entries);
}
