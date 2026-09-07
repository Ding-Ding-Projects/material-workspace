/**
 * The per-surface completeness inventory.
 *
 * WHY IT IS HAND-WRITTEN. A rule-shaped check - "every surface that has a
 * search bar wires it to the builder" - passes perfectly on a surface with no
 * search bar. It never looked, so it never failed. This Oak Kay has already
 * met that twice: a destructive gate used by nothing, and a preview button
 * wired to nothing, both sitting behind a green suite.
 *
 * So this file is a LIST, not a rule. Every surface is named, every feature it
 * must carry is named, and the check fails when a named pair is missing. A
 * feature nobody has implemented anywhere fails here rather than being absent
 * from a registry that only knows what it found.
 *
 * IT IS ALSO HONEST ABOUT WHAT IS NOT BUILT. A row may be marked `pending`
 * with the reason, and the count of pending rows is reported on every run.
 * That is the difference between a gap somebody decided on and a gap nobody
 * noticed - and it means this file doubles as the roadmap's own check.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const ROOT = process.cwd();

interface Row {
  /** The surface, as a person would name it. */
  readonly surface: string;
  /** The contract it must carry. */
  readonly feature: string;
  /** Where it lives. */
  readonly file: string;
  /**
   * A line-anchored pattern proving it is there and live.
   *
   * Line-anchored because a commented-out line still contains the text, and a
   * renamed symbol still contains the old name as a substring. Both would
   * satisfy a bare `includes` for ever.
   */
  readonly proof: RegExp;
  /** Set when the row is deliberately not built yet, with the reason. */
  readonly pending?: string;
}

/** Every surface that renders to a person, named once. */
const SURFACES = [
  'Writer',
  'Sheets',
  'Slides',
  'Draw',
  'Formula',
  'Database',
  'PDF',
  'Notes',
  'Forms',
  'Appearance',
  'Narrator',
  'Locks',
  'Find a tab',
  'History',
  'Changelog',
  'Collaboration',
  'Governance',
  'Notifications',
  'Settings',
] as const;

const INVENTORY: readonly Row[] = [
  // ---------------------------------------------------------- the shell --
  {
    surface: 'Shell',
    feature: 'version and build provenance on the front screen',
    file: 'app/renderer/index.ts',
    proof: /^\s*provenance: BuildProvenance,$/m,
  },
  {
    surface: 'Shell',
    feature: 'three language modes',
    file: 'app/renderer/i18n.ts',
    proof: /^export type LanguageMode = /m,
  },
  {
    surface: 'Shell',
    feature: 'independent funny levels for each language',
    file: 'app/shared/settings.ts',
    proof: /^\s*cantonese: FunnyLevel;$/m,
  },
  {
    surface: 'Shell',
    feature: 'School mode forces English while keeping the stored choice',
    file: 'app/shared/school.ts',
    proof: /^export function effectiveMode</m,
  },
  {
    surface: 'Shell',
    feature: 'tab strip scrolls and reports what is out of view',
    file: 'app/renderer/components/tabs.ts',
    proof: /^\s*private updateOverflow\(\): void \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'command palette on Ctrl+Shift+F',
    file: 'app/renderer/components/palette/palette.ts',
    proof: /shiftKey/m,
  },
  {
    surface: 'Shell',
    feature: 'non-blocking notifications with a reviewable centre',
    file: 'app/renderer/components/notifications.ts',
    proof: /^export class Notifications \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'ADHD modes, independently toggleable',
    file: 'app/renderer/adhd.ts',
    proof: /^export class AttentionModes \{$/m,
  },

  // ------------------------------------------------------ safety rails --
  {
    surface: 'Shell',
    feature: 'two-key destructive confirmation, used by real actions',
    file: 'app/renderer/index.ts',
    proof: /^\s*void SuperConfirm\.open\(\{$/m,
  },
  {
    surface: 'Locks',
    feature: 'six credential policies, each lock with its own credential',
    file: 'app/shared/locks.ts',
    proof: /^export const POLICIES = \[$/m,
  },
  {
    surface: 'Locks',
    feature: 'the unlock ladder, budgeted so it cannot replace the password',
    file: 'app/shared/ladder.ts',
    proof: /^export function skipsRemaining\(/m,
  },
  {
    surface: 'Locks',
    feature: 'Support Tickets, naming the real recovery folder',
    file: 'app/renderer/components/locks-surface.ts',
    proof: /^\s*el\('h3', \{ class: 'locks-subtitle', text: 'Support Tickets' \}\),$/m,
  },

  // ------------------------------------------------------- discovery --
  {
    surface: 'Find a tab',
    feature: 'all four tab searches, each with its own query and regex opt-in',
    file: 'app/renderer/components/tab-search.ts',
    proof: /^const TITLES: Record<Kind, \{ title: string; help: string \}> = \{$/m,
  },
  {
    surface: 'Find a tab',
    feature: 'bulk close with a preview that names what it kept',
    file: 'app/renderer/tabs/model.ts',
    proof: /^export function planClose\(/m,
  },

  // ------------------------------------------------------- appearance --
  {
    surface: 'Appearance',
    feature: 'infinite colour picker, continuous rather than a swatch grid',
    file: 'app/renderer/components/colour-picker.ts',
    proof: /^\s*private onFieldPointer\(event: PointerEvent\): void \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'the colour translator across every notation',
    file: 'app/renderer/colour/notation.ts',
    proof: /^export function translate\(/m,
  },
  {
    surface: 'Appearance',
    feature: 'the animated rainbow as a sentinel, not a colour string',
    file: 'app/renderer/colour/rainbow.ts',
    proof: /^export const RAINBOW = 'rainbow' as const;$/m,
  },
  {
    surface: 'Appearance',
    feature: 'per-element appearance editors',
    file: 'app/renderer/components/appearance.ts',
    proof: /^\s*private onColour\(value: string\): void \{$/m,
    pending:
      'The surface edits one accent colour. Per-element editing, named presets ' +
      'and theme import/export are not built.',
  },

  // --------------------------------------------------------- narration --
  {
    surface: 'Narrator',
    feature: 'per-language voice pickers resolved from the machine',
    file: 'app/renderer/components/narrator-surface.ts',
    proof: /^export function browserVoices\(\)/m,
  },
  {
    surface: 'Narrator',
    feature: 'a serialized queue so nothing overlaps',
    file: 'app/renderer/narrator/narrator.ts',
    proof: /^export class NarratorQueue \{$/m,
  },
  {
    surface: 'Narrator',
    feature: 'yields to an active screen reader',
    file: 'app/renderer/narrator/narrator.ts',
    proof: /^export class NarratorQueue \{$/m,
    pending: 'The queue serialises its own speech; it does not yet detect or duck under a screen reader.',
  },

  // ------------------------------------------------------------ data --
  {
    surface: 'History',
    feature: 'browse, search, date range and action filter',
    file: 'app/renderer/components/history-panel.ts',
    proof: /^export class HistoryPanel \{$/m,
  },
  {
    surface: 'History',
    feature: 'restoring writes a new entry rather than rewriting',
    file: 'app/renderer/components/history-panel.ts',
    proof: /^\s*private async restore\(entry: HistoryEntry\): Promise<void> \{$/m,
  },
  {
    surface: 'Changelog',
    feature: 'generated from git, every commit proved to exist',
    file: 'scripts/build-changelog.mjs',
    proof: /^\s*const check = spawnSync\('git', \['cat-file', '-e',/m,
  },
  {
    surface: 'Shell',
    feature: 'export in every format that can carry the data',
    file: 'app/shared/export.ts',
    proof: /^export const FORMATS: readonly Format\[\] = \[$/m,
  },
  {
    surface: 'Shell',
    feature: 'export warnings naming the actual columns that would lose something',
    file: 'app/shared/export.ts',
    proof: /^export function warningsFor\(/m,
  },
  {
    surface: 'Shell',
    feature: 'a shared multi-select and bulk-action model',
    file: 'app/shared/bulk.ts',
    proof: /^export function plan<T extends \{ id: string \}>\($/m,
  },
  {
    surface: 'Notifications',
    feature: 'bulk actions with a stated select-all scope',
    file: 'app/renderer/components/notifications.ts',
    proof: /^\s*dismissSelected\.textContent = 'Dismiss selected';$/m,
  },
  {
    surface: 'History',
    feature: 'multi-select with a keyboard equivalent and a bulk plan',
    file: 'app/renderer/components/history-panel.ts',
    proof: /^\s*private renderBulk\(shown: readonly HistoryEntry\[\]\): void \{$/m,
  },
  {
    surface: 'Find a tab',
    feature: 'bulk close previewed before anything closes',
    file: 'app/renderer/tabs/model.ts',
    proof: /^export function planClose\(/m,
  },
  {
    surface: 'Shell',
    feature: 'bulk actions on every application list',
    file: 'app/shared/bulk.ts',
    proof: /^export function plan<T extends \{ id: string \}>\($/m,
    pending:
      'The shared model exists and is used by tabs, notifications and history. ' +
      'Writer, Sheets, Draw, Notes, Database and Forms still select one item at a time.',
  },

  // ------------------------------------------------- collaboration --
  {
    surface: 'Collaboration',
    feature: 'CRDT co-authoring that converges under every ordering',
    file: 'app/sync/crdt.ts',
    proof: /^\s*private positionFor\(after: Identity \| null, id: Identity\): number \{$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'offline queue that returns a failed batch to the front',
    file: 'app/sync/crdt.ts',
    proof: /^\s*retry\(\): void \{$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'presence that expires rather than needing a goodbye',
    file: 'app/sync/crdt.ts',
    proof: /^\s*sweep\(now: number\): ReplicaId\[\] \{$/m,
  },

  // ---------------------------------------------------- governance --
  {
    surface: 'Governance',
    feature: 'classification where a label only goes up without authority',
    file: 'app/main/governance/classification.ts',
    proof: /^export function decideLabelChange\(/m,
  },
  {
    surface: 'Governance',
    feature: 'scanning whose findings never disclose what they found',
    file: 'app/main/governance/dlp.ts',
    proof: /^export function scan\(/m,
  },
  {
    surface: 'Governance',
    feature: 'retention that reports rather than deletes',
    file: 'app/main/governance/retention.ts',
    proof: /^export function assess\(/m,
  },

  // ------------------------------------------------------ packaging --
  {
    surface: 'Shell',
    feature: 'update feed validated before anything acts on it',
    file: 'app/shared/updates.ts',
    proof: /^export function readFeed\(/m,
  },
  {
    surface: 'Shell',
    feature: 'a persistent non-blocking ready-to-restart banner',
    file: 'app/renderer/components/update-banner.ts',
    proof: /^export class UpdateBanner \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'the ready banner states that the installer is unsigned',
    file: 'app/shared/updates.ts',
    proof: /^\s*'It will be installed when you restart\. The installer is UNSIGNED, so ' \+$/m,
  },
  {
    surface: 'Shell',
    feature: 'downloading, staging and restarting through a real update feed',
    file: 'app/shared/updates.ts',
    proof: /^export function packageMatches\(/m,
    pending:
      'The model, its validation and the banner are built and tested. Nothing yet ' +
      'fetches a real feed, downloads a package or asks Squirrel to stage it.',
  },
  {
    surface: 'Shell',
    feature: 'the dim sum surprise, non-opt-out and non-blocking',
    file: 'app/shared/settings.ts',
    proof: /^\s*dimSum: DimSumState;$/m,
  },
];

function read(file: string): string {
  const full = path.join(ROOT, file);
  assert.ok(fs.existsSync(full), 'the inventory names a file that does not exist: ' + file);
  return fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
}

test('the inventory covers every surface the shell renders', () => {
  // Without this, deleting a surface's rows would make it silently exempt -
  // the guard reporting clean precisely because it stopped looking at that
  // surface. Every surface either has a row or is named here as covered by
  // its own drive script.
  const named = new Set(INVENTORY.map((row) => row.surface));
  const DRIVEN_ONLY = new Set([
    'Writer', 'Sheets', 'Slides', 'Draw', 'Formula',
    'Database', 'PDF', 'Notes', 'Forms', 'Notifications', 'Settings',
  ]);

  for (const surface of SURFACES) {
    assert.ok(
      named.has(surface) || DRIVEN_ONLY.has(surface),
      surface + ' has no inventory row and is not listed as drive-covered',
    );
  }
});

test('the inventory is not empty, so nothing below passes vacuously', () => {
  assert.ok(INVENTORY.length >= 30, 'only ' + INVENTORY.length + ' rows');
});

for (const row of INVENTORY) {
  const state = row.pending === undefined ? 'built' : 'pending';
  test('[' + state + '] ' + row.surface + ': ' + row.feature, () => {
    const source = read(row.file);
    assert.match(
      source,
      row.proof,
      row.file + ' no longer proves: ' + row.feature +
        (row.pending === undefined ? '' : ' (pending: ' + row.pending + ')'),
    );
  });
}

test('the pending rows are counted and named, so a gap is a decision', () => {
  // Reported rather than merely allowed. A gap nobody has written down is
  // indistinguishable from a gap nobody noticed, and this is the difference.
  const pending = INVENTORY.filter((row) => row.pending !== undefined);
  const lines = pending.map((row) => '  - ' + row.surface + ': ' + row.feature + ' - ' + row.pending);
  process.stdout.write(
    '\n[completeness] ' +
      (INVENTORY.length - pending.length) +
      ' of ' +
      INVENTORY.length +
      ' inventoried contracts are built. Still pending:\n' +
      lines.join('\n') +
      '\n\n',
  );

  for (const row of pending) {
    assert.ok(
      (row.pending ?? '').length > 20,
      row.surface + ': ' + row.feature + ' is pending with no real reason given',
    );
  }
});
