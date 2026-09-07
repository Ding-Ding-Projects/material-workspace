/**
 * Every destructive action goes through the gate.
 *
 * WHY A HAND-WRITTEN LIST. A rule-shaped check - "wherever SuperConfirm is
 * used, it is used correctly" - passes perfectly on an application that uses
 * it nowhere. That is not hypothetical here: the gate was written, styled and
 * complete, and NOTHING in the application went through it. A destructive-
 * action confirmation that no destructive action uses is decoration, and no
 * screenshot reveals it.
 *
 * So the list below names each action and where it lives. Adding a destructive
 * action without adding it here is not caught; adding it here without routing
 * it through the gate is. That asymmetry is deliberate and is the best a
 * source check can do - the other half is the drive scripts, which press the
 * real button in the real window and find the gate in the way.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const ROOT = process.cwd();

interface GatedAction {
  /** What a person would call it. */
  readonly what: string;
  readonly file: string;
  /**
   * A line-anchored pattern proving the call is live.
   *
   * Line-anchored rather than a bare substring, because a commented-out call
   * still contains the text. `// SuperConfirm.open({` would satisfy a
   * substring check for ever while the action ran unguarded.
   */
  readonly callPattern: RegExp;
  /** What must reach the gate as its `irreversible` line. */
  readonly saysIrreversible: RegExp;
}

const GATED: readonly GatedAction[] = [
  {
    what: 'resetting every setting from the settings surface',
    file: 'app/renderer/index.ts',
    callPattern: /^\s*void SuperConfirm\.open\(\{$/m,
    saysIrreversible: /There is no undo for this/,
  },
  {
    what: 'resetting every setting from the command palette',
    file: 'app/renderer/index.ts',
    // The palette reaches the same gate. A destructive action that is safe
    // from one surface and unguarded from another is unguarded.
    callPattern: /^\s*resetAll: \(\) => \{[\s\S]{0,400}?SuperConfirm\.open\(/m,
    saysIrreversible: /Your documents are untouched/,
  },
  {
    what: 'deleting a row in Database',
    file: 'app/renderer/apps/database/database.ts',
    callPattern: /^\s*void SuperConfirm\.open\(\{$/m,
    saysIrreversible: /no undo for a deleted row/,
  },
];

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

test('the inventory is not empty, so this guard has something to check', () => {
  // Without this, emptying the list would make every assertion below pass
  // vacuously - a guard reporting clean precisely because it stopped looking.
  assert.ok(GATED.length >= 3, 'only ' + GATED.length + ' actions inventoried');
});

for (const action of GATED) {
  test('gated: ' + action.what, () => {
    const source = read(action.file);
    assert.match(
      source,
      action.callPattern,
      action.file + ' does not open the gate for ' + action.what,
    );
    assert.match(
      source,
      action.saysIrreversible,
      'the gate for ' + action.what + ' does not say what cannot be undone',
    );
  });
}

test('every file that opens the gate imports it', () => {
  // A call to a symbol that is not imported is a build failure rather than a
  // silent one, so this is belt and braces - but it also catches the case
  // where a file is renamed and the import path rots while the call remains.
  const files = [...new Set(GATED.map((action) => action.file))];
  for (const file of files) {
    const source = read(file);
    assert.match(
      source,
      /^import \{ SuperConfirm \} from '[^']*super-confirm\.js';$/m,
      file + ' calls the gate without importing it from the expected path',
    );
  }
});

test('the gate refuses until both keys AND the whole slider are given', () => {
  // Asserted on the gate's own source, because the drive scripts prove the
  // behaviour in the window and this proves the RULE has not been loosened to
  // one key or a partial slide - a change that would still look correct in
  // every capture.
  const source = read('app/renderer/components/super-confirm.ts');
  assert.match(source, /keyOne\s*&&\s*keyTwo/, 'the gate no longer requires both keys');
  assert.match(source, /SLIDER_MAX/, 'the gate no longer requires the full slide');
});

test('the gate can always be escaped', () => {
  // A destructive gate that traps somebody is worse than no gate: they will
  // find another way out, and the one that is always available is the window
  // close button.
  const source = read('app/renderer/components/super-confirm.ts');
  assert.match(source, /'Escape'/, 'Escape no longer closes the gate');
  assert.match(source, /emergency/i, 'the emergency exit is gone');
});
