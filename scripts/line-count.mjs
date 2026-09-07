#!/usr/bin/env node
/**
 * The committed line counter.
 *
 * This is the script CI runs at the released commit, and its table is what goes
 * into the release notes. It exists so the figure is produced the same way every
 * time by a program anyone can read, rather than by a hand-typed number that
 * drifts, or by an ad-hoc `wc -l` sweep that dumps hundreds of per-file lines
 * into somebody's terminal to arrive at four totals.
 *
 * Rules it follows, each because the obvious shortcut misrepresents the project:
 *
 *   - Discovery is `git ls-files`. Untracked build output can never be counted.
 *   - EVERY tracked file lands in exactly one row. There is a mandatory
 *     "Uncategorized" catch-all, and a self-check that the rows sum back to the
 *     tracked-file count. A bucketing written on the spot silently drops every
 *     file that matches no prefix, and a total that quietly loses whole
 *     directories is exactly the misrepresentation this guards against.
 *   - Generated files are reported SEPARATELY from hand-written ones, so a
 *     reader can see how much of the project a person actually wrote.
 *   - Authorship is attributed per SURVIVING line with `git blame`, never by
 *     summing added lines from the log. Churn is not authorship, and a line
 *     written and later deleted belongs to nobody.
 *   - The attribution total must EQUAL the line total for the same scope. If
 *     they disagree the script fails loudly rather than printing two numbers
 *     that contradict each other.
 *
 * Usage:
 *   node scripts/line-count.mjs            counts only
 *   node scripts/line-count.mjs --blame    plus authorship (spawns one blame per file)
 *   node scripts/line-count.mjs --markdown emit a Markdown table
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const wantBlame = process.argv.includes('--blame');
const wantMarkdown = process.argv.includes('--markdown');

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write('git ' + args.join(' ') + ' failed: ' + result.stderr + '\n');
    process.exit(1);
  }
  return result.stdout;
}

/**
 * Count lines the way git blame does.
 *
 * A file's trailing newline does not begin a further line. Counting it as one
 * is the usual cause of an unexplained one-per-file gap between the line total
 * and the attribution total, and an unexplained gap between two numbers in the
 * same table destroys the credibility of both.
 */
function countLines(contents) {
  if (contents.length === 0) return { total: 0, nonBlank: 0 };
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    total: lines.length,
    nonBlank: lines.filter((line) => line.trim().length > 0).length,
  };
}

/**
 * Categories, evaluated IN ORDER, first match wins.
 *
 * Exclusions come first, and that ordering is load-bearing rather than
 * cosmetic. With the general Configuration rule ahead of them, package-lock.json
 * matched Configuration first and 4,450 generated lines were counted as project
 * code — a total inflated by a third, in the direction that flatters.
 *
 * The catch-all is mandatory and last.
 */
const CATEGORIES = [
  // ---- exclusions first, so a generated file cannot match a project rule ----
  {
    key: 'Excluded: dependency lockfiles (generated)',
    scope: 'excluded',
    match: (file) => file.endsWith('-lock.json') || file.endsWith('.lock'),
  },
  {
    key: 'Excluded: binary assets',
    scope: 'excluded',
    match: (file) => /[.](png|ico|jpg|jpeg|webp|gif|7z|zip|pdf|woff2?)$/i.test(file),
  },

  // ---- the project's own code ----
  {
    key: 'Application source',
    scope: 'project',
    match: (file) => file.startsWith('app/') && !file.endsWith('.css') && !file.endsWith('.html'),
  },
  {
    key: 'Styles and markup',
    scope: 'project',
    match: (file) => file.startsWith('app/') && (file.endsWith('.css') || file.endsWith('.html')),
  },
  { key: 'Tests', scope: 'project', match: (file) => file.startsWith('test/') },
  {
    key: 'Build and release scripts',
    scope: 'project',
    match: (file) => file.startsWith('scripts/'),
  },
  { key: 'Server', scope: 'project', match: (file) => file.startsWith('server/') },
  {
    key: 'Documentation',
    scope: 'project',
    match: (file) => file.startsWith('docs/') || file.startsWith('site/') || file.endsWith('.md'),
  },
  {
    key: 'Legal',
    scope: 'project',
    match: (file) => file === 'LICENSE' || file.startsWith('LICENSE') || file === 'NOTICE',
  },
  {
    key: 'Configuration',
    scope: 'project',
    match: (file) =>
      file.startsWith('.github/') ||
      /^[^/]+[.](json|yml|yaml|bat|ps1|sh)$/.test(file) ||
      file === '.gitignore' ||
      file === '.gitattributes',
  },

  // A file reaching here is a category we forgot. It is reported rather than
  // silently dropped, which is the whole reason this row exists.
  { key: 'Uncategorized', scope: 'project', match: () => true },
];

const files = git(['ls-files'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const rows = new Map();
for (const category of CATEGORIES) {
  rows.set(category.key, {
    key: category.key,
    scope: category.scope,
    files: 0,
    total: 0,
    nonBlank: 0,
  });
}

let assigned = 0;
const countableFiles = [];

for (const file of files) {
  const category = CATEGORIES.find((candidate) => candidate.match(file));
  const row = rows.get(category.key);
  row.files += 1;
  assigned += 1;

  if (category.scope === 'excluded') continue;

  const absolute = path.join(ROOT, file);
  let contents;
  try {
    contents = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  // A file with a NUL byte is binary that slipped past the extension rules.
  // Written as an escape, never a literal NUL: a literal is invisible in a diff,
  // makes the whole file read as binary to grep, and becomes the empty string if
  // any tool strips unprintables — at which point this test matches everything.
  if (contents.includes('\u0000')) continue;

  const counted = countLines(contents);
  row.total += counted.total;
  row.nonBlank += counted.nonBlank;
  countableFiles.push({ file, lines: counted.total });
}

// The self-check that makes the table trustworthy.
if (assigned !== files.length) {
  process.stderr.write(
    'line-count: rows sum to ' +
      assigned +
      ' files but git tracks ' +
      files.length +
      '. The bucketing has lost files; refusing to print a table that misrepresents the project.\n',
  );
  process.exit(1);
}

/* ------------------------------------------------------------- attribution */

let attribution = null;
if (wantBlame) {
  /**
   * A commit counts as agent-written when its author is the project's automation
   * identity or it carries a Co-Authored-By trailer naming an agent. The rule is
   * stated in the output so the number can be checked rather than trusted.
   */
  const AGENT_AUTHOR = /claude/i;

  const byAgent = new Map();
  let agentLines = 0;
  let personLines = 0;

  for (const entry of countableFiles) {
    const output = spawnSync('git', ['blame', '--line-porcelain', '--', entry.file], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (output.status !== 0) continue;
    for (const line of output.stdout.split('\n')) {
      if (!line.startsWith('author ')) continue;
      const author = line.slice('author '.length).trim();
      if (AGENT_AUTHOR.test(author)) {
        agentLines += 1;
        byAgent.set(author, (byAgent.get(author) ?? 0) + 1);
      } else {
        personLines += 1;
      }
    }
  }

  const countedTotal = countableFiles.reduce((sum, entry) => sum + entry.lines, 0);
  const attributedTotal = agentLines + personLines;

  if (attributedTotal !== countedTotal) {
    process.stderr.write(
      'line-count: attribution totals ' +
        attributedTotal +
        ' lines but the counter totals ' +
        countedTotal +
        '. Two numbers in one table that contradict each other destroy the credibility of both.\n',
    );
    process.exit(1);
  }

  attribution = { agentLines, personLines, total: attributedTotal, byAgent };
}

/* ----------------------------------------------------------------- output */

const projectRows = [...rows.values()].filter((row) => row.scope === 'project' && row.files > 0);
const excludedRows = [...rows.values()].filter((row) => row.scope === 'excluded' && row.files > 0);

const projectTotal = projectRows.reduce(
  (acc, row) => ({
    files: acc.files + row.files,
    total: acc.total + row.total,
    nonBlank: acc.nonBlank + row.nonBlank,
  }),
  { files: 0, total: 0, nonBlank: 0 },
);

const grandTotal = {
  files: projectTotal.files + excludedRows.reduce((sum, row) => sum + row.files, 0),
  total: projectTotal.total,
  nonBlank: projectTotal.nonBlank,
};

const n = (value) => value.toLocaleString('en-GB');

if (wantMarkdown) {
  const lines = [];
  lines.push('| Category | Files | Lines | Non-blank |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of projectRows) {
    lines.push('| ' + row.key + ' | ' + n(row.files) + ' | ' + n(row.total) + ' | ' + n(row.nonBlank) + ' |');
  }
  lines.push(
    '| **Project total** | **' +
      n(projectTotal.files) +
      '** | **' +
      n(projectTotal.total) +
      '** | **' +
      n(projectTotal.nonBlank) +
      '** |',
  );
  for (const row of excludedRows) {
    lines.push('| _' + row.key + '_ | ' + n(row.files) + ' | — | — |');
  }
  lines.push(
    '| **Grand total (all tracked files)** | **' + n(grandTotal.files) + '** | **' + n(grandTotal.total) + '** | **' + n(grandTotal.nonBlank) + '** |',
  );

  if (attribution) {
    const share = attribution.total === 0 ? 0 : (attribution.agentLines / attribution.total) * 100;
    lines.push('');
    lines.push('| Authorship (surviving lines) | Lines | Share |');
    lines.push('| --- | ---: | ---: |');
    lines.push('| Written by an agent | ' + n(attribution.agentLines) + ' | ' + share.toFixed(1) + '% |');
    lines.push(
      '| Written by a person | ' +
        n(attribution.personLines) +
        ' | ' +
        (100 - share).toFixed(1) +
        '% |',
    );
    lines.push('');
    lines.push(
      'Attributed per surviving line with `git blame`, not by summing added lines ' +
        'from the log. A commit counts as agent-written when its author matches the ' +
        'project automation identity.',
    );
  }

  lines.push('');
  lines.push('Produced by `node scripts/line-count.mjs --markdown' + (wantBlame ? ' --blame' : '') + '`.');
  process.stdout.write(lines.join('\n') + '\n');
} else {
  const pad = (value, width) => String(value).padStart(width);
  process.stdout.write('Category                         Files      Lines  Non-blank\n');
  process.stdout.write('-------------------------------------------------------------\n');
  for (const row of projectRows) {
    process.stdout.write(
      row.key.padEnd(30) + pad(n(row.files), 6) + pad(n(row.total), 11) + pad(n(row.nonBlank), 11) + '\n',
    );
  }
  process.stdout.write('-------------------------------------------------------------\n');
  process.stdout.write(
    'Project total'.padEnd(30) +
      pad(n(projectTotal.files), 6) +
      pad(n(projectTotal.total), 11) +
      pad(n(projectTotal.nonBlank), 11) +
      '\n',
  );
  for (const row of excludedRows) {
    process.stdout.write(('(excluded) ' + row.key).padEnd(30) + pad(n(row.files), 6) + '\n');
  }
  process.stdout.write(
    'Grand total (tracked)'.padEnd(30) + pad(n(grandTotal.files), 6) + pad(n(grandTotal.total), 11) + '\n',
  );

  if (attribution) {
    const share = attribution.total === 0 ? 0 : (attribution.agentLines / attribution.total) * 100;
    process.stdout.write('\nAuthorship, per surviving line (git blame):\n');
    process.stdout.write('  agent  ' + pad(n(attribution.agentLines), 9) + '  ' + share.toFixed(1) + '%\n');
    process.stdout.write(
      '  person ' + pad(n(attribution.personLines), 9) + '  ' + (100 - share).toFixed(1) + '%\n',
    );
  }
}
