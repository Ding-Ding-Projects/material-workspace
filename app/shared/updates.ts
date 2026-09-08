/**
 * Automatic updates.
 *
 * Chrome-style: check quietly, download quietly, and then say so with a
 * persistent non-blocking banner that the person dismisses or acts on when
 * they choose. Never a modal, never a restart nobody asked for.
 *
 * THE INSTALLER IS UNSIGNED, PERMANENTLY, and every surface says so. Code
 * signing is prohibited here, so the update feed is verified by transport and
 * by package hash rather than by a signature - and describing that as
 * "verified" without qualification would be a claim this cannot support. What
 * the hash proves is that the bytes are the bytes the feed named. It proves
 * nothing about who wrote them.
 */

export type Stage =
  | 'idle'
  | 'checking'
  | 'none'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'offline'
  | 'failed';

export interface Release {
  readonly version: string;
  /** Where the notes live. Shown as a link, never fetched to summarise. */
  readonly notesUrl: string;
  readonly url: string;
  /** Lowercase hex SHA-256 of the package the feed names. */
  readonly sha256: string;
  readonly bytes: number;
  readonly publishedAt: string;
}

export interface State {
  readonly stage: Stage;
  readonly current: string;
  readonly release: Release | null;
  /** 0 to 1 while downloading, null otherwise. Never faked. */
  readonly progress: number | null;
  /** Why it failed or why there is nothing, in words. */
  readonly detail: string;
}

export function initial(current: string): State {
  return { stage: 'idle', current, release: null, progress: null, detail: '' };
}

// ------------------------------------------------------------- versions --

/**
 * Compare two dotted versions.
 *
 * Numeric per part, never lexicographic: as strings "0.10.0" sorts BEFORE
 * "0.9.0", so a lexicographic compare stops offering updates the moment a
 * minor version reaches ten, and does it silently.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const one = left[index] ?? 0;
    const two = right[index] ?? 0;
    if (one !== two) return one < two ? -1 : 1;
  }
  return 0;
}

/**
 * Split a version into comparable numbers, BUILD ORDINAL INCLUDED.
 *
 * This repository tags every push as `v0.1.0-b42` while the package version stays
 * `0.1.0` across all of them, which is normal for a per-push release channel.
 * Dropping the `-b42` would make forty-two consecutive releases compare EQUAL,
 * so the updater would never offer any of them and would never say why.
 *
 * A suffix that is not a build ordinal contributes nothing rather than being
 * coerced to zero and outranking a real one. `1.0.0-rc1` is not newer than
 * `1.0.0` and must not be treated as though it were.
 */
export function parseVersion(value: string): number[] {
  const text = value.trim().replace(/^v/, '');
  const [core, ...rest] = text.split('-');

  const parts = (core ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

  // Only a `bNN` suffix counts, and only as a fourth component.
  const build = /^b(\d+)$/.exec(rest.join('-') ?? '');
  parts.push(build === null ? 0 : Number.parseInt(build[1] as string, 10));

  return parts;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------------------------------------------------------------- feeds --

export type FeedResult =
  | { readonly ok: true; readonly release: Release }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a feed reply before anything acts on it.
 *
 * Untrusted input from the network, so every field is checked rather than
 * assumed. A malformed feed that is half-accepted produces a download from a
 * URL nobody validated, which is the worst possible outcome of an update
 * check.
 */
export function readFeed(raw: unknown, current: string): FeedResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'the update feed was not readable' };
  }

  const feed = raw as Partial<Release>;
  const version = feed.version;
  if (typeof version !== 'string' || !/^v?\d+(\.\d+)*/.test(version)) {
    return { ok: false, reason: 'the feed named no usable version' };
  }

  if (!isNewer(version, current)) {
    // Not an error. The commonest outcome of a check is that there is nothing
    // to do, and reporting that as a failure would train people to ignore it.
    return { ok: false, reason: 'already up to date' };
  }

  if (typeof feed.url !== 'string') return { ok: false, reason: 'the feed named no package' };

  let url: URL;
  try {
    url = new URL(feed.url);
  } catch {
    return { ok: false, reason: 'the package address was not a link' };
  }
  // HTTPS only. An update fetched over plain HTTP can be replaced in transit
  // by anybody on the path, and a hash from the same channel proves nothing
  // because they can rewrite that too.
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'the package was not offered over https' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the package address carried credentials' };
  }

  if (typeof feed.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(feed.sha256)) {
    return { ok: false, reason: 'the feed named no usable package hash' };
  }
  if (typeof feed.bytes !== 'number' || !Number.isFinite(feed.bytes) || feed.bytes <= 0) {
    return { ok: false, reason: 'the feed named no usable package size' };
  }

  const notesUrl = typeof feed.notesUrl === 'string' ? feed.notesUrl : '';

  return {
    ok: true,
    release: {
      version,
      notesUrl,
      url: url.toString(),
      sha256: feed.sha256,
      bytes: feed.bytes,
      publishedAt: typeof feed.publishedAt === 'string' ? feed.publishedAt : '',
    },
  };
}

/**
 * Whether a downloaded package is the one the feed named.
 *
 * Compared case-insensitively on the hex, because tools disagree about case
 * and a mismatch there would reject a perfectly good download - which is worse
 * than it sounds, since the only remedy a person has is to try again and get
 * the same answer.
 */
export function packageMatches(
  expected: string,
  actualSha256: string,
  expectedBytes: number,
  actualBytes: number,
): { ok: boolean; reason: string } {
  if (actualBytes !== expectedBytes) {
    return {
      ok: false,
      reason:
        'The download is ' + actualBytes + ' bytes and the feed said ' + expectedBytes + '.',
    };
  }
  if (expected.toLowerCase() !== actualSha256.toLowerCase()) {
    return {
      ok: false,
      // Says what it proves and what it does not, because "verified" alone
      // would imply a signature this deliberately does not have.
      reason:
        'The download does not match the hash the feed named. It has not been installed.',
    };
  }
  return { ok: true, reason: '' };
}

// ----------------------------------------------------------- scheduling --

/**
 * When to check next.
 *
 * Bounded and jittered. Every installation checking on the hour is a
 * self-inflicted stampede on the release host, and it is the sort of thing
 * nobody notices until there are enough installations to matter.
 */
export function nextCheckDelay(
  attempt: number,
  random: number,
  options: { readonly base?: number; readonly cap?: number } = {},
): number {
  const base = options.base ?? 6 * 60 * 60 * 1000;
  const cap = options.cap ?? 24 * 60 * 60 * 1000;

  if (attempt <= 0) return Math.round(base * (0.75 + random * 0.5));

  // After a failure it backs off rather than hammering. An unreachable feed is
  // usually unreachable for a while.
  const backoff = Math.min(cap, base * 2 ** Math.min(attempt, 4));
  return Math.round(backoff * (0.75 + random * 0.5));
}

// ------------------------------------------------------------- the words --

/**
 * What the banner says.
 *
 * Every stage has a sentence, including the boring ones. A surface that shows
 * nothing while checking is a surface where "Check for updates" appears to do
 * nothing at all.
 */
export function describe(state: State): { title: string; body: string; canRestart: boolean } {
  switch (state.stage) {
    case 'idle':
      return {
        title: 'Up to date as far as it knows',
        body: 'Version ' + state.current + '. Nothing has been checked yet this session.',
        canRestart: false,
      };
    case 'checking':
      return {
        title: 'Checking for an update',
        body: 'Version ' + state.current + '. This carries on in the background.',
        canRestart: false,
      };
    case 'none':
      return {
        title: 'No update available',
        body: 'Version ' + state.current + ' is the newest there is.',
        canRestart: false,
      };
    case 'available':
      return {
        title: 'Version ' + (state.release?.version ?? '') + ' is available',
        body: 'It has not been downloaded yet. Nothing will change until you say so.',
        canRestart: false,
      };
    case 'downloading':
      return {
        title: 'Downloading version ' + (state.release?.version ?? ''),
        body:
          state.progress === null
            ? 'In progress. You can carry on working.'
            : Math.round(state.progress * 100) + '% of ' + (state.release?.bytes ?? 0) +
              ' bytes. You can carry on working.',
        canRestart: false,
      };
    case 'ready':
      return {
        title: 'Version ' + (state.release?.version ?? '') + ' is ready',
        body:
          'It will be installed when you restart. The installer is UNSIGNED, so ' +
          'the operating system may warn about an unknown publisher - that warning is ' +
          'expected and this cannot make it go away.',
        canRestart: true,
      };
    case 'offline':
      return {
        title: 'Could not reach the update feed',
        body: state.detail === '' ? 'It will try again later.' : state.detail,
        canRestart: false,
      };
    case 'failed':
      return {
        title: 'The update did not install',
        // Never a spinner that hides it, and never a guessed success.
        body: state.detail === '' ? 'No reason was given.' : state.detail,
        canRestart: false,
      };
  }
}
