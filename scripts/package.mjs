#!/usr/bin/env node
/**
 * Produce the unsigned Squirrel.Windows installer, then VERIFY what was
 * produced.
 *
 * The verification half is the point. A green packaging log proves a builder
 * exited zero; it does not prove an installer exists, that it came from this
 * build, or that it is unsigned. Every claim this script makes at the end is
 * read back off disk.
 *
 * It never publishes, tags, or creates a release.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RELEASE_DIR = path.join(ROOT, 'release');

function log(message) {
  process.stdout.write('[package] ' + message + '\n');
}

function fail(message) {
  process.stderr.write('[package] FAILED: ' + message + '\n');
  process.exit(1);
}

/**
 * Run a command.
 *
 * `shell` is opt-in per call, never blanket-enabled on Windows. With a shell,
 * an executable path containing a space — such as the default Node install
 * under Program Files — is split at the space and the run dies reporting that
 * `C:Program` is not a command. Only the npm-shipped shims genuinely need a
 * shell to resolve.
 */
function run(command, args, options = {}) {
  const { shell = false, ...rest } = options;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell,
    ...rest,
  });
  if (result.status !== 0) fail(command + ' exited ' + result.status);
}

/**
 * Clear every signing input before invoking the builder.
 *
 * Not belt-and-braces: electron-builder discovers certificates from the
 * environment and from the certificate store, so an unrelated variable left over
 * from another project on the same machine is enough to make it try to sign.
 */
function clearSigningInputs() {
  const inputs = [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'CSC_IDENTITY_AUTO_DISCOVERY',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
  ];
  for (const name of inputs) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  log('signing inputs cleared; this build cannot invoke a signer');
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Read the Authenticode state of a produced executable.
 *
 * Returns 'NotSigned' when Windows reports no signature, which is the state this
 * project REQUIRES. A signed artifact is a release blocker here, not a bonus.
 * On a non-Windows host the check is unavailable and says so rather than
 * pretending to have passed.
 */
function authenticodeStatus(file) {
  if (process.platform !== 'win32') return 'unavailable-on-this-platform';
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '(Get-AuthenticodeSignature -LiteralPath ' + JSON.stringify(file) + ').Status',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return 'check-failed';
  return (result.stdout || '').trim();
}

/**
 * Confirm our icon actually reached the built executable.
 *
 * This exists because electron-builder will happily produce a package wearing
 * the framework default icon, exit zero, and mention it only as one line in a
 * long log. The check looks for our largest icon entry's exact bytes inside
 * the executable: if resource editing ran, they are in there; if it was
 * skipped, they are not.
 *
 * A signature-only or filename-only check would pass in both cases, which is
 * exactly the kind of guard that reports clean while the defect walks past.
 */
function iconWasEmbedded(executable, icoPath) {
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  let largest = null;
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const width = ico[entry] === 0 ? 256 : ico[entry];
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    if (!largest || width > largest.width) largest = { width, size, offset };
  }
  if (!largest) return { embedded: false, reason: 'the .ico declares no entries' };

  // A distinctive slice from the middle of the compressed image data. The
  // PNG header alone would match any PNG, which would make this pass on an
  // executable carrying somebody else's icon.
  const start = largest.offset + Math.floor(largest.size / 2);
  const needle = ico.subarray(start, start + 64);
  if (needle.length < 32) {
    return { embedded: false, reason: 'the largest icon entry is too small to fingerprint' };
  }

  const binary = fs.readFileSync(executable);
  return {
    embedded: binary.includes(needle),
    reason: null,
    width: largest.width,
  };
}

function findRecursively(directory, predicate, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) findRecursively(full, predicate, found);
    else if (predicate(entry.name)) found.push(full);
  }
  return found;
}

/* --------------------------------------------------------------------- run */

log('building the application');
run(process.execPath, [path.join(HERE, 'build.mjs')]);

log('generating brand assets');
run(process.execPath, [path.join(HERE, 'generate-brand.mjs')]);

if (!fs.existsSync(path.join(ROOT, 'assets', 'icon.ico'))) {
  fail('assets/icon.ico is missing, so the package would ship a framework default icon');
}

clearSigningInputs();

// Clear previous output so a failed run cannot leave a stale installer behind
// for the verification below to happily bless.
fs.rmSync(RELEASE_DIR, { recursive: true, force: true });

log('packaging with electron-builder (Squirrel.Windows, unsigned)');
// npx is a shim on Windows, so this one genuinely needs a shell.
run('npx', ['electron-builder', '--win', 'squirrel', '--config', 'electron-builder.yml'], {
  shell: process.platform === 'win32',
});

/* ------------------------------------------------------------------ verify */

log('verifying the produced artifacts');

const setups = findRecursively(RELEASE_DIR, (name) => /Setup.*\.exe$/i.test(name));
if (setups.length === 0) {
  fail(
    'no Setup executable was produced under ' +
      path.relative(ROOT, RELEASE_DIR) +
      '. electron-builder exited zero but wrote no installer.',
  );
}

const releasesFiles = findRecursively(RELEASE_DIR, (name) => name === 'RELEASES');
if (releasesFiles.length === 0) {
  fail('no RELEASES index was produced; Squirrel updates would not work');
}

const nupkgs = findRecursively(RELEASE_DIR, (name) => name.endsWith('.nupkg'));
if (nupkgs.length === 0) fail('no .nupkg package was produced');

let blocked = false;

const appExecutables = findRecursively(
  path.join(RELEASE_DIR, 'win-unpacked'),
  (name) => name.toLowerCase() === 'material workspace.exe',
);
if (appExecutables.length === 0) {
  fail('the unpacked application executable was not produced');
}
for (const executable of appExecutables) {
  const result = iconWasEmbedded(executable, path.join(ROOT, 'assets', 'icon.ico'));
  if (!result.embedded) {
    process.stderr.write(
      '[package] the application icon was NOT embedded in ' +
        path.relative(ROOT, executable) +
        (result.reason ? ' (' + result.reason + ')' : '') +
        '. This ships the framework default icon.' +
        ' Check that signAndEditExecutable is true in electron-builder.yml.\n',
    );
    blocked = true;
  } else {
    log('icon embedded in ' + path.relative(ROOT, executable) + ' (' + result.width + 'px entry matched)');
  }
}

for (const setup of setups) {
  const status = authenticodeStatus(setup);
  const size = fs.statSync(setup).size;
  log(
    path.relative(ROOT, setup) +
      '\n    size    ' +
      size.toLocaleString('en-GB') +
      ' bytes' +
      '\n    sha256  ' +
      sha256(setup) +
      '\n    signing ' +
      status,
  );
  if (status !== 'NotSigned' && status !== 'unavailable-on-this-platform') {
    process.stderr.write(
      '[package] the installer reports signing status "' +
        status +
        '", but this project must ship UNSIGNED artifacts.\n',
    );
    blocked = true;
  }
}

for (const nupkg of nupkgs) {
  log(
    path.relative(ROOT, nupkg) +
      '  ' +
      fs.statSync(nupkg).size.toLocaleString('en-GB') +
      ' bytes',
  );
}

if (blocked) fail('a produced artifact failed verification; refusing to report success');

log('');
log('The installer is UNSIGNED. Windows will show an unknown-publisher warning');
log('when it is run. That is deliberate and permanent for this project.');
log('');
log('Nothing was published, tagged or released.');
