/**
 * The real update service.
 *
 * Reads this Oak Kay's own releases, downloads the installer, verifies it
 * against the hash the release published, and stages it for the next restart.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: install anything on its own, run the
 * installer without being asked, or restart the application. The staged file
 * sits in the data folder until somebody presses the button, because an
 * application that installs itself has decided its convenience outranks
 * whatever the person had open.
 *
 * The installer is UNSIGNED, permanently. The hash proves the bytes are the
 * bytes the release named; it proves nothing about who wrote them, and the
 * surface says so.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type Release, readFeed } from '../../shared/updates.js';

export interface FeedSource {
  /** Where the releases live, as `owner/repo`. */
  readonly slug: string;
  /** Injected so the service can be exercised without the network. */
  readonly fetch?: typeof globalThis.fetch;
}

export type CheckResult =
  | { readonly ok: true; readonly release: Release }
  | { readonly ok: false; readonly reason: string; readonly offline: boolean };

/**
 * Read the newest release and turn it into a feed.
 *
 * GitHub's API is not an update feed, so this maps it into one rather than
 * teaching the rest of the application about releases. Everything it produces
 * still goes through `readFeed`, which is the only place a feed is trusted.
 */
export async function checkForUpdate(
  source: FeedSource,
  currentVersion: string,
): Promise<CheckResult> {
  const get = source.fetch ?? globalThis.fetch;
  const url = 'https://api.github.com/repos/' + source.slug + '/releases/latest';

  let payload: unknown;
  try {
    const response = await get(url, {
      headers: {
        accept: 'application/vnd.github+json',
        // Named honestly. A request that pretends to be a browser is a request
        // whose owner cannot be identified when it misbehaves.
        'user-agent': 'material-workspace-updater',
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'the release host answered ' + response.status,
        // A 4xx or 5xx is not "offline" - the host answered. Saying offline
        // would send somebody to check their network over a server fault.
        offline: false,
      };
    }
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason: (error as Error).message ?? 'the release host could not be reached',
      offline: true,
    };
  }

  const mapped = mapRelease(payload);
  if (!mapped.ok) return { ok: false, reason: mapped.reason, offline: false };

  const feed = readFeed(mapped.feed, currentVersion);
  if (!feed.ok) return { ok: false, reason: feed.reason, offline: false };
  return { ok: true, release: feed.release };
}

type Mapped =
  | { readonly ok: true; readonly feed: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Turn a GitHub release into the feed shape.
 *
 * The hash comes from the release NOTES, because the API does not publish one
 * and the workflow writes it there deliberately. Reading it from the same
 * response as the download link is worth stating plainly: it means the hash
 * protects against a corrupted or truncated download, not against a release
 * host that has been taken over. Claiming otherwise would be the dishonest
 * part.
 */
export function mapRelease(payload: unknown): Mapped {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'the release host sent something unreadable' };
  }

  const release = payload as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    body?: unknown;
    assets?: unknown;
  };

  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (tag === '') return { ok: false, reason: 'the newest release has no tag' };

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const setup = assets.find(
    (asset: unknown) =>
      typeof (asset as { name?: unknown })?.name === 'string' &&
      /Setup.*\.exe$/i.test((asset as { name: string }).name),
  ) as { name?: string; browser_download_url?: unknown; size?: unknown } | undefined;

  if (setup === undefined) {
    return { ok: false, reason: 'the newest release has no Windows installer' };
  }

  const body = typeof release.body === 'string' ? release.body : '';
  // The hash for THIS asset, matched by name rather than taking the first
  // 64-character hex in the notes - a release listing several files would
  // otherwise hand back the wrong one, and the download would be refused for
  // a reason nobody could work out.
  const named = new RegExp('([0-9a-f]{64})\\s+' + escapeForRegExp(setup.name ?? ''), 'i').exec(body);
  const digest = named?.[1] ?? null;

  if (digest === null) {
    return {
      ok: false,
      reason: 'the release did not publish a hash for ' + (setup.name ?? 'the installer'),
    };
  }

  return {
    ok: true,
    feed: {
      version: tag,
      notesUrl: typeof release.html_url === 'string' ? release.html_url : '',
      url: setup.browser_download_url,
      sha256: digest.toLowerCase(),
      bytes: setup.size,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    },
  };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface DownloadResult {
  readonly ok: boolean;
  readonly path: string | null;
  readonly reason: string;
}

/**
 * Download a release and verify it before it is staged.
 *
 * Written to a TEMPORARY name and renamed into place only once the hash and
 * the size both match, so a half-finished or wrong download can never be
 * mistaken for a staged update. A partial file with the right name is exactly
 * what an interrupted download leaves behind.
 */
export async function downloadUpdate(
  release: Release,
  intoDirectory: string,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly onProgress?: (fraction: number) => void;
  } = {},
): Promise<DownloadResult> {
  const get = options.fetch ?? globalThis.fetch;
  await fs.promises.mkdir(intoDirectory, { recursive: true });

  const finalPath = path.join(intoDirectory, 'update-' + safeTag(release.version) + '.exe');
  const temporary = finalPath + '.partial';

  let response: Response;
  try {
    response = await get(release.url);
  } catch (error) {
    return { ok: false, path: null, reason: (error as Error).message ?? 'the download failed' };
  }
  if (!response.ok || response.body === null) {
    return { ok: false, path: null, reason: 'the download answered ' + response.status };
  }

  const hash = crypto.createHash('sha256');
  let received = 0;
  const handle = await fs.promises.open(temporary, 'w');

  try {
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value;
      // Bounded as it goes rather than at the end: a host that keeps sending
      // would otherwise fill the disk before anybody checked the size.
      received += bytes.length;
      if (received > release.bytes) {
        return {
          ok: false,
          path: null,
          reason: 'the download is larger than the release said it would be',
        };
      }
      hash.update(bytes);
      await handle.write(bytes);
      options.onProgress?.(received / release.bytes);
    }
  } catch (error) {
    return { ok: false, path: null, reason: (error as Error).message ?? 'the download broke off' };
  } finally {
    await handle.close();
  }

  const digest = hash.digest('hex');
  if (received !== release.bytes || digest !== release.sha256.toLowerCase()) {
    // The partial file is REMOVED rather than left. A wrong file sitting in the
    // staging folder is a wrong file somebody eventually runs.
    await fs.promises.rm(temporary, { force: true });
    return {
      ok: false,
      path: null,
      reason:
        received !== release.bytes
          ? 'the download is ' + received + ' bytes and the release said ' + release.bytes
          : 'the download does not match the hash the release published; it was discarded',
    };
  }

  await fs.promises.rename(temporary, finalPath);
  return { ok: true, path: finalPath, reason: '' };
}

function safeTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.+/g, '.');
}
