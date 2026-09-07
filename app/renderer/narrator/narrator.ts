/**
 * The spoken narrator.
 *
 * OFF BY DEFAULT, always. It is an accommodation, not an opinion about how
 * everybody should work, and something that starts talking on its own has
 * decided something about the user it has no standing to decide.
 *
 * The hard parts are not the speaking. They are:
 *
 *   - THE VOICE LIST ARRIVES LATE. Platform enumeration commonly returns
 *     nothing on the first call and fills in a moment later behind an event.
 *     A picker that reads it once reports "no voices installed" on a machine
 *     with forty and looks broken rather than slow.
 *   - VOICES ARE IDENTIFIED BY URI, NEVER BY NAME. Names are not unique - one
 *     machine can carry several voices sharing a name from different engines -
 *     and platforms localise them, so a profile written on one install
 *     silently stops matching on another.
 *   - NOTHING MAY OVERLAP. One utterance at a time, through a queue, or two
 *     announcements talk over each other and neither is understood.
 *   - A SUPERSEDED LINE IS REPLACED, NOT STACKED. Six queued progress
 *     announcements are five announcements nobody wanted, read out after the
 *     thing they described has finished.
 */

export type NarratorLanguage = 'en' | 'yue' | 'both';

/** What the platform tells us about one installed voice. */
export interface VoiceInfo {
  /** The stable identity. What is persisted. */
  readonly voiceURI: string;
  /** For display only. Localised, and not unique. */
  readonly name: string;
  /** BCP-47, e.g. `en-GB` or `zh-HK`. */
  readonly lang: string;
  /** True when the voice needs the network and goes quiet offline. */
  readonly localService: boolean;
  readonly default: boolean;
}

export type Category =
  | 'error'
  | 'warning'
  | 'success'
  | 'progress'
  | 'navigation'
  | 'info';

export interface Utterance {
  readonly text: string;
  readonly lang: 'en' | 'yue';
  readonly category: Category;
  /**
   * Lines sharing a key replace one another rather than stacking.
   *
   * Progress is the case this exists for: without it a slow operation queues
   * one announcement per update and reads them all out long after it finished.
   */
  readonly replaces?: string;
}

/** The chosen voice for one language, or the automatic default. */
export const AUTOMATIC = 'automatic' as const;
export type VoiceChoice = string;

export interface VoicePreference {
  /** A voiceURI, or AUTOMATIC. */
  readonly voiceUri: VoiceChoice;
  /** Platform range is 0.1 to 10; anything outside is refused, not clamped. */
  readonly rate: number;
  /** Platform range is 0 to 2. */
  readonly pitch: number;
}

export const DEFAULT_PREFERENCE: VoicePreference = {
  voiceUri: AUTOMATIC,
  rate: 1,
  pitch: 1,
};

export const RATE_RANGE = { min: 0.5, max: 2 } as const;
export const PITCH_RANGE = { min: 0, max: 2 } as const;

export function isUsableRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= RATE_RANGE.min && value <= RATE_RANGE.max;
}

export function isUsablePitch(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= PITCH_RANGE.min && value <= PITCH_RANGE.max;
}

/**
 * The status of a chosen voice, so the surface can say what is really true.
 *
 * A select box that merely shows a value implies that value is what will be
 * heard, which is exactly the state that needs saying out loud when it is not.
 */
export type VoiceStatus =
  | { readonly kind: 'automatic'; readonly resolved: VoiceInfo | null }
  | { readonly kind: 'chosen'; readonly voice: VoiceInfo }
  | { readonly kind: 'missing'; readonly voiceUri: string; readonly fallback: VoiceInfo | null }
  | { readonly kind: 'none-for-language'; readonly lang: string }
  | { readonly kind: 'no-speech' };

/** Which BCP-47 prefixes count as which of our two languages. */
const PREFIX: Record<'en' | 'yue', string[]> = {
  en: ['en'],
  // Cantonese is `yue`, and is also commonly shipped as `zh-HK`. Matching only
  // `yue` finds nothing on most machines; matching all of `zh` picks Mandarin,
  // which is a different language read aloud in a way a Cantonese speaker will
  // not thank anybody for.
  yue: ['yue', 'zh-hk', 'zh-yue'],
};

export function voicesFor(voices: readonly VoiceInfo[], lang: 'en' | 'yue'): VoiceInfo[] {
  const wanted = PREFIX[lang];
  return voices.filter((voice) => {
    const tag = voice.lang.toLowerCase().replace('_', '-');
    return wanted.some((prefix) => tag === prefix || tag.startsWith(prefix + '-'));
  });
}

/**
 * Work out what will actually be heard.
 *
 * Never mutates the preference. A chosen voice that is not installed keeps the
 * CHOICE and reports the fallback: silently resetting it means a user who
 * copies their profile to a machine that lacks the voice loses the setting
 * permanently rather than temporarily.
 */
export function resolveVoice(
  voices: readonly VoiceInfo[],
  lang: 'en' | 'yue',
  preference: VoicePreference,
  speechAvailable = true,
): VoiceStatus {
  if (!speechAvailable) return { kind: 'no-speech' };

  const candidates = voicesFor(voices, lang);

  if (preference.voiceUri !== AUTOMATIC) {
    const chosen = voices.find((voice) => voice.voiceURI === preference.voiceUri);
    if (chosen !== undefined) return { kind: 'chosen', voice: chosen };
    return {
      kind: 'missing',
      voiceUri: preference.voiceUri,
      fallback: pickAutomatic(candidates),
    };
  }

  if (candidates.length === 0) return { kind: 'none-for-language', lang };
  return { kind: 'automatic', resolved: pickAutomatic(candidates) };
}

/**
 * The automatic choice.
 *
 * A local voice is preferred over a network-backed one, because a network
 * voice goes silent offline and a narrator that stops working on a train is
 * a narrator people switch off. The platform default wins among equals.
 */
function pickAutomatic(candidates: readonly VoiceInfo[]): VoiceInfo | null {
  if (candidates.length === 0) return null;
  const local = candidates.filter((voice) => voice.localService);
  const pool = local.length > 0 ? local : candidates;
  return pool.find((voice) => voice.default) ?? pool[0] ?? null;
}

/** A plain-words description of a status. Never colour, never an icon alone. */
export function describeStatus(status: VoiceStatus): string {
  switch (status.kind) {
    case 'no-speech':
      return 'This machine has no speech engine, so nothing will be spoken.';
    case 'none-for-language':
      return 'No voice on this computer can read this language, so nothing will be spoken for it.';
    case 'missing':
      return status.fallback === null
        ? 'The chosen voice is not installed on this computer, and there is nothing to fall back to. Your choice has been kept.'
        : 'The chosen voice is not installed on this computer. ' +
          status.fallback.name +
          ' will be used instead, and your choice has been kept.';
    case 'automatic':
      if (status.resolved === null) return 'No voice is available.';
      return (
        status.resolved.name +
        ' will be used.' +
        (status.resolved.localService ? '' : ' It needs the network and will go quiet offline.')
      );
    case 'chosen':
      return (
        status.voice.name +
        ' will be used.' +
        (status.voice.localService ? '' : ' It needs the network and will go quiet offline.')
      );
  }
}

/**
 * The rate limiter.
 *
 * Narration stays infrequent: a debounce plus a per-category cooldown. What is
 * NOT rate-limited is spoken error narration - an error that is swallowed
 * because a similar one was spoken recently is exactly the announcement
 * somebody needed.
 */
export class RateLimiter {
  private readonly lastSpoken = new Map<Category, number>();

  constructor(private readonly cooldownMs = 4000) {}

  allows(category: Category, now: number): boolean {
    if (category === 'error' || category === 'warning') return true;
    const last = this.lastSpoken.get(category);
    return last === undefined || now - last >= this.cooldownMs;
  }

  record(category: Category, now: number): void {
    this.lastSpoken.set(category, now);
  }
}

export interface SpeechPort {
  /** Speak one line. Resolves when it finishes or is cancelled. */
  speak(request: {
    text: string;
    voiceUri: string | null;
    lang: string;
    rate: number;
    pitch: number;
  }): Promise<void>;
  cancel(): void;
  available(): boolean;
}

/**
 * The serialized queue.
 *
 * One utterance at a time. Two announcements talking over each other leaves
 * neither understood, which is worse than either alone.
 */
export class NarratorQueue {
  private queue: Utterance[] = [];
  private speaking = false;
  private stopped = false;
  /**
   * Whether a screen reader is currently active.
   *
   * When one is, the narrator YIELDS: it stops speaking and drops what is
   * queued rather than talking over the reader the person is actually relying
   * on. Two voices reading different things at once leaves neither
   * understood, and the screen reader is the one they chose.
   *
   * Reported by the host rather than guessed. On Windows this is Electron's
   * `app.accessibilitySupportEnabled`, which the operating system sets when
   * assistive technology attaches - a guess from the renderer would be a
   * guess about somebody's accessibility setup, which is the last thing to
   * guess about.
   */
  private screenReaderActive = false;

  constructor(
    private readonly port: SpeechPort,
    private readonly preferenceFor: (lang: 'en' | 'yue') => VoicePreference,
    private readonly voiceUriFor: (lang: 'en' | 'yue') => string | null,
  ) {}

  pending(): number {
    return this.queue.length;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Tell the queue whether a screen reader is active.
   *
   * Turning it on cancels what is speaking immediately. Waiting for the
   * current line to finish would mean the reader is talked over for however
   * long that line happens to be, which on a long error message is the whole
   * announcement.
   */
  setScreenReaderActive(active: boolean): void {
    this.screenReaderActive = active;
    if (active) this.clear();
    else void this.pump();
  }

  isYielding(): boolean {
    return this.screenReaderActive;
  }

  /** Queue a line, replacing any earlier line that shares its key. */
  enqueue(utterance: Utterance): void {
    if (this.stopped) return;
    // Dropped rather than held. Holding would produce a burst of stale
    // announcements the moment the screen reader is turned off, describing
    // things that finished ten minutes ago.
    if (this.screenReaderActive) return;

    if (utterance.replaces !== undefined) {
      const at = this.queue.findIndex((queued) => queued.replaces === utterance.replaces);
      if (at >= 0) {
        // Replaced in place rather than appended, so the newest wins without
        // jumping ahead of unrelated lines queued before it.
        this.queue[at] = utterance;
        void this.pump();
        return;
      }
    }

    this.queue.push(utterance);
    void this.pump();
  }

  /** Stop now and drop everything queued. */
  clear(): void {
    this.queue = [];
    this.port.cancel();
  }

  /** Stop permanently. Used when the narrator is switched off. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  resume(): void {
    this.stopped = false;
  }

  private async pump(): Promise<void> {
    if (this.speaking || this.stopped || this.screenReaderActive) return;
    const next = this.queue.shift();
    if (next === undefined) return;

    this.speaking = true;
    try {
      const preference = this.preferenceFor(next.lang);
      await this.port.speak({
        text: next.text,
        voiceUri: this.voiceUriFor(next.lang),
        lang: next.lang === 'yue' ? 'zh-HK' : 'en-GB',
        rate: preference.rate,
        pitch: preference.pitch,
      });
    } catch {
      // A failed utterance must not wedge the queue. Somebody who cannot hear
      // one line should still hear the next.
    } finally {
      this.speaking = false;
    }
    void this.pump();
  }
}

/**
 * Split one announcement into the utterances a language mode calls for.
 *
 * `both` speaks English then Cantonese, STRICTLY SERIALIZED, as two entries
 * rather than one concatenated string: one string would be read by a single
 * voice, so half of it would be in the wrong accent.
 */
export function utterancesFor(
  language: NarratorLanguage,
  message: { en: string; yue: string },
  category: Category,
  replaces?: string,
): Utterance[] {
  const make = (lang: 'en' | 'yue', text: string): Utterance => ({
    text,
    lang,
    category,
    // The key is per language, so the English and Cantonese halves of one
    // announcement replace their own previous half rather than each other.
    ...(replaces === undefined ? {} : { replaces: replaces + ':' + lang }),
  });

  switch (language) {
    case 'en':
      return [make('en', message.en)];
    case 'yue':
      return [make('yue', message.yue)];
    case 'both':
      return [make('en', message.en), make('yue', message.yue)];
  }
}
