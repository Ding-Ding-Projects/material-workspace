/**
 * The update service, against real release payloads and a real download.
 *
 * The download test writes to a real temporary directory and reads the file
 * back, because a module that half spawns processes and half computes is
 * exactly where tests cluster on the computing half and the file handling
 * never runs. This repository has shipped a whole feature dead behind 474 green
 * tests for precisely that reason.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { checkForUpdate, downloadUpdate, mapRelease } from '../../app/main/updates/update-service';

const PAYLOAD_BYTES = Buffer.from('a pretend installer, but a real file');
const PAYLOAD_HASH = crypto.createHash('sha256').update(PAYLOAD_BYTES).digest('hex');

function releasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.1.0-b42',
    html_url: 'https://github.com/x/y/releases/tag/v0.1.0-b42',
    published_at: '2026-09-07T16:37:21Z',
    body:
      'Some notes.\n\n```\n' +
      PAYLOAD_HASH +
      '  MaterialWorkspaceSetup-0.1.0.exe\n```\n',
    assets: [
      { name: 'RELEASES', browser_download_url: 'https://x/RELEASES', size: 89 },
      {
        name: 'MaterialWorkspaceSetup-0.1.0.exe',
        browser_download_url: 'https://github.com/x/y/releases/download/v1/Setup.exe',
        size: PAYLOAD_BYTES.length,
      },
    ],
    ...overrides,
  };
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-update-'));
after(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

// ------------------------------------------------------------- mapping --

test('a real release shape maps to a usable feed', () => {
  const mapped = mapRelease(releasePayload());
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.equal(mapped.feed['version'], 'v0.1.0-b42');
  assert.equal(mapped.feed['sha256'], PAYLOAD_HASH);
  assert.equal(mapped.feed['bytes'], PAYLOAD_BYTES.length);
});

test('the hash is matched to the ASSET, not taken as the first hex in the notes', () => {
  // A release listing several files would otherwise hand back the wrong hash,
  // and the download would be refused for a reason nobody could work out.
  const other = 'f'.repeat(64);
  const mapped = mapRelease(
    releasePayload({
      body:
        '```\n' + other + '  something-else.zip\n' +
        PAYLOAD_HASH + '  MaterialWorkspaceSetup-0.1.0.exe\n```\n',
    }),
  );
  assert.equal(mapped.ok, true);
  assert.equal(mapped.ok && mapped.feed['sha256'], PAYLOAD_HASH);
});

test('a release with no installer is refused rather than half-mapped', () => {
  const mapped = mapRelease(releasePayload({ assets: [{ name: 'RELEASES', size: 1 }] }));
  assert.equal(mapped.ok, false);
  assert.match(mapped.ok === false ? mapped.reason : '', /no Windows installer/);
});

test('a release that published no hash is refused', () => {
  // Downloading something nobody can check is worse than not offering it.
  const mapped = mapRelease(releasePayload({ body: 'no hash here' }));
  assert.equal(mapped.ok, false);
  assert.match(mapped.ok === false ? mapped.reason : '', /did not publish a hash/);
});

test('anything that is not a release is refused', () => {
  for (const bad of [null, 42, 'text', {}, { tag_name: '' }]) {
    assert.equal(mapRelease(bad).ok, false, JSON.stringify(bad));
  }
});

// -------------------------------------------------------------- checking --

test('a server fault is not reported as being offline', () => {
  // The host ANSWERED. Saying offline would send somebody to check their
  // network over a server fault.
  return checkForUpdate(
    {
      slug: 'x/y',
      fetch: async () => new Response('nope', { status: 503 }),
    },
    '0.1.0',
  ).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.offline, false);
    assert.match(result.ok === false ? result.reason : '', /503/);
  });
});

test('an unreachable host IS reported as offline', async () => {
  const result = await checkForUpdate(
    {
      slug: 'x/y',
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    },
    '0.1.0',
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.offline, true);
});

test('a release that is not newer is refused with the up-to-date reason', async () => {
  const result = await checkForUpdate(
    { slug: 'x/y', fetch: async () => Response.json(releasePayload()) },
    'v0.1.0-b42',
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /already up to date/);
});

test('a newer build ordinal IS offered', async () => {
  // The case that matters for a per-push channel: same version, higher build.
  const result = await checkForUpdate(
    { slug: 'x/y', fetch: async () => Response.json(releasePayload()) },
    'v0.1.0-b41',
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.release.version, 'v0.1.0-b42');
});

// ------------------------------------------------------------ downloading --

const release = {
  version: 'v0.1.0-b42',
  notesUrl: '',
  url: 'https://github.com/x/y/releases/download/v1/Setup.exe',
  sha256: PAYLOAD_HASH,
  bytes: PAYLOAD_BYTES.length,
  publishedAt: '',
};

function serving(bytes: Buffer): typeof globalThis.fetch {
  // COPIED into a fresh array rather than viewed over the Buffer's own memory.
  // A view carries `ArrayBufferLike`, which BodyInit does not accept because a
  // SharedArrayBuffer cannot be a body; copying gives a plain ArrayBuffer and
  // the types line up without an assertion papering over a real mismatch.
  const body = new Uint8Array(bytes);
  return (async () => new Response(body)) as unknown as typeof globalThis.fetch;
}

test('a good download lands, verified, and the file really exists', async () => {
  const seen: number[] = [];
  const result = await downloadUpdate(release, temporary, {
    fetch: serving(PAYLOAD_BYTES),
    onProgress: (fraction) => seen.push(fraction),
  });

  assert.equal(result.ok, true, result.reason);
  assert.ok(result.path !== null);

  // Read back through the filesystem rather than trusting the return value.
  const written = await fs.readFile(result.path as string);
  assert.equal(written.toString(), PAYLOAD_BYTES.toString());
  assert.ok(seen.length > 0, 'no progress was reported');
  assert.ok((seen.at(-1) ?? 0) >= 1, 'progress never reached the end');
});

test('a download whose hash is wrong is DISCARDED, not left staged', async () => {
  // A wrong file sitting in the staging folder is a wrong file somebody
  // eventually runs.
  const wrong = Buffer.from('a completely different installer!!!!');
  const result = await downloadUpdate(
    { ...release, bytes: wrong.length },
    temporary,
    { fetch: serving(wrong) },
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match the hash/);

  const left = await fs.readdir(temporary);
  assert.equal(
    left.filter((name) => name.endsWith('.partial')).length,
    0,
    'a partial file was left behind: ' + left.join(', '),
  );
});

test('a download larger than promised is stopped rather than filling the disk', async () => {
  // A host that keeps sending would otherwise fill the disk before anybody
  // checked the size at the end.
  const huge = Buffer.alloc(PAYLOAD_BYTES.length * 4, 0x61);
  const result = await downloadUpdate(release, temporary, { fetch: serving(huge) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /larger than the release said/);
});

test('a download that answers with an error is reported, not staged', async () => {
  const result = await downloadUpdate(release, temporary, {
    fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof globalThis.fetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /404/);
});

test('a download that throws is reported rather than crashing the check', async () => {
  const result = await downloadUpdate(release, temporary, {
    fetch: (async () => {
      throw new Error('the connection was reset');
    }) as unknown as typeof globalThis.fetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /connection was reset/);
});

test('the staged name carries the version and cannot escape the folder', async () => {
  const result = await downloadUpdate(
    { ...release, version: '../../evil' },
    temporary,
    { fetch: serving(PAYLOAD_BYTES) },
  );
  assert.equal(result.ok, true, result.reason);
  const name = path.basename(result.path as string);
  assert.ok(!name.includes('..'), name);
  assert.ok(!name.includes('/') && !name.includes(String.fromCharCode(92)), name);
  assert.equal(path.dirname(result.path as string), temporary);
});
