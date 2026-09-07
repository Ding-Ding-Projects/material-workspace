/**
 * Language modes and funny levels.
 *
 * Three modes — English, playful Hong Kong Cantonese, and both together — and
 * two INDEPENDENT funny sliders, one per language, each 1 to 5 and each shipping
 * at 5.
 *
 * The rule that governs every string in this file: the funny level changes
 * VOICE, never FACTS. At any level a message still names what happened, what is
 * affected, and what the options are, in unambiguous words. Humour wraps the
 * facts; it never replaces, softens or omits them. A warning nobody can act on
 * is a broken warning, not a funny one. That applies to every category with no
 * exemption — destructive, security, accessibility and error copy included —
 * because the user is told plainly what the setting affects before they opt in.
 *
 * Interpolated values (counts, paths, versions, error text) are substituted
 * verbatim at every level and are never restyled.
 *
 * Keys are namespaced per surface. A new surface reusing an obvious key like
 * "home.title" that an older surface already owns renders the OLDER surface's
 * copy, and no test catches it: mounted in isolation there is no catalogue, so
 * the fallback renders and everything passes.
 */

export type LanguageMode = 'en' | 'yue' | 'bilingual';
export type FunnyLevel = 1 | 2 | 3 | 4 | 5;

/** Five variants, index 0 being level 1 (fully serious). A single string means
 *  the message reads identically at every level, which is correct for a bare
 *  fact like a version number's label. */
export type Variants = string | readonly [string, string, string, string, string];

export interface Message {
  en: Variants;
  yue: Variants;
}

/**
 * A message whose English form inflects with a count.
 *
 * Handled through Intl.PluralRules rather than an `n === 1` test, because the
 * categories a language actually uses are a property of the language and not
 * of English. Cantonese does not inflect nouns for number, so it carries one
 * form; writing a fake plural there would be wrong in the other direction.
 */
export interface PluralMessage {
  en: { one: Variants; other: Variants };
  yue: Variants;
}

function pick(variants: Variants, level: FunnyLevel): string {
  if (typeof variants === 'string') return variants;
  return variants[level - 1] ?? variants[0];
}

export interface I18nState {
  mode: LanguageMode;
  englishLevel: FunnyLevel;
  cantoneseLevel: FunnyLevel;
  /** Applied at the user-facing text boundary only. Commands, URLs,
   *  identifiers, code and file paths are never rewritten. */
  vocabulary: Record<string, string>;
}

const INTERPOLATION = /\{(\w+)\}/g;

function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(INTERPOLATION, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Apply the user's private vocabulary. Longest keys first, so a longer phrase is
 * never half-consumed by a shorter one that happens to be a prefix of it.
 */
function applyVocabulary(text: string, vocabulary: Record<string, string>): string {
  const keys = Object.keys(vocabulary);
  if (keys.length === 0) return text;
  let result = text;
  for (const key of keys.sort((a, b) => b.length - a.length)) {
    const replacement = vocabulary[key];
    if (replacement === undefined) continue;
    result = result.split(key).join(replacement);
  }
  return result;
}

export class I18n {
  private state: I18nState;

  constructor(state: I18nState) {
    this.state = state;
  }

  update(state: Partial<I18nState>): void {
    this.state = { ...this.state, ...state };
  }

  get mode(): LanguageMode {
    return this.state.mode;
  }

  /** The English rendering, at the English funny level. */
  english(message: Message, values: Record<string, string | number> = {}): string {
    return applyVocabulary(
      interpolate(pick(message.en, this.state.englishLevel), values),
      this.state.vocabulary,
    );
  }

  /** The Cantonese rendering, at the Cantonese funny level. */
  cantonese(message: Message, values: Record<string, string | number> = {}): string {
    return applyVocabulary(
      interpolate(pick(message.yue, this.state.cantoneseLevel), values),
      this.state.vocabulary,
    );
  }

  /** The primary string for the active mode. In bilingual mode this is the
   *  prominent label; the secondary comes from secondary() below. */
  t(message: Message, values: Record<string, string | number> = {}): string {
    if (this.state.mode === 'yue') return this.cantonese(message, values);
    return this.english(message, values);
  }

  /** The secondary string, or null outside bilingual mode. Kept separate rather
   *  than concatenated so a caller can render it compactly — bilingual mode must
   *  not crowd the interface, and joining two labels into one string removes any
   *  chance of laying them out properly. */
  secondary(message: Message, values: Record<string, string | number> = {}): string | null {
    if (this.state.mode !== 'bilingual') return null;
    return this.cantonese(message, values);
  }

  /** Render a count-inflected message. */
  plural(
    message: PluralMessage,
    count: number,
    values: Record<string, string | number> = {},
  ): { primary: string; secondary: string | null } {
    const withCount = { ...values, count };
    const category = new Intl.PluralRules('en').select(count);
    const englishVariants = category === 'one' ? message.en.one : message.en.other;
    const english = applyVocabulary(
      interpolate(pick(englishVariants, this.state.englishLevel), withCount),
      this.state.vocabulary,
    );
    const cantonese = applyVocabulary(
      interpolate(pick(message.yue, this.state.cantoneseLevel), withCount),
      this.state.vocabulary,
    );
    if (this.state.mode === 'yue') return { primary: cantonese, secondary: null };
    if (this.state.mode === 'bilingual') return { primary: english, secondary: cantonese };
    return { primary: english, secondary: null };
  }

  /** Both strings, for an accessible name that must carry the whole meaning. */
  accessible(message: Message, values: Record<string, string | number> = {}): string {
    if (this.state.mode === 'bilingual') {
      return this.english(message, values) + ' / ' + this.cantonese(message, values);
    }
    return this.t(message, values);
  }
}

/**
 * The message catalogue.
 *
 * Where a message carries a fact, that fact is interpolated and identical at
 * every level. Compare the five English variants of `front.provenanceUnknown`:
 * the tone moves a long way and the instruction does not move at all.
 */
export const MESSAGES = {
  'shell.appName': { en: 'Material Workspace', yue: 'Material Workspace' },

  'shell.minimise': { en: 'Minimise', yue: '縮細' },
  'shell.maximise': { en: 'Maximise', yue: '放大' },
  'shell.restore': { en: 'Restore down', yue: '還原' },
  'shell.close': { en: 'Close', yue: '閂咗佢' },

  'front.headline': {
    en: [
      'Material Workspace',
      'Material Workspace',
      'Material Workspace',
      'Material Workspace, at your service',
      'Material Workspace — nine applications, no installer for anything else',
    ],
    yue: [
      'Material Workspace',
      'Material Workspace',
      'Material Workspace',
      'Material Workspace，隨時候命',
      'Material Workspace — 九個程式，唔使再裝第二樣嘢',
    ],
  },

  'front.lede': {
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
  },

  'front.buildTitle': { en: 'This build', yue: '呢個版本' },
  'front.version': { en: 'Version', yue: '版本' },
  'front.updatedAt': { en: 'Updated at', yue: '更新時間' },
  'front.commit': { en: 'Commit', yue: 'Commit' },
  'front.branch': { en: 'Branch', yue: '分支' },
  'front.signing': { en: 'Signing', yue: '簽署' },

  'front.unsigned': {
    en: [
      'Unsigned. Windows will show an unknown-publisher warning.',
      'Unsigned. Windows will show an unknown-publisher warning.',
      'Unsigned, so Windows will raise an eyebrow about the publisher.',
      'Unsigned — Windows will give you the unknown-publisher speech. It is expected.',
      'Unsigned, so Windows will do its unknown-publisher routine. Nod politely and carry on; it is deliberate.',
    ],
    yue: [
      '未簽署。Windows 會顯示不明發行者警告。',
      '未簽署。Windows 會顯示不明發行者警告。',
      '未簽署，所以 Windows 會問一問你呢個發行者係邊個。',
      '未簽署 — Windows 一定會彈個「不明發行者」出嚟，正常嚟嘅。',
      '未簽署，Windows 實會演一次「不明發行者」。畀個面佢，撳落去就得，係我哋特登唔簽。',
    ],
  },

  /**
   * The unavailable state. Note that the INSTRUCTION is identical in all five
   * English variants and all five Cantonese ones — only the framing moves. A
   * missing timestamp is never replaced with a guess.
   */
  'front.provenanceUnknown': {
    en: [
      'Not available. This build recorded no timestamp.',
      'Not available. This build recorded no timestamp.',
      'Not available — this build did not write down when it was made.',
      'Not available. This build forgot to note when it was made, and a guess would be worse than nothing.',
      'Not available. This build never wrote down its own birthday, and inventing one would be a lie you could not check.',
    ],
    yue: [
      '無資料。呢個版本無記錄時間。',
      '無資料。呢個版本無記錄時間。',
      '無資料 — 呢個版本無寫低幾時整。',
      '無資料。呢個版本唔記得寫低幾時整，亂噏一個仲衰過無。',
      '無資料。呢個版本連自己幾時出世都無寫低，作一個出嚟你又查唔到，不如唔講。',
    ],
  },

  'front.treeDirtyWarning': {
    en: [
      'This build was made from a working tree with uncommitted changes, so the commit shown does not fully describe what is running.',
      'This build was made from a working tree with uncommitted changes, so the commit shown does not fully describe what is running.',
      'Built from a tree with uncommitted changes, so the commit above only half describes what you are actually running.',
      'Built from a messy tree — there were uncommitted changes, so that commit is a rough description of what is running, not an exact one.',
      'Built from a tree that had uncommitted changes lying about, so treat that commit as a rough sketch of what is running rather than a portrait.',
    ],
    yue: [
      '呢個版本喺有未提交改動嘅工作目錄整出嚟，所以上面個 commit 唔完全代表而家行緊嘅嘢。',
      '呢個版本喺有未提交改動嘅工作目錄整出嚟，所以上面個 commit 唔完全代表而家行緊嘅嘢。',
      '整嗰陣仲有未提交嘅改動，所以個 commit 只係講到一半。',
      '整嗰陣個目錄仲亂緊，有未提交嘅改動，個 commit 只係大概講吓，唔係準確描述。',
      '整嗰陣個目錄仲有一堆未提交嘅嘢喺度，所以個 commit 當草圖睇就得，唔好當佢係寫真。',
    ],
  },


  /** A short label for the tab strip. The headline is deliberately long at
   *  high funny levels; a tab is the tightest space in the shell, so it gets
   *  its own key rather than truncating a sentence written for a heading. */
  'shell.homeTab': { en: 'Home', yue: '主頁' },

  /** Distinct from front.provenanceUnknown, which is specifically about a
   *  missing BUILD TIME. Reusing that message for a missing commit told the
   *  reader the build had not written down its birthday, when the actual
   *  fact was that no commit could be resolved. One message per fact. */
  'front.valueUnknown': {
    en: [
      'Not recorded for this build.',
      'Not recorded for this build.',
      'Not recorded for this build.',
      'Not recorded for this build — it was put together outside version control.',
      'Not recorded. This build was assembled outside version control, so there is genuinely nothing to point at.',
    ],
    yue: [
      '呢個版本無記錄。',
      '呢個版本無記錄。',
      '呢個版本無記錄。',
      '呢個版本無記錄 — 整嗰陣唔喺版本控制入面。',
      '無記錄。呢個版本喺版本控制以外整出嚟，真係無嘢可以指畀你睇。',
    ],
  },

  'front.applicationsTitle': { en: 'Applications', yue: '應用程式' },

  'front.applicationsLede': {
    en: [
      'Nine applications. Those not yet built say so rather than opening an empty window.',
      'Nine applications. Those not yet built say so rather than opening an empty window.',
      'Nine applications. The ones that are not built yet admit it instead of opening an empty window.',
      'Nine applications. The unfinished ones own up rather than opening a blank window and hoping you do not notice.',
      'Nine applications. The ones still under construction say so out loud, because an empty window that pretends to work is worse than an honest label.',
    ],
    yue: [
      '九個程式。未整好嘅會照直講，唔會開個空窗畀你。',
      '九個程式。未整好嘅會照直講，唔會開個空窗畀你。',
      '九個程式。未整好嗰啲會認，唔會扮嘢開個空窗。',
      '九個程式。未做完嗰啲會自己認，唔會開個白窗當冇事發生。',
      '九個程式。仲整緊嗰啲會大大聲講出嚟，因為扮到似模似樣嘅空窗，仲衰過老老實實貼個標籤。',
    ],
  },

  'app.state.available': { en: 'Ready', yue: '可以用' },
  'app.state.building': { en: 'Not built yet', yue: '未整好' },

  'app.writer.name': { en: 'Writer', yue: '文書' },
  'app.writer.summary': {
    en: 'Word processing: layout, pagination, styles, footnotes, change tracking.',
    yue: '文書處理：排版、分頁、樣式、註腳、修訂追蹤。',
  },
  'app.sheets.name': { en: 'Sheets', yue: '試算表' },
  'app.sheets.summary': {
    en: 'Spreadsheets: a dependency graph, incremental recalculation, and a real function library.',
    yue: '試算表：相依圖、增量重算，同埋一個真正嘅函數庫。',
  },
  'app.slides.name': { en: 'Slides', yue: '簡報' },
  'app.slides.summary': {
    en: 'Presentations: layouts, transitions, speaker notes, presenter view.',
    yue: '簡報：版面、轉場、講者備註、講者檢視。',
  },
  'app.draw.name': { en: 'Draw', yue: '繪圖' },
  'app.draw.summary': {
    en: 'Vector drawing: paths, boolean operations, gradients, connectors.',
    yue: '向量繪圖：路徑、布林運算、漸層、連接線。',
  },
  'app.formula.name': { en: 'Formula', yue: '公式' },
  'app.formula.summary': {
    en: 'Mathematical typesetting, with MathML in and out.',
    yue: '數學排版，支援 MathML 匯入匯出。',
  },
  'app.database.name': { en: 'Database', yue: '資料庫' },
  'app.database.summary': {
    en: 'A relational store with a query engine, bound forms and reports.',
    yue: '關聯式資料庫，有查詢引擎、綁定表單同報表。',
  },
  'app.pdf.name': { en: 'PDF', yue: 'PDF' },
  'app.pdf.summary': {
    en: 'Read, annotate, redact by removing bytes, sign and verify.',
    yue: '閱讀、註解、真刪走位元組嘅遮蔽、簽署同驗證。',
  },
  'app.notes.name': { en: 'Notes', yue: '筆記' },
  'app.notes.summary': {
    en: 'Structured notes that link to the documents they describe.',
    yue: '結構化筆記，可以連去佢講緊嗰份文件。',
  },
  'app.forms.name': { en: 'Forms', yue: '表單' },
  'app.forms.summary': {
    en: 'Design a form, fill it, and validate what comes back.',
    yue: '設計表單、填表單，仲會驗返你填咗乜。',
  },

  'status.historyUnavailable': {
    en: 'Document history unavailable: {reason}',
    yue: '文件歷史用唔到：{reason}',
  },
} as const satisfies Record<string, Message>;

/** Count-inflected messages, kept in their own table so the type of each
 *  catalogue stays exact rather than a union that neither checks properly. */
export const PLURAL_MESSAGES = {
  'status.historyHealthy': {
    en: {
      one: 'Document history: {count} entry recorded',
      other: 'Document history: {count} entries recorded',
    },
    yue: '文件歷史：已記錄 {count} 項',
  },
} as const satisfies Record<string, PluralMessage>;


export type MessageKey = keyof typeof MESSAGES;

export function message(key: MessageKey): Message {
  return MESSAGES[key];
}
