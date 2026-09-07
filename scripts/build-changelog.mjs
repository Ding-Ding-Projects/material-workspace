#!/usr/bin/env node
/**
 * Build the changelog from the repository's own history.
 *
 * WRITTEN FROM GIT, NEVER BY HAND. A hand-maintained changelog drifts from what
 * actually shipped within about a fortnight, and the drift is invisible: every
 * entry looks plausible, and the one that is missing is missing silently.
 *
 * EVERY ENTRY CARRIES ITS COMMIT. An entry that says what changed but not where
 * is unverifiable - a reader who doubts it, or who needs the surrounding
 * context, has no way to get from the sentence to the code. And a WRONG commit
 * is worse than none, because it sends them somewhere confidently irrelevant,
 * so every identifier is checked against the repository before it is written.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'app', 'renderer', 'changelog-data.json');
const MARKDOWN = path.join(ROOT, 'CHANGELOG.md');

/**
 * Separators no commit message will contain.
 *
 * ASCII unit and record separators, written as character codes rather than as
 * the bytes themselves. A literal control byte in source is invisible in every
 * editor and diff, so nobody can see whether it survived a copy, a paste or a
 * quoting layer - and the repository has a guard that refuses them for exactly
 * that reason. It caught this file on its first run.
 */
const FIELD = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write('[changelog] git ' + args.join(' ') + ' failed:\n' + (result.stderr ?? '') + '\n');
    process.exit(1);
  }
  return result.stdout ?? '';
}

/**
 * Which category a commit belongs to.
 *
 * Read from the subject rather than from a convention nobody follows. The
 * fallback is "changed" rather than dropping the commit: a changelog that
 * silently omits whatever it could not classify is a changelog with holes in
 * it, and the holes are exactly the entries nobody wrote a nice subject for.
 */
function categorise(subject) {
  const text = subject.toLowerCase();
  if (/\b(fix|fixes|fixed|stop|stops|repair|correct)\b/.test(text)) return 'fixed';
  if (/\b(add|adds|added|new|introduce)\b/.test(text)) return 'added';
  if (/\b(remove|removes|removed|drop|drops|delete)\b/.test(text)) return 'removed';
  if (/\b(document|documents|docs|readme|roadmap|handoff)\b/.test(text)) return 'documented';
  if (/\b(deploy|deploys|release|ship|publish)\b/.test(text)) return 'shipped';
  return 'changed';
}

const format = ['%H', '%h', '%aI', '%s'].join(FIELD) + RECORD;
const raw = git(['log', '--no-color', '--pretty=format:' + format]);

const entries = [];
for (const record of raw.split(RECORD)) {
  const line = record.trim();
  if (line === '') continue;
  const [commit, shortCommit, at, subject] = line.split(FIELD);
  if (commit === undefined || subject === undefined) continue;

  // The BILINGUAL body is deliberately not included. It belongs in the commit,
  // where somebody reading `git log` wants it; repeating it in a viewer that
  // already links to the commit is the same words twice.
  entries.push({
    commit,
    shortCommit,
    at,
    subject,
    category: categorise(subject),
  });
}

if (entries.length === 0) {
  process.stderr.write('[changelog] no commits were read; refusing to write an empty changelog\n');
  process.exit(1);
}

/**
 * Prove every referenced commit exists.
 *
 * A dead link is worse than no link. `cat-file -e` is used rather than
 * `rev-parse` because it answers the exact question - does this object exist -
 * without resolving anything that merely looks like a reference.
 */
const missing = [];
for (const entry of entries) {
  const check = spawnSync('git', ['cat-file', '-e', entry.commit + '^{commit}'], { cwd: ROOT });
  if (check.status !== 0) missing.push(entry.shortCommit);
}
if (missing.length > 0) {
  process.stderr.write('[changelog] these commits do not exist: ' + missing.join(', ') + '\n');
  process.exit(1);
}

/** The repository the links resolve against, read rather than assumed. */
function originSlug() {
  const url = git(['config', '--get', 'remote.origin.url']).trim();
  const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
  return match === null ? null : match[1] + '/' + match[2];
}

const slug = originSlug();
if (slug === null) {
  // Honest rather than guessing a URL that would 404. The viewer shows the
  // identifier without a link in that case.
  process.stdout.write('[changelog] no GitHub remote found; entries will carry no link\n');
}

const payload = {
  generatedFrom: 'git log',
  repository: slug,
  commitUrlPrefix: slug === null ? null : 'https://github.com/' + slug + '/commit/',
  entries,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');

// The Markdown copy, for anybody reading the repository rather than running it.
const byCategory = new Map();
for (const entry of entries) {
  const list = byCategory.get(entry.category) ?? [];
  list.push(entry);
  byCategory.set(entry.category, list);
}

const lines = [
  '# Changelog',
  '',
  'Generated from `git log` by `scripts/build-changelog.mjs`. Every entry carries',
  'the commit that made the change, and the build refuses to write an entry whose',
  'commit does not exist.',
  '',
  'Do not edit this file by hand: it is rewritten on every build, and a hand',
  'edit would be silently lost.',
  '',
];

for (const [category, list] of [...byCategory.entries()].sort()) {
  lines.push('## ' + category.charAt(0).toUpperCase() + category.slice(1), '');
  for (const entry of list) {
    const link =
      payload.commitUrlPrefix === null
        ? '`' + entry.shortCommit + '`'
        : '[`' + entry.shortCommit + '`](' + payload.commitUrlPrefix + entry.commit + ')';
    lines.push('- ' + entry.subject + ' — ' + link + ' — ' + entry.at.slice(0, 10));
  }
  lines.push('');
}

fs.writeFileSync(MARKDOWN, lines.join('\n'));

process.stdout.write(
  '[changelog] ' + entries.length + ' entries across ' + byCategory.size + ' categories\n',
);
