#!/usr/bin/env node
/**
 * Choose this release's dim sum code name.
 *
 * Every build carries a code name resolved from the public dim sum catalog, used
 * once per project so two builds are never indistinguishable in conversation. The
 * code name is a LABEL BESIDE the version, never a replacement for it: the
 * version number stays the thing a person and a machine identify a build by.
 *
 * Two efficiency rules, because the naive version is genuinely expensive:
 *
 *   - Prior code names are read from this project's own release bodies, once.
 *   - Only the CHOSEN candidate's photograph is checked. Paginating thousands of
 *     release assets to pick one dish is work that buys nothing.
 *
 * It FAILS OPEN. A release must never be blocked, delayed or renamed because the
 * catalog was unreachable; when no dish can be resolved the release ships with
 * its version alone and says so.
 *
 * Output: KEY=VALUE lines suitable for appending to GITHUB_OUTPUT.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const CATALOG_INDEX =
  'https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json';
const PHOTO_REPO = 'Ding-Ding-Projects/dim-sum-photos';
const THIS_REPO = process.env.GITHUB_REPOSITORY ?? 'Ding-Ding-Projects/material-workspace';

function emit(pairs) {
  for (const [key, value] of Object.entries(pairs)) {
    process.stdout.write(key + '=' + (value ?? '') + '\n');
  }
}

function unavailable(reason) {
  process.stderr.write('[codename] unavailable: ' + reason + '\n');
  emit({
    codename_id: '',
    codename_en: '',
    codename_zh: '',
    codename_image: '',
    codename_url: '',
    codename_source: 'unavailable',
  });
  process.exit(0);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'material-workspace-release' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(url + ' returned ' + response.status);
  return response.json();
}

/** Dish ids already used by this project, read from its own release bodies. */
function usedDishIds() {
  const result = spawnSync(
    'gh',
    ['release', 'list', '--repo', THIS_REPO, '--limit', '400', '--json', 'tagName'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return new Set();

  let tags;
  try {
    tags = JSON.parse(result.stdout).map((entry) => entry.tagName);
  } catch {
    return new Set();
  }

  const used = new Set();
  // One call for the bodies, not one per release.
  const bodies = spawnSync(
    'gh',
    ['release', 'list', '--repo', THIS_REPO, '--limit', '400', '--json', 'name,tagName'],
    { encoding: 'utf8' },
  );
  if (bodies.status === 0) {
    const matches = bodies.stdout.matchAll(/hk-dish-\d{4}/g);
    for (const match of matches) used.add(match[0]);
  }
  void tags;
  return used;
}

async function assetExists(tag, filename) {
  const url =
    'https://github.com/' + PHOTO_REPO + '/releases/download/' + tag + '/' + filename;
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(45_000),
    });
    return response.ok ? url : null;
  } catch {
    return null;
  }
}

async function main() {
  let catalog;
  try {
    catalog = await fetchJson(CATALOG_INDEX);
  } catch (error) {
    unavailable('the catalog index could not be read (' + String(error) + ')');
  }

  const dishes = Array.isArray(catalog.dishes) ? catalog.dishes : [];
  if (dishes.length === 0) unavailable('the catalog declares no dishes');

  const used = usedDishIds();

  // The catalog-v1 releases that carry the photographs, newest part last.
  const releaseList = spawnSync(
    'gh',
    ['release', 'list', '--repo', PHOTO_REPO, '--limit', '200', '--json', 'tagName'],
    { encoding: 'utf8' },
  );
  let photoTags = [];
  if (releaseList.status === 0) {
    try {
      photoTags = JSON.parse(releaseList.stdout)
        .map((entry) => entry.tagName)
        .filter((tag) => /^catalog-v1/.test(tag))
        .sort();
    } catch {
      photoTags = [];
    }
  }
  if (photoTags.length === 0) unavailable('no published catalog-v1 photo release was found');

  for (const dish of dishes) {
    if (!dish?.id || used.has(dish.id)) continue;
    const imagePath = dish.image?.path;
    if (typeof imagePath !== 'string' || imagePath.length === 0) continue;
    const filename = imagePath.split('/').pop();
    if (!filename) continue;

    // Only the chosen candidate is checked, across at most a handful of parts.
    for (const tag of photoTags) {
      const url = await assetExists(tag, filename);
      if (!url) continue;
      emit({
        codename_id: dish.id,
        codename_en: dish.name?.en ?? '',
        codename_zh: dish.name?.zhHant ?? '',
        codename_image: filename,
        codename_url: url,
        codename_source: 'public-catalog',
      });
      process.stderr.write(
        '[codename] ' + dish.id + ' — ' + (dish.name?.en ?? '') + ' · ' + (dish.name?.zhHant ?? '') + '\n',
      );
      return;
    }
  }

  unavailable('every catalog dish is either already used or has no published photograph');
}

main().catch((error) => unavailable(String(error)));
