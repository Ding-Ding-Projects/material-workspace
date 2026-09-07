/**
 * The external-link allowlist.
 *
 * Handing a renderer an arbitrary-URL opener is a hole rather than a
 * convenience, and the hole is quiet: nothing errors, the link just opens
 * something it should not have.
 *
 * The handler itself lives in the main process behind Electron's `shell`, so
 * what is asserted here is the DECISION - the same predicate, extracted, and
 * a guard that the shipped handler still applies it. Testing the predicate
 * without checking it is wired would prove the rule and nothing about whether
 * anything obeys it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const ROOT = process.cwd();

/** The decision the shipped handler makes, restated here to be exercised. */
function allowed(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'github.com') return false;
  if (url.username !== '' || url.password !== '') return false;
  return true;
}

test('a commit link on the repository host is opened', () => {
  assert.equal(
    allowed('https://github.com/Ding-Ding-Projects/material-workspace/commit/abc123'),
    true,
  );
});

test('every scheme that is not https is refused', () => {
  // `file:` reads the disk, a custom scheme can launch another installed
  // application, and `javascript:` is what it sounds like.
  for (const bad of [
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://github.com/a/b',
    'ms-settings:privacy',
    'vscode://file/C:/secret',
  ]) {
    assert.equal(allowed(bad), false, 'accepted ' + bad);
  }
});

test('a host that merely ENDS WITH the allowed one is refused', () => {
  // The suffix match is the classic mistake here: `github.com.example.invalid`
  // ends with the string and is somebody else's machine entirely.
  for (const bad of [
    'https://github.com.example.invalid/a/b',
    'https://notgithub.com/a/b',
    'https://evil.github.com.attacker.test/a',
  ]) {
    assert.equal(allowed(bad), false, 'accepted ' + bad);
  }
  // A genuine subdomain is refused too: it is not where commits live, and
  // widening this later should be a deliberate decision rather than a
  // side effect of a loose rule.
  assert.equal(allowed('https://gist.github.com/a'), false);
});

test('a link carrying credentials is refused', () => {
  // A URL with a user-info section is how a link smuggles a token past
  // somebody reading it, and the browser would send it on.
  assert.equal(allowed('https://user:token@github.com/a/b'), false);
  assert.equal(allowed('https://user@github.com/a/b'), false);
});

test('anything that is not a link at all is refused', () => {
  for (const bad of [null, undefined, 42, {}, [], '', '   ', 'not a url', '//github.com/a']) {
    assert.equal(allowed(bad), false, 'accepted ' + JSON.stringify(bad));
  }
});

test('the shipped handler still applies every part of the rule', () => {
  // A hand-written list of the exact checks, anchored to their lines. Without
  // this the predicate above would be a rule nothing obeys - the decision
  // proven and the shipped handler free to have dropped any of it.
  const source = fs
    .readFileSync(path.join(ROOT, 'app', 'main', 'main.ts'), 'utf8')
    .replace(/\r\n/g, '\n');

  const required: [string, RegExp][] = [
    ['https only', /^\s*if \(url\.protocol !== 'https:'\) \{$/m],
    ['exact host', /^\s*if \(url\.hostname !== 'github\.com'\) \{$/m],
    ['no credentials', /^\s*if \(url\.username !== '' \|\| url\.password !== ''\) \{$/m],
    ['parses the url', /^\s*url = new URL\(raw\);$/m],
  ];

  for (const [what, pattern] of required) {
    assert.match(source, pattern, 'the handler no longer checks: ' + what);
  }
});
