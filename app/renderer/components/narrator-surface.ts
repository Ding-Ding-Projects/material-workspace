/**
 * The narrator's controls.
 *
 * Two voice pickers, not one. Choosing an English voice says nothing whatsoever
 * about which Cantonese voice should read the other half of a bilingual line,
 * so each language carries its own selection, its own rate and pitch, and its
 * own honest status.
 *
 * The status line beneath each picker is the part that earns its place. A
 * select box that merely shows a value implies that value is what will be
 * heard, which is exactly the state that needs saying out loud when it is not.
 */

import { clear, el } from '../dom.js';
import {
  AUTOMATIC,
  DEFAULT_PREFERENCE,
  type NarratorLanguage,
  PITCH_RANGE,
  RATE_RANGE,
  type VoiceInfo,
  type VoicePreference,
  describeStatus,
  isUsablePitch,
  isUsableRate,
  resolveVoice,
  voicesFor,
} from '../narrator/narrator.js';

export interface NarratorSurfaceOptions {
  readonly enabled?: boolean;
  readonly language?: NarratorLanguage;
  readonly english?: VoicePreference;
  readonly cantonese?: VoicePreference;
  /**
   * Where the voice list comes from.
   *
   * Injected because platform enumeration is asynchronous AND event-driven,
   * and because a test cannot install a voice. The real one is
   * `speechSynthesis.getVoices()` plus its `voiceschanged` event.
   */
  readonly voices?: {
    list(): VoiceInfo[];
    onChanged(listener: () => void): () => void;
    available(): boolean;
  };
  readonly onChange?: (state: NarratorState) => void;
  readonly onPreview?: (lang: 'en' | 'yue') => void;
}

export interface NarratorState {
  readonly enabled: boolean;
  readonly language: NarratorLanguage;
  readonly english: VoicePreference;
  readonly cantonese: VoicePreference;
}

interface LanguagePane {
  readonly select: HTMLSelectElement;
  readonly rate: HTMLInputElement;
  readonly pitch: HTMLInputElement;
  readonly status: HTMLElement;
  readonly readout: HTMLElement;
}

/** The browser's speech synthesis, adapted. Absent outside a renderer. */
export function browserVoices(): NarratorSurfaceOptions['voices'] {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (synth === undefined) {
    return {
      list: () => [],
      onChanged: () => () => undefined,
      available: () => false,
    };
  }
  return {
    list: () =>
      synth.getVoices().map((voice) => ({
        voiceURI: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
        localService: voice.localService,
        default: voice.default,
      })),
    onChanged: (listener) => {
      // THE LIST ARRIVES LATE. Enumeration commonly returns nothing on the
      // first call and fills in a moment later behind this event. A picker
      // that reads it once reports "no voices installed" on a machine with
      // forty and looks broken rather than slow.
      synth.addEventListener('voiceschanged', listener);
      return () => synth.removeEventListener('voiceschanged', listener);
    },
    available: () => true,
  };
}

export class NarratorSurface {
  readonly element: HTMLElement;

  private enabled: boolean;
  private language: NarratorLanguage;
  private english: VoicePreference;
  private cantonese: VoicePreference;
  private voiceList: VoiceInfo[] = [];
  private unsubscribe: (() => void) | null = null;

  private readonly enabledToggle: HTMLInputElement;
  private readonly languageSelect: HTMLSelectElement;
  private readonly panes: Record<'en' | 'yue', LanguagePane>;
  private readonly emptyNote: HTMLElement;

  constructor(private readonly options: NarratorSurfaceOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.language = options.language ?? 'en';
    this.english = options.english ?? DEFAULT_PREFERENCE;
    this.cantonese = options.cantonese ?? DEFAULT_PREFERENCE;

    this.enabledToggle = el('input', {
      class: 'narrator-toggle',
      type: 'checkbox',
      id: 'narrator-enabled',
    }) as HTMLInputElement;
    this.enabledToggle.addEventListener('change', () => {
      this.enabled = this.enabledToggle.checked;
      this.emit();
    });

    this.languageSelect = el('select', {
      class: 'narrator-select',
      id: 'narrator-language',
    }) as HTMLSelectElement;
    for (const [value, label] of [
      ['en', 'English'],
      ['yue', 'Cantonese'],
      ['both', 'Both, English first'],
    ] as const) {
      this.languageSelect.append(el('option', { value, text: label }));
    }
    this.languageSelect.addEventListener('change', () => {
      this.language = this.languageSelect.value as NarratorLanguage;
      this.emit();
    });

    this.panes = {
      en: this.buildPane('en', 'English'),
      yue: this.buildPane('yue', 'Cantonese'),
    };

    this.emptyNote = el('p', { class: 'narrator-empty', hidden: true, role: 'status' });

    this.element = el('section', { class: 'narrator', 'aria-label': 'Narrator' }, [
      el('header', { class: 'narrator-header' }, [
        el('h2', { class: 'narrator-title', text: 'Narrator' }),
        el('p', {
          class: 'narrator-lede',
          text:
            'Reads what happens out loud. Off unless you turn it on, and it yields to a ' +
            'screen reader rather than talking over one.',
        }),
      ]),

      el('div', { class: 'narrator-row' }, [
        this.enabledToggle,
        el('label', {
          class: 'narrator-label',
          for: 'narrator-enabled',
          text: 'Speak what happens',
        }),
      ]),

      el('div', { class: 'narrator-field' }, [
        el('label', { class: 'narrator-label', for: 'narrator-language', text: 'Speak in' }),
        this.languageSelect,
        el('span', {
          class: 'narrator-help',
          text: 'Both reads English first, then Cantonese, one after the other rather than at once.',
        }),
      ]),

      this.emptyNote,

      el('div', { class: 'narrator-panes' }, [
        this.paneElement('en', 'English voice'),
        this.paneElement('yue', 'Cantonese voice'),
      ]),
    ]);

    this.attachVoices();
    this.render();
  }

  /** Stop listening. Called when the surface is torn down. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  state(): NarratorState {
    return {
      enabled: this.enabled,
      language: this.language,
      english: this.english,
      cantonese: this.cantonese,
    };
  }

  private attachVoices(): void {
    const source = this.options.voices;
    if (source === undefined) return;
    this.voiceList = source.list();
    // Subscribed even when the first read returned something: a voice can be
    // installed or removed while the application is open.
    this.unsubscribe = source.onChanged(() => {
      this.voiceList = source.list();
      this.render();
    });
  }

  private buildPane(lang: 'en' | 'yue', label: string): LanguagePane {
    const select = el('select', {
      class: 'narrator-select',
      id: 'narrator-voice-' + lang,
    }) as HTMLSelectElement;
    select.addEventListener('change', () => {
      this.updatePreference(lang, { voiceUri: select.value });
    });

    const rate = el('input', {
      class: 'narrator-slider',
      type: 'range',
      id: 'narrator-rate-' + lang,
      min: String(RATE_RANGE.min),
      max: String(RATE_RANGE.max),
      step: '0.05',
      'aria-label': label + ' speaking rate',
    }) as HTMLInputElement;
    rate.addEventListener('input', () => {
      const value = Number(rate.value);
      // Refused rather than clamped: a value outside the range means the
      // control and the model disagree, and quietly bending it hides that.
      if (isUsableRate(value)) this.updatePreference(lang, { rate: value });
    });

    const pitch = el('input', {
      class: 'narrator-slider',
      type: 'range',
      id: 'narrator-pitch-' + lang,
      min: String(PITCH_RANGE.min),
      max: String(PITCH_RANGE.max),
      step: '0.05',
      'aria-label': label + ' pitch',
    }) as HTMLInputElement;
    pitch.addEventListener('input', () => {
      const value = Number(pitch.value);
      if (isUsablePitch(value)) this.updatePreference(lang, { pitch: value });
    });

    return {
      select,
      rate,
      pitch,
      status: el('p', { class: 'narrator-status', role: 'status' }),
      readout: el('span', { class: 'narrator-readout' }),
    };
  }

  private paneElement(lang: 'en' | 'yue', title: string): HTMLElement {
    const pane = this.panes[lang];
    const preview = el('button', {
      class: 'narrator-preview',
      type: 'button',
      text: 'Hear it',
    }) as HTMLButtonElement;
    preview.addEventListener('click', () => this.options.onPreview?.(lang));

    return el('div', { class: 'narrator-pane' }, [
      el('h3', { class: 'narrator-subtitle', text: title }),
      el('label', {
        class: 'narrator-label',
        for: 'narrator-voice-' + lang,
        text: 'Voice',
      }),
      pane.select,
      pane.status,
      el('label', {
        class: 'narrator-label',
        for: 'narrator-rate-' + lang,
        text: 'Speed',
      }),
      pane.rate,
      el('label', {
        class: 'narrator-label',
        for: 'narrator-pitch-' + lang,
        text: 'Pitch',
      }),
      pane.pitch,
      pane.readout,
      preview,
    ]);
  }

  private updatePreference(lang: 'en' | 'yue', patch: Partial<VoicePreference>): void {
    if (lang === 'en') this.english = { ...this.english, ...patch };
    else this.cantonese = { ...this.cantonese, ...patch };
    this.emit();
  }

  private emit(): void {
    this.render();
    this.options.onChange?.(this.state());
  }

  private preferenceFor(lang: 'en' | 'yue'): VoicePreference {
    return lang === 'en' ? this.english : this.cantonese;
  }

  private render(): void {
    this.enabledToggle.checked = this.enabled;
    this.languageSelect.value = this.language;

    const available = this.options.voices?.available() ?? false;

    this.emptyNote.hidden = available && this.voiceList.length > 0;
    if (!this.emptyNote.hidden) {
      this.emptyNote.textContent = available
        ? 'No voices have been reported yet. Some systems list them a moment after starting; ' +
          'this will fill in on its own if any are installed.'
        : 'This machine has no speech engine, so nothing can be spoken.';
    }

    for (const lang of ['en', 'yue'] as const) {
      const pane = this.panes[lang];
      const preference = this.preferenceFor(lang);
      const candidates = voicesFor(this.voiceList, lang);

      clear(pane.select);
      // Automatic is always first and is always the shipped default. Nothing
      // ships with a named voice as its default, because the application
      // cannot know what is installed until it asks, and naming one is a
      // preference for a voice most installs do not have.
      pane.select.append(el('option', { value: AUTOMATIC, text: 'Choose automatically' }));
      for (const candidate of candidates) {
        pane.select.append(
          el('option', {
            value: candidate.voiceURI,
            text: candidate.name + (candidate.localService ? '' : ' (needs the network)'),
          }),
        );
      }

      // A chosen voice that is not installed is kept, so the option is added
      // rather than the selection being silently reset to automatic.
      const chosenPresent =
        preference.voiceUri === AUTOMATIC ||
        candidates.some((candidate) => candidate.voiceURI === preference.voiceUri);
      if (!chosenPresent) {
        pane.select.append(
          el('option', {
            value: preference.voiceUri,
            text: 'Your chosen voice (not installed here)',
          }),
        );
      }
      pane.select.value = preference.voiceUri;

      pane.rate.value = String(preference.rate);
      pane.pitch.value = String(preference.pitch);
      pane.readout.textContent =
        'Speed ' + preference.rate.toFixed(2) + ', pitch ' + preference.pitch.toFixed(2);

      pane.status.textContent = describeStatus(
        resolveVoice(this.voiceList, lang, preference, available),
      );
    }
  }
}
