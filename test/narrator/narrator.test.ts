/**
 * The narrator.
 *
 * Every test corresponds to a way a spoken narrator is normally got wrong.
 * Most of them are silent in the sense that matters here: nothing errors, the
 * settings look right, and the person simply hears the wrong thing or nothing
 * at all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTOMATIC,
  DEFAULT_PREFERENCE,
  NarratorQueue,
  PITCH_RANGE,
  RATE_RANGE,
  RateLimiter,
  type SpeechPort,
  type VoiceInfo,
  describeStatus,
  isUsablePitch,
  isUsableRate,
  resolveVoice,
  utterancesFor,
  voicesFor,
} from '../../app/renderer/narrator/narrator';

function voice(partial: Partial<VoiceInfo> & { voiceURI: string; lang: string }): VoiceInfo {
  return {
    name: partial.voiceURI,
    localService: true,
    default: false,
    ...partial,
  };
}

const ENGLISH = voice({ voiceURI: 'en-1', name: 'Sonia', lang: 'en-GB', default: true });
const ENGLISH_US = voice({ voiceURI: 'en-2', name: 'Aria', lang: 'en-US' });
const ENGLISH_CLOUD = voice({ voiceURI: 'en-3', name: 'Cloudy', lang: 'en-GB', localService: false });
const CANTONESE = voice({ voiceURI: 'yue-1', name: 'HiuGaai', lang: 'zh-HK' });
const CANTONESE_ALT = voice({ voiceURI: 'yue-2', name: 'WanLung', lang: 'yue-Hant-HK' });
const MANDARIN = voice({ voiceURI: 'cmn-1', name: 'Xiaoxiao', lang: 'zh-CN' });

const ALL = [ENGLISH, ENGLISH_US, ENGLISH_CLOUD, CANTONESE, CANTONESE_ALT, MANDARIN];

// ------------------------------------------------------- language matching --

test('Cantonese matches yue and zh-HK but never Mandarin', () => {
  // Matching only `yue` finds nothing on most machines. Matching all of `zh`
  // picks Mandarin, which is a different language read aloud in a way a
  // Cantonese speaker will not thank anybody for.
  const found = voicesFor(ALL, 'yue').map((entry) => entry.voiceURI);
  assert.deepEqual(found.sort(), ['yue-1', 'yue-2']);
  assert.ok(!found.includes('cmn-1'), 'Mandarin was offered as Cantonese');
});

test('English matches every region without matching everything', () => {
  const found = voicesFor(ALL, 'en').map((entry) => entry.voiceURI);
  assert.deepEqual(found.sort(), ['en-1', 'en-2', 'en-3']);
});

test('a tag with an underscore or odd case still matches', () => {
  // Platforms are inconsistent about this and a picker that misses `EN_GB`
  // reports no English voices on a machine that has one.
  const odd = [voice({ voiceURI: 'x', lang: 'EN_GB' })];
  assert.equal(voicesFor(odd, 'en').length, 1);
});

// ------------------------------------------------------------- resolution --

test('automatic prefers a local voice over a network-backed one', () => {
  // A network voice goes silent offline, and a narrator that stops working on
  // a train is a narrator people switch off.
  const status = resolveVoice([ENGLISH_CLOUD, ENGLISH_US], 'en', DEFAULT_PREFERENCE);
  assert.equal(status.kind, 'automatic');
  assert.equal(status.kind === 'automatic' && status.resolved?.voiceURI, 'en-2');
});

test('automatic falls back to a network voice when it is the only one', () => {
  const status = resolveVoice([ENGLISH_CLOUD], 'en', DEFAULT_PREFERENCE);
  assert.equal(status.kind === 'automatic' && status.resolved?.voiceURI, 'en-3');
  assert.match(describeStatus(status), /go quiet offline/);
});

test('a chosen voice that is not installed keeps the choice and says so', () => {
  // Silently resetting it means somebody who copies their profile to a machine
  // lacking the voice loses the setting permanently rather than temporarily.
  const status = resolveVoice(ALL, 'en', { ...DEFAULT_PREFERENCE, voiceUri: 'en-missing' });
  assert.equal(status.kind, 'missing');
  assert.equal(status.kind === 'missing' && status.voiceUri, 'en-missing');
  assert.equal(status.kind === 'missing' && status.fallback?.voiceURI, 'en-1');
  assert.match(describeStatus(status), /not installed/);
  assert.match(describeStatus(status), /kept/);
});

test('a language with no voice at all is reported rather than left silent', () => {
  const status = resolveVoice([ENGLISH], 'yue', DEFAULT_PREFERENCE);
  assert.equal(status.kind, 'none-for-language');
  assert.match(describeStatus(status), /nothing will be spoken/);
});

test('no speech engine is its own state', () => {
  const status = resolveVoice(ALL, 'en', DEFAULT_PREFERENCE, false);
  assert.equal(status.kind, 'no-speech');
  assert.match(describeStatus(status), /no speech engine/);
});

test('every status says what will happen, in words', () => {
  // Asserted on substance rather than on a length threshold: "Sonia will be
  // used." is a perfectly good description and happens to be twenty
  // characters, so a length check would have failed on correct copy while
  // passing on a longer sentence that said nothing.
  const cases: [string, RegExp][] = [
    [describeStatus(resolveVoice(ALL, 'en', DEFAULT_PREFERENCE)), /will be used/],
    [
      describeStatus(resolveVoice(ALL, 'en', { ...DEFAULT_PREFERENCE, voiceUri: 'en-1' })),
      /Sonia will be used/,
    ],
    [
      describeStatus(resolveVoice(ALL, 'en', { ...DEFAULT_PREFERENCE, voiceUri: 'nope' })),
      /not installed/,
    ],
    [describeStatus(resolveVoice([ENGLISH], 'yue', DEFAULT_PREFERENCE)), /nothing will be spoken/],
    [describeStatus(resolveVoice(ALL, 'en', DEFAULT_PREFERENCE, false)), /no speech engine/],
  ];

  for (const [text, expected] of cases) {
    assert.match(text, expected);
    // A complete sentence, so it can be read aloud by a screen reader without
    // running into whatever follows it.
    assert.ok(text.endsWith('.'), 'not a sentence: ' + text);
  }
});

test('the identity persisted is the URI, never the display name', () => {
  // Names are not unique - one machine can carry several sharing a name from
  // different engines - and platforms localise them, so a profile written on
  // one install silently stops matching on another.
  const twins = [
    voice({ voiceURI: 'engine-a/Sonia', name: 'Sonia', lang: 'en-GB' }),
    voice({ voiceURI: 'engine-b/Sonia', name: 'Sonia', lang: 'en-GB' }),
  ];
  const status = resolveVoice(twins, 'en', { ...DEFAULT_PREFERENCE, voiceUri: 'engine-b/Sonia' });
  assert.equal(status.kind === 'chosen' && status.voice.voiceURI, 'engine-b/Sonia');
});

// ------------------------------------------------------------ rate/pitch --

test('a rate or pitch outside the range is refused rather than clamped', () => {
  // Clamping a hand-edited settings file to the nearest bound hides that the
  // file is wrong, and the next reader cannot tell what was intended.
  assert.equal(isUsableRate(1), true);
  assert.equal(isUsableRate(RATE_RANGE.min), true);
  assert.equal(isUsableRate(RATE_RANGE.max), true);
  for (const bad of [0, 20, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
    assert.equal(isUsableRate(bad), false, 'accepted ' + String(bad));
  }
  assert.equal(isUsablePitch(PITCH_RANGE.min), true);
  assert.equal(isUsablePitch(PITCH_RANGE.max), true);
  assert.equal(isUsablePitch(3), false);
});

// ------------------------------------------------------------ the queue --

class FakePort implements SpeechPort {
  spoken: { text: string; lang: string; voiceUri: string | null }[] = [];
  cancelled = 0;
  private resolvers: (() => void)[] = [];
  /** Set to make the next speak() reject, as a dead engine does. */
  failNext = false;

  speak(request: { text: string; voiceUri: string | null; lang: string }): Promise<void> {
    this.spoken.push({ text: request.text, lang: request.lang, voiceUri: request.voiceUri });
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('the engine died'));
    }
    return new Promise<void>((resolve) => this.resolvers.push(resolve));
  }

  cancel(): void {
    this.cancelled += 1;
    const pending = this.resolvers;
    this.resolvers = [];
    for (const resolve of pending) resolve();
  }

  available(): boolean {
    return true;
  }

  /** Let the current utterance finish. */
  finish(): void {
    const resolve = this.resolvers.shift();
    resolve?.();
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function queueWith(port: FakePort): NarratorQueue {
  return new NarratorQueue(
    port,
    () => DEFAULT_PREFERENCE,
    (lang) => (lang === 'yue' ? 'yue-1' : 'en-1'),
  );
}

test('nothing overlaps: one utterance at a time', async () => {
  // Two announcements talking over each other leaves neither understood.
  const port = new FakePort();
  const queue = queueWith(port);

  queue.enqueue({ text: 'first', lang: 'en', category: 'info' });
  queue.enqueue({ text: 'second', lang: 'en', category: 'info' });
  await settle();

  assert.deepEqual(port.spoken.map((entry) => entry.text), ['first']);
  assert.equal(queue.pending(), 1);

  port.finish();
  await settle();
  assert.deepEqual(port.spoken.map((entry) => entry.text), ['first', 'second']);
});

test('a superseded line is replaced in place rather than stacked', async () => {
  // Six queued progress announcements are five nobody wanted, read out after
  // the thing they described has finished.
  const port = new FakePort();
  const queue = queueWith(port);

  queue.enqueue({ text: 'holding', lang: 'en', category: 'info' });
  await settle();
  queue.enqueue({ text: '10%', lang: 'en', category: 'progress', replaces: 'save' });
  queue.enqueue({ text: '50%', lang: 'en', category: 'progress', replaces: 'save' });
  queue.enqueue({ text: '90%', lang: 'en', category: 'progress', replaces: 'save' });

  assert.equal(queue.pending(), 1, 'progress lines stacked instead of replacing');

  port.finish();
  await settle();
  assert.equal(port.spoken[port.spoken.length - 1]?.text, '90%');
});

test('a replacement keeps its place rather than jumping the queue', async () => {
  const port = new FakePort();
  const queue = queueWith(port);

  queue.enqueue({ text: 'speaking', lang: 'en', category: 'info' });
  await settle();
  queue.enqueue({ text: 'progress 1', lang: 'en', category: 'progress', replaces: 'p' });
  queue.enqueue({ text: 'later', lang: 'en', category: 'info' });
  queue.enqueue({ text: 'progress 2', lang: 'en', category: 'progress', replaces: 'p' });

  port.finish();
  await settle();
  port.finish();
  await settle();

  assert.deepEqual(
    port.spoken.map((entry) => entry.text),
    ['speaking', 'progress 2', 'later'],
  );
});

test('a failed utterance does not wedge the queue', async () => {
  // Somebody who cannot hear one line should still hear the next.
  const port = new FakePort();
  const queue = queueWith(port);

  port.failNext = true;
  queue.enqueue({ text: 'doomed', lang: 'en', category: 'info' });
  queue.enqueue({ text: 'survivor', lang: 'en', category: 'info' });
  await settle();
  await settle();

  assert.deepEqual(port.spoken.map((entry) => entry.text), ['doomed', 'survivor']);
});

test('stopping cancels what is speaking and refuses what comes after', async () => {
  const port = new FakePort();
  const queue = queueWith(port);

  queue.enqueue({ text: 'talking', lang: 'en', category: 'info' });
  await settle();
  queue.stop();
  queue.enqueue({ text: 'ignored', lang: 'en', category: 'info' });
  await settle();

  assert.equal(port.cancelled, 1);
  assert.deepEqual(port.spoken.map((entry) => entry.text), ['talking']);
});

test('each language is spoken by its own voice', async () => {
  const port = new FakePort();
  const queue = queueWith(port);

  queue.enqueue({ text: 'hello', lang: 'en', category: 'info' });
  await settle();
  port.finish();
  queue.enqueue({ text: '你好', lang: 'yue', category: 'info' });
  await settle();

  assert.deepEqual(
    port.spoken.map((entry) => [entry.lang, entry.voiceUri]),
    [
      ['en-GB', 'en-1'],
      ['zh-HK', 'yue-1'],
    ],
  );
});

// ------------------------------------------------------- language modes --

test('both speaks English then Cantonese, as two utterances', () => {
  // One concatenated string would be read by a single voice, so half of it
  // would come out in the wrong accent.
  const lines = utterancesFor('both', { en: 'Saved', yue: '已儲存' }, 'success');
  assert.deepEqual(
    lines.map((line) => [line.lang, line.text]),
    [
      ['en', 'Saved'],
      ['yue', '已儲存'],
    ],
  );
});

test('each half of a bilingual line replaces its own previous half', () => {
  // Sharing one key would make the Cantonese half replace the English one, so
  // only the second language would ever be heard.
  const lines = utterancesFor('both', { en: 'a', yue: 'b' }, 'progress', 'save');
  assert.equal(lines[0]?.replaces, 'save:en');
  assert.equal(lines[1]?.replaces, 'save:yue');
  assert.notEqual(lines[0]?.replaces, lines[1]?.replaces);
});

test('a single-language mode speaks only that language', () => {
  assert.equal(utterancesFor('en', { en: 'a', yue: 'b' }, 'info').length, 1);
  assert.equal(utterancesFor('yue', { en: 'a', yue: 'b' }, 'info')[0]?.lang, 'yue');
});

// -------------------------------------------------------- rate limiting --

test('ordinary categories are rate limited', () => {
  const limiter = new RateLimiter(1000);
  assert.equal(limiter.allows('info', 0), true);
  limiter.record('info', 0);
  assert.equal(limiter.allows('info', 500), false);
  assert.equal(limiter.allows('info', 1000), true);
});

test('errors and warnings are never rate limited', () => {
  // An error swallowed because a similar one was spoken recently is exactly
  // the announcement somebody needed.
  const limiter = new RateLimiter(10_000);
  limiter.record('error', 0);
  limiter.record('warning', 0);
  assert.equal(limiter.allows('error', 1), true);
  assert.equal(limiter.allows('warning', 1), true);
});

test('categories are limited independently of one another', () => {
  const limiter = new RateLimiter(1000);
  limiter.record('progress', 0);
  assert.equal(limiter.allows('progress', 100), false);
  assert.equal(limiter.allows('navigation', 100), true);
});

// --------------------------------------------------------------- default --

test('the shipped default is automatic and neutral', () => {
  // Off by default is enforced by the settings model; what is asserted here is
  // that nothing has quietly picked a named voice a machine may not have.
  assert.equal(DEFAULT_PREFERENCE.voiceUri, AUTOMATIC);
  assert.equal(DEFAULT_PREFERENCE.rate, 1);
  assert.equal(DEFAULT_PREFERENCE.pitch, 1);
});
