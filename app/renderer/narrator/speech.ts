/**
 * The browser's speech synthesis, adapted to the narrator's port.
 *
 * Separate from the surface so the surface can be driven with a fake, and
 * separate from the queue so the queue never touches a platform API.
 */

import type { SpeechPort } from './narrator.js';

/** A short line in each language, for the preview button. */
export const SAMPLE: Record<'en' | 'yue', string> = {
  en: 'This is how the narrator will sound.',
  yue: '\u65C1\u767D\u6703\u5462\u500B\u8072\u7DDA\u8B80\u51FA\u4F86\u3002',
};

export function browserSpeech(): SpeechPort {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;

  if (synth === undefined || typeof SpeechSynthesisUtterance === 'undefined') {
    // Honest rather than a silent no-op: a caller can ask and be told, and the
    // surface says "no speech engine" instead of appearing to work.
    return {
      speak: () => Promise.resolve(),
      cancel: () => undefined,
      available: () => false,
    };
  }

  return {
    speak: (request) =>
      new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(request.text);
        utterance.lang = request.lang;
        utterance.rate = request.rate;
        utterance.pitch = request.pitch;

        if (request.voiceUri !== null) {
          // Matched by URI, never by name: names are not unique and platforms
          // localise them. A voice that is no longer installed simply leaves
          // this unset, and the platform picks for itself.
          const voice = synth.getVoices().find((entry) => entry.voiceURI === request.voiceUri);
          if (voice !== undefined) utterance.voice = voice;
        }

        // BOTH ENDS ARE HANDLED. A utterance that errors and is never settled
        // wedges the queue permanently, and the symptom is a narrator that
        // stops speaking with nothing in any log.
        utterance.addEventListener('end', () => resolve(), { once: true });
        utterance.addEventListener('error', () => reject(new Error('the utterance failed')), {
          once: true,
        });

        synth.speak(utterance);
      }),
    cancel: () => synth.cancel(),
    available: () => true,
  };
}
