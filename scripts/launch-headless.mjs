#!/usr/bin/env node
/**
 * Launch the built application on an off-screen desktop with a debugging port.
 *
 * Committed rather than typed by hand each time, because the sequence has
 * three details that are wrong by default and were each rediscovered the hard
 * way:
 *
 *   1. The profile must be a fresh, task-owned directory. Reusing the real one
 *      means the drive reads whatever state a previous session left, so a
 *      passing run proves nothing about a first launch.
 *   2. The window must be resolved by TITLE AND CLASS, never by index. One
 *      Electron process lists a dozen top-level windows — IME frames, tooltip
 *      hosts, power-message windows — and the first is not the application.
 *   3. The visible desktop is never touched. Everything here runs on a named
 *      off-screen Win32 desktop through the cheap headless route.
 *
 * This script only prints the command to run; the launch itself goes through
 * the headless tooling, which cannot be invoked from inside Node here.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const port = process.argv[2] ?? '9333';
const profile = path.join(ROOT, '.tmp', 'drive-profile');

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) {
  process.stderr.write('[launch] electron binary missing: ' + electron + '\n');
  process.stderr.write('[launch] run: npm run ensure:electron\n');
  process.exit(1);
}

// Quoted with plain double quotes, NOT JSON.stringify. JSON escaping doubles
// every backslash in a Windows path, so the command line carries
// C:\Users\... and the launcher reports a path that does not exist while
// the path plainly does. The quotes are needed because the repository path
// can contain a space; the escaping is not.
const quote = (value) => '"' + value + '"';

const command = [
  quote(electron),
  quote(ROOT),
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + quote(profile),
  '--no-first-run',
  '--disable-features=msEdgeFirstRunExperience',
].join(' ');

process.stdout.write(command + '\n');
