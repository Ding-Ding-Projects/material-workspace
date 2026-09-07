#!/usr/bin/env node
/**
 * scripts/write-provenance.mjs
 *
 * Produce the build provenance the application shows on its front screen.
 *
 * The contract this satisfies: every surface shows its running version AND that
 * exact version's updated-at date and local time, to the second, with the
 * timezone labelled, before any navigation. Both values must come from
 * provenance bound to the artifact that is running.
 *
 * So the timestamp written here is the moment this build was produced, recorded
 * at build time and frozen into the artifact. It is NOT launch time, NOT a file
 * mtime, and NOT an agent clock reading taken later. Those three are exactly the
 * substitutes the contract forbids, because each one drifts away from the thing
 * it claims to describe.
 *
 * When a value genuinely cannot be resolved it is written as null. The renderer
 * then shows an honest unavailable state. An invented time would be worse than
 * no time, because a reader cannot tell the difference.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  return value.length > 0 ? value : null;
}

function readPackageVersion() {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw).version ?? null;
}

/**
 * Prefer a timestamp supplied by the release pipeline, because that is the one
 * bound to the published artifact. Fall back to the commit's own author date,
 * which is still a property of the code being built rather than of this run.
 * Only as a last resort use the current time, and record which source was used
 * so the renderer never has to guess.
 */
function resolveBuiltAt() {
  const supplied = process.env.MATERIAL_WORKSPACE_BUILD_TIMESTAMP;
  if (supplied) {
    const parsed = new Date(supplied);
    if (!Number.isNaN(parsed.getTime())) {
      return { iso: parsed.toISOString(), source: 'release-pipeline' };
    }
    process.stderr.write(
      '[provenance] MATERIAL_WORKSPACE_BUILD_TIMESTAMP was not a valid date; ignoring it\n',
    );
  }

  const commitDate = git(['log', '-1', '--format=%cI']);
  if (commitDate) {
    const parsed = new Date(commitDate);
    if (!Number.isNaN(parsed.getTime())) {
      return { iso: parsed.toISOString(), source: 'commit-date' };
    }
  }

  return { iso: new Date().toISOString(), source: 'build-clock' };
}

const builtAt = resolveBuiltAt();

const provenance = {
  schema: 'material-workspace/provenance@1',
  version: readPackageVersion(),
  commit: git(['rev-parse', 'HEAD']),
  commitShort: git(['rev-parse', '--short', 'HEAD']),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  builtAt: builtAt.iso,
  builtAtSource: builtAt.source,
  // A tree that was dirty at build time produces an artifact that corresponds to
  // no commit. Recording it lets the front screen say so instead of showing a
  // SHA that does not describe what is running.
  treeDirty: git(['status', '--porcelain']) !== null ? git(['status', '--porcelain']) !== '' : null,
  signed: false,
  signingNote:
    'Code signing is permanently out of scope for this project. Installers are unsigned and Windows will show an unknown-publisher warning.',
};

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'provenance.json');
fs.writeFileSync(outFile, JSON.stringify(provenance, null, 2) + '\n', 'utf8');

process.stdout.write(
  '[provenance] version=' +
    provenance.version +
    ' commit=' +
    (provenance.commitShort ?? 'unknown') +
    ' builtAt=' +
    provenance.builtAt +
    ' (' +
    provenance.builtAtSource +
    ')\n',
);
