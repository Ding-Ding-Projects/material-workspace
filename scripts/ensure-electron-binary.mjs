#!/usr/bin/env node
/**
 * scripts/ensure-electron-binary.mjs
 *
 * Guarantee that node_modules/electron/dist/<executable> actually exists.
 *
 * Why this exists, stated plainly so nobody deletes it as redundant:
 *
 * npm's install-script gate, plus a Node runtime that exits before asynchronous
 * work settles, can leave the declared electron package installed with an EMPTY
 * dist directory. Electron's own install.js is not a recovery route in that
 * state: it prints a cache hit, exits 0 in well under a second, extracts
 * nothing, and prints no error at all. Re-running it changes nothing. So the
 * only honest test is whether the executable exists AFTERWARDS, never whether
 * the installer reported success.
 *
 * The recovery below is synchronous and adds no dependency. It finds the
 * already-downloaded release archive in the @electron/get cache, verifies its
 * SHA-256 against the checksums the electron package itself ships, extracts it,
 * and writes the path.txt that the electron package resolver reads.
 *
 * Exit codes: 0 the binary is present, 1 it could not be produced (with the
 * exact reason named).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');

const PLATFORM_EXECUTABLE = {
  win32: 'electron.exe',
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
};

function log(message) {
  process.stdout.write('[ensure-electron] ' + message + '\n');
}

function fail(message) {
  process.stderr.write('[ensure-electron] FAILED: ' + message + '\n');
  process.exit(1);
}

function executableRelativePath() {
  const relative = PLATFORM_EXECUTABLE[process.platform];
  if (!relative) fail('unsupported platform ' + process.platform);
  return relative;
}

function binaryPresent() {
  const candidate = path.join(DIST_DIR, executableRelativePath());
  try {
    return fs.statSync(candidate).size > 0;
  } catch {
    return false;
  }
}

function readInstalledVersion() {
  const versionFile = path.join(ELECTRON_DIR, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(versionFile, 'utf8');
  } catch {
    fail(
      'the electron package is not installed at all. Run the dependency ' +
        'bootstrap (download-dependencies.bat) before this script.',
    );
  }
  const parsed = JSON.parse(raw);
  if (!parsed.version) fail('node_modules/electron/package.json declares no version');
  return parsed.version;
}

function archiveName(version) {
  const arch =
    process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64';
  return 'electron-v' + version + '-' + process.platform + '-' + arch + '.zip';
}

function cacheRoots() {
  const roots = [];
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache);
  if (process.env.ELECTRON_CACHE) roots.push(process.env.ELECTRON_CACHE);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) roots.push(path.join(local, 'electron', 'Cache'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'));
  } else {
    roots.push(path.join(os.homedir(), '.cache', 'electron'));
  }
  return roots.filter(Boolean);
}

/** Find the release archive anywhere under the @electron/get cache. */
function findCachedArchive(version) {
  const wanted = archiveName(version);
  for (const root of cacheRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, wanted);
      try {
        if (fs.statSync(candidate).size > 0) return candidate;
      } catch {
        /* keep looking */
      }
    }
    const direct = path.join(root, wanted);
    try {
      if (fs.statSync(direct).size > 0) return direct;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Verify the archive against the checksums the electron package ships.
 * A missing checksums file is reported, never silently treated as a pass.
 */
function verifyArchive(archivePath, version) {
  const checksumFile = path.join(ELECTRON_DIR, 'checksums.json');
  let table;
  try {
    table = JSON.parse(fs.readFileSync(checksumFile, 'utf8'));
  } catch {
    log('no checksums.json shipped with the electron package; skipping digest check');
    return;
  }
  const name = archiveName(version);
  const expected = table[name];
  if (!expected) {
    log('checksums.json carries no entry for ' + name + '; skipping digest check');
    return;
  }
  const actual = sha256(archivePath);
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    fail(
      'cached archive digest mismatch for ' +
        name +
        '\n  expected ' +
        expected +
        '\n  actual   ' +
        actual +
        '\n  Delete the cached archive and let the bootstrap fetch it again.',
    );
  }
  log('archive digest verified (' + name + ')');
}

/**
 * Download the release archive from the canonical upstream.
 *
 * This is the path a genuinely fresh machine takes, and it is not optional: a
 * cold CI runner and a new laptop both have an empty cache, so a recovery that
 * can only read the cache fails in exactly the situation it was written for. The
 * first CI run of this project proved that by failing here.
 *
 * The download goes into the same cache layout @electron/get uses, so a later
 * ordinary install finds it rather than fetching 100+ MB again.
 */
async function download(version, destination) {
  const name = archiveName(version);
  const url =
    'https://github.com/electron/electron/releases/download/v' + version + '/' + name;

  log('downloading ' + name + ' from the canonical upstream');
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60 * 1000),
    headers: { 'user-agent': 'material-workspace-bootstrap' },
  });
  if (!response.ok) {
    fail('downloading ' + url + ' returned HTTP ' + response.status + ' ' + response.statusText);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) fail('the download was empty');

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  log('downloaded ' + bytes.byteLength.toLocaleString('en-GB') + ' bytes');
  return destination;
}

/** Where a downloaded archive is placed so @electron/get can reuse it. */
function cacheDestinationFor(version) {
  const roots = cacheRoots();
  const root = roots[0] ?? path.join(ROOT, '.electron-cache');
  return path.join(root, 'material-workspace-bootstrap', archiveName(version));
}

function extract(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    const command =
      'Expand-Archive -LiteralPath ' +
      JSON.stringify(archivePath) +
      ' -DestinationPath ' +
      JSON.stringify(destination) +
      ' -Force';
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) fail('Expand-Archive exited ' + result.status);
    return;
  }
  const result = spawnSync('unzip', ['-o', '-q', archivePath, '-d', destination], {
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('unzip exited ' + result.status);
}

async function main() {
  if (binaryPresent()) {
    log('electron binary already present');
    return;
  }

  const version = readInstalledVersion();
  log('electron ' + version + ' is installed but its binary is missing; recovering');

  // Cache first, because it costs one directory read and saves a 100+ MB
  // transfer on any machine that has installed this version before.
  let archivePath = findCachedArchive(version);
  if (archivePath) {
    log('found cached archive at ' + archivePath);
  } else {
    log(
      'no cached archive under ' +
        cacheRoots().join(', ') +
        '; fetching it from the canonical upstream',
    );
    archivePath = await download(version, cacheDestinationFor(version));
  }

  // Verified either way. A cached archive can be truncated or stale, and a
  // downloaded one has crossed a network — neither is trusted on faith.
  verifyArchive(archivePath, version);
  extract(archivePath, DIST_DIR);

  fs.writeFileSync(
    path.join(ELECTRON_DIR, 'path.txt'),
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : executableRelativePath(),
    'utf8',
  );

  if (!binaryPresent()) {
    fail(
      'extraction completed but the executable is still missing. The archive may ' +
        'be truncated; delete it and re-run the dependency bootstrap.',
    );
  }
  log('electron binary recovered');
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
