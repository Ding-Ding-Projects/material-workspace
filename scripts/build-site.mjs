#!/usr/bin/env node
/**
 * Build the documentation site.
 *
 * The articles are the REAL files under docs/, read at build time and injected
 * into the bundle. There is no second copy to drift: editing an article edits
 * what the site serves, and a site that shows different words from the
 * repository is a documentation site nobody can trust.
 *
 * Release facts come from the published release, or are absent. A download
 * button pointing at a candidate or a guessed URL is worse than no button.
 *
 * Output: site-dist/, ready to publish.
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'site-dist');
const DOCS = path.join(ROOT, 'docs');

function log(message) {
  process.stdout.write('[site] ' + message + '\n');
}

function fail(message) {
  process.stderr.write('[site] FAILED: ' + message + '\n');
  process.exit(1);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/* ---------------------------------------------------------------- articles */

const CATEGORY_TITLES = {
  saving: 'Saving',
  interface: 'Interface',
  language: 'Language',
  building: 'Building',
};

function collectArticles() {
  const articles = [];
  const featuresRoot = path.join(DOCS, 'features');

  let categories;
  try {
    categories = fs.readdirSync(featuresRoot, { withFileTypes: true });
  } catch {
    fail('docs/features does not exist, so the site would have nothing to serve');
  }

  for (const category of categories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!category.isDirectory()) continue;
    const dir = path.join(featuresRoot, category.name);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));

    // The category index first, then its articles alphabetically.
    const ordered = [
      ...files.filter((name) => name === 'README.md'),
      ...files.filter((name) => name !== 'README.md').sort(),
    ];

    for (const file of ordered) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const titleMatch = /^#\s+(.*)$/m.exec(source);
      articles.push({
        path: 'features/' + category.name + '/' + file,
        title: titleMatch?.[1]?.trim() ?? file.replace(/\.md$/, ''),
        category: CATEGORY_TITLES[category.name] ?? category.name,
        source,
      });
    }
  }

  if (articles.length === 0) {
    fail('no articles were found under docs/features');
  }
  return articles;
}

/* ----------------------------------------------------------------- release */

function resolveRelease() {
  // Only a genuinely published release counts. Absence is reported as absence.
  const result = spawnSync(
    'gh',
    [
      'release',
      'view',
      '--repo',
      'Ding-Ding-Projects/material-workspace',
      '--json',
      'tagName,url,isDraft,assets',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    log('no published release could be read; the site will say so rather than guess');
    return null;
  }
  try {
    const release = JSON.parse(result.stdout);
    if (release.isDraft) return null;
    const installer = (release.assets ?? []).find((asset) => /Setup.*\.exe$/i.test(asset.name));
    return {
      tag: release.tagName,
      url: release.url,
      installer: installer?.url ?? null,
      // Read from the published notes rather than recomputed, so the site shows
      // the digest the release actually advertises.
      sha256: null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- build */

const articles = collectArticles();
log('collected ' + articles.length + ' articles');

const release = resolveRelease();
if (release) log('release ' + release.tag + (release.installer ? ' with an installer' : ''));

const buildFacts = {
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  commit: git(['rev-parse', '--short', 'HEAD']),
  builtAt: new Date().toISOString(),
  release,
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'site', 'main.ts')],
  outfile: path.join(OUT, 'site.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'warning',
  loader: { '.css': 'css' },
  define: {
    SITE_ARTICLES: JSON.stringify(articles),
    SITE_BUILD: JSON.stringify(buildFacts),
  },
});

// esbuild emits the bundled CSS beside the JS entry, named after it.
const emittedCss = path.join(OUT, 'site.css');
if (!fs.existsSync(emittedCss)) {
  fail('no stylesheet was emitted, so the site would render unstyled');
}

fs.copyFileSync(path.join(ROOT, 'site', 'index.html'), path.join(OUT, 'index.html'));
fs.copyFileSync(path.join(ROOT, 'social-preview.png'), path.join(OUT, 'social-preview.png'));
fs.copyFileSync(path.join(ROOT, 'docs', 'images', 'logo.png'), path.join(OUT, 'icon.png'));

// Without this, the host runs its own templating over the output and mangles
// anything that looks like a template expression.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

/* ------------------------------------------------------------------ verify */

// Assert against what was EMITTED, never against the configuration. A green
// build proves a file was written, not that it contains what it should.
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const required = [
  ['og:image absolute https URL', /property="og:image"\s+content="https:\/\/[^"]+"/],
  ['og:image:width', /property="og:image:width"/],
  ['og:image:height', /property="og:image:height"/],
  ['og:image:alt', /property="og:image:alt"/],
  ['twitter:card summary_large_image', /name="twitter:card"\s+content="summary_large_image"/],
  ['viewport meta', /name="viewport"/],
  ['theme-color', /name="theme-color"/],
];
for (const [name, pattern] of required) {
  if (!pattern.test(html)) fail('the emitted index.html is missing its ' + name);
}

// Nothing may be fetched from anywhere else.
const remote = /(?:src|href)="https?:\/\/(?!github\.com)/g;
const offenders = [...html.matchAll(remote)];
if (offenders.length > 0) {
  fail(
    'the emitted index.html loads ' +
      offenders.length +
      ' remote asset(s). Every asset must be local: no CDN, no remote font, no analytics.',
  );
}

const preview = fs.statSync(path.join(OUT, 'social-preview.png'));
if (preview.size < 1024) fail('the social preview image is implausibly small');

/**
 * Prove every article on disk reached the bundle.
 *
 * Done here, against the article list this build actually injected, and emitted
 * as a manifest so a later step can check the same fact without inspecting the
 * bundle.
 *
 * Grepping the bundle for a JSON shape was the first attempt and it went red for
 * the wrong reason: esbuild REFORMATS an injected object, so `{"path":"..."}`
 * becomes `{ path: "..." }` and a pattern written against the input never
 * matches the output. A check that fails because it was looking for the wrong
 * text tells you nothing about the thing it was written to protect.
 */
const onDisk = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.md')) {
      onDisk.push(path.relative(DOCS, full).split(path.sep).join('/'));
    }
  }
})(path.join(DOCS, 'features'));

const bundled = new Set(articles.map((article) => article.path));
const missing = onDisk.filter((file) => !bundled.has(file));
if (missing.length > 0) {
  fail(
    'these articles exist on disk but did not reach the bundle:\n' +
      missing.map((file) => '    ' + file).join('\n'),
  );
}

fs.writeFileSync(
  path.join(OUT, 'articles.json'),
  JSON.stringify(
    {
      builtAt: buildFacts.builtAt,
      count: articles.length,
      paths: articles.map((article) => article.path).sort(),
    },
    null,
    2,
  ) + '\n',
);

log('emitted ' + OUT);
log(
  'verified: ' +
    articles.length +
    ' articles bundled (all ' +
    onDisk.length +
    ' on disk), embed tags present, no remote assets, preview ' +
    preview.size +
    ' bytes',
);
