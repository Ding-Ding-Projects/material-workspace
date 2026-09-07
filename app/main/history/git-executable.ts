/**
 * Find the git executable, explicitly.
 *
 * Relying on `spawn('git', ...)` finding it on PATH is a bet on the environment
 * the process happened to be launched with, and that bet loses more often than
 * it looks. A GUI application started from a Start Menu shortcut, a scheduled
 * task, an installer's post-install launch, or an automation harness can each
 * inherit a PATH that does not carry the user's shell environment — so git is
 * plainly installed, works in every terminal the user opens, and the application
 * still reports ENOENT.
 *
 * That failure is doubly bad because the message says "not found", which reads
 * as "install git" to a user who has already installed git.
 *
 * So: try PATH first (correct and cheapest when it works), then the documented
 * install locations, and when everything fails report EVERY path that was tried
 * rather than a bare not-found.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface GitResolution {
  /** Absolute path, or the bare command when PATH resolution worked. */
  command: string | null;
  version: string | null;
  /** Every location tried, in order, so a failure is diagnosable rather than
   *  merely disappointing. */
  attempted: string[];
  reason: string | null;
}

let cached: GitResolution | null = null;

function candidatePaths(): string[] {
  const candidates: string[] = [];

  const override = process.env.MATERIAL_WORKSPACE_GIT;
  if (override) candidates.push(override);

  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const root of roots) {
      candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
      candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
      candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
      candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    }
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
  }

  return candidates;
}

function probe(command: string): string | null {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0) return null;
    const version = (result.stdout || '').trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

export function resolveGit(): GitResolution {
  if (cached && cached.command) return cached;

  const attempted: string[] = [];

  // PATH first. When it works it is the right answer and costs one probe.
  attempted.push('git (via PATH)');
  const onPath = probe('git');
  if (onPath) {
    cached = { command: 'git', version: onPath, attempted, reason: null };
    return cached;
  }

  for (const candidate of candidatePaths()) {
    attempted.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    const version = probe(candidate);
    if (version) {
      cached = { command: candidate, version, attempted, reason: null };
      return cached;
    }
  }

  cached = {
    command: null,
    version: null,
    attempted,
    reason:
      'Git could not be found. Document history needs it. Tried, in order:\n' +
      attempted.map((entry) => '    ' + entry).join('\n') +
      '\n  If Git is installed somewhere else, set the MATERIAL_WORKSPACE_GIT environment variable to its full path.',
  };
  return cached;
}

/** Drop the cached answer. Used by tests and after the user installs Git
 *  without restarting, so a fixed environment is picked up without a relaunch. */
export function forgetResolvedGit(): void {
  cached = null;
}
