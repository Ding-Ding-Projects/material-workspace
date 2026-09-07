/**
 * Automatic updates.
 *
 * The feed is untrusted input from the network, so most of these are refusals.
 * A malformed feed that is half-accepted produces a download from a URL nobody
 * validated, which is the worst possible outcome of an update check.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Release,
  type State,
  compareVersions,
  describe as describeState,
  initial,
  isNewer,
  nextCheckDelay,
  packageMatches,
  readFeed,
} from '../../app/shared/updates';

const HASH = 'a'.repeat(64);

const FEED = {
  version: '0.2.0',
  notesUrl: 'https://github.com/x/y/releases/tag/v0.2.0',
  url: 'https://github.com/x/y/releases/download/v0.2.0/Setup.exe',
  sha256: HASH,
  bytes: 1234,
  publishedAt: '2026-09-07T00:00:00Z',
};

// -------------------------------------------------------------- versions --

test('versions compare numerically, not as strings', () => {
  // THE ONE THAT BITES. As strings "0.10.0" sorts BEFORE "0.9.0", so a
  // lexicographic compare stops offering updates the moment a minor version
  // reaches ten - and does it silently, for ever.
  assert.equal(isNewer('0.10.0', '0.9.0'), true, 'ten was treated as less than nine');
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.9.0', '0.10.0'), false);
});

test('equal versions are not newer, and a v prefix is ignored', () => {
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('a missing part counts as zero rather than as unknown', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(isNewer('1.2.1', '1.2'), true);
});

test('a build ordinal is compared, so a per-push channel actually updates', () => {
  // This Oak Kay tags every push as v0.1.0-bNN while the package version stays
  // 0.1.0 across all of them. Dropping the suffix makes forty-two consecutive
  // releases compare EQUAL, so the updater never offers any of them and never
  // says why.
  assert.equal(isNewer('v0.1.0-b42', 'v0.1.0-b41'), true);
  assert.equal(isNewer('v0.1.0-b41', 'v0.1.0-b42'), false);
  assert.equal(isNewer('v0.1.0-b2', '0.1.0'), true);
  assert.equal(isNewer('v0.1.0-b10', 'v0.1.0-b9'), true, 'ordinals compared as text');
});

test('a suffix that is not a build ordinal does not outrank a release', () => {
  // `1.0.0-rc1` is not newer than `1.0.0`, and coercing an unknown suffix to a
  // number would make it so.
  assert.equal(isNewer('1.0.0-rc1', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0-rc1'), false);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), 0);
});

// ------------------------------------------------------------- the feed --

test('a good feed is read', () => {
  const result = readFeed(FEED, '0.1.0');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.release.version, '0.2.0');
});

test('a feed offering the current version or older is "already up to date"', () => {
  // Not an error. The commonest outcome of a check is that there is nothing to
  // do, and reporting that as a failure would train people to ignore it.
  const same = readFeed(FEED, '0.2.0');
  assert.equal(same.ok, false);
  assert.match(same.ok === false ? same.reason : '', /already up to date/);
  assert.equal(readFeed({ ...FEED, version: '0.0.1' }, '0.1.0').ok, false);
});

test('a package not offered over https is refused', () => {
  // An update fetched over plain HTTP can be replaced in transit by anybody on
  // the path, and a hash from the same channel proves nothing because they can
  // rewrite that too.
  for (const url of [
    'http://github.com/x/y/Setup.exe',
    'ftp://example.invalid/Setup.exe',
    'file:///C:/Setup.exe',
  ]) {
    const result = readFeed({ ...FEED, url }, '0.1.0');
    assert.equal(result.ok, false, 'accepted ' + url);
  }
});

test('a package address carrying credentials is refused', () => {
  const result = readFeed({ ...FEED, url: 'https://user:token@github.com/x/y/Setup.exe' }, '0.1.0');
  assert.equal(result.ok, false);
});

test('a feed with no usable hash or size is refused', () => {
  for (const bad of [
    { sha256: 'not a hash' },
    { sha256: 'abc' },
    { sha256: HASH.toUpperCase() + 'x' },
    { bytes: 0 },
    { bytes: -1 },
    { bytes: 'lots' },
  ]) {
    assert.equal(readFeed({ ...FEED, ...bad }, '0.1.0').ok, false, JSON.stringify(bad));
  }
});

test('anything that is not a feed at all is refused', () => {
  for (const bad of [null, undefined, 42, 'a string', [], {}]) {
    assert.equal(readFeed(bad, '0.1.0').ok, false, JSON.stringify(bad));
  }
});

test('a missing notes link is tolerated rather than refused', () => {
  // Release notes are useful and not load-bearing. Refusing an update because
  // nobody wrote notes would withhold a fix over a formality.
  const result = readFeed({ ...FEED, notesUrl: undefined }, '0.1.0');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.release.notesUrl, '');
});

// -------------------------------------------------------- the download --

test('a package whose bytes differ is refused before it is installed', () => {
  const result = packageMatches(HASH, HASH, 1234, 1200);
  assert.equal(result.ok, false);
  assert.match(result.reason, /1200/);
});

test('a package whose hash differs is refused, and the message is honest', () => {
  const result = packageMatches(HASH, 'b'.repeat(64), 1234, 1234);
  assert.equal(result.ok, false);
  assert.match(result.reason, /has not been installed/);
});

test('the hash comparison ignores case', () => {
  // Tools disagree about case, and rejecting a perfectly good download over it
  // is worse than it sounds: the only remedy a person has is to try again and
  // get the same answer.
  assert.equal(packageMatches(HASH.toUpperCase(), HASH, 10, 10).ok, true);
  assert.equal(packageMatches(HASH, HASH.toUpperCase(), 10, 10).ok, true);
});

// ------------------------------------------------------------ scheduling --

test('checks are jittered, so installations do not stampede together', () => {
  // Every installation checking on the hour is a self-inflicted stampede on
  // the release host, and nobody notices until there are enough of them.
  const early = nextCheckDelay(0, 0);
  const late = nextCheckDelay(0, 1);
  assert.notEqual(early, late, 'the delay is not jittered');
  assert.ok(early > 0 && late > early);
});

test('a failure backs off, and the backoff is capped', () => {
  const first = nextCheckDelay(1, 0.5);
  const later = nextCheckDelay(3, 0.5);
  assert.ok(later > first, 'it did not back off');
  assert.equal(nextCheckDelay(99, 0.5), nextCheckDelay(4, 0.5), 'the cap was not applied');
});

// ------------------------------------------------------------- the words --

test('every stage has a sentence, including the boring ones', () => {
  // A surface that shows nothing while checking is a surface where "Check for
  // updates" appears to do nothing at all.
  const release: Release = { ...FEED };
  const stages: State[] = [
    initial('0.1.0'),
    { ...initial('0.1.0'), stage: 'checking' },
    { ...initial('0.1.0'), stage: 'none' },
    { ...initial('0.1.0'), stage: 'available', release },
    { ...initial('0.1.0'), stage: 'downloading', release, progress: 0.42 },
    { ...initial('0.1.0'), stage: 'ready', release },
    { ...initial('0.1.0'), stage: 'offline', detail: 'the network refused' },
    { ...initial('0.1.0'), stage: 'failed', detail: 'the package was corrupt' },
  ];

  for (const state of stages) {
    const words = describeState(state);
    assert.ok(words.title.length > 0, state.stage + ' has no title');
    assert.ok(words.body.length > 10, state.stage + ' has no body: ' + words.body);
  }
});

test('only the ready state offers a restart', () => {
  // Offering it earlier would restart into the version already installed.
  const release: Release = { ...FEED };
  assert.equal(describeState({ ...initial('0.1.0'), stage: 'ready', release }).canRestart, true);
  for (const stage of ['idle', 'checking', 'none', 'available', 'downloading', 'offline', 'failed'] as const) {
    assert.equal(
      describeState({ ...initial('0.1.0'), stage, release }).canRestart,
      false,
      stage + ' offered a restart',
    );
  }
});

test('the ready banner states that the installer is unsigned', () => {
  // Code signing is prohibited here, so the operating system WILL warn about
  // an unknown publisher. Saying so beforehand is the difference between an
  // expected warning and one that looks like the download was tampered with.
  const words = describeState({ ...initial('0.1.0'), stage: 'ready', release: { ...FEED } });
  assert.match(words.body, /UNSIGNED/);
  assert.match(words.body, /unknown publisher/);
});

test('a failure says why rather than showing a spinner', () => {
  const words = describeState({ ...initial('0.1.0'), stage: 'failed', detail: 'the disk was full' });
  assert.match(words.body, /the disk was full/);
  // And an absent reason is admitted rather than invented.
  assert.match(
    describeState({ ...initial('0.1.0'), stage: 'failed' }).body,
    /No reason was given/,
  );
});

test('progress is reported as a real number or not at all', () => {
  const release: Release = { ...FEED };
  const known = describeState({ ...initial('0.1.0'), stage: 'downloading', release, progress: 0.5 });
  assert.match(known.body, /50%/);

  // Never a fabricated percentage. A progress bar that moves without knowing
  // anything is worse than none, because it implies a measurement.
  const unknown = describeState({ ...initial('0.1.0'), stage: 'downloading', release });
  assert.ok(!/%/.test(unknown.body), unknown.body);
});
