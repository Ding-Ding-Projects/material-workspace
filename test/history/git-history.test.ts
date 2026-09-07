/**
 * Document history, tested against the REAL git binary and a REAL temporary
 * repository.
 *
 * This module has a small pure half and a large subprocess half, and that shape
 * is exactly how a feature ships completely dead behind a green suite: tests
 * cluster around the pure half because it is easy and satisfying to test, the
 * count climbs, and not one of them ever creates a commit.
 *
 * So every assertion below that matters is made through an INDEPENDENT git
 * invocation, never by believing GitHistory's own report of its own success. A
 * module that swallows an error will happily tell you it worked.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GitHistory } from '../../app/main/history/git-history.js';
import { resolveGit } from '../../app/main/history/git-executable.js';

const gitCommand = resolveGit().command;

/** Ask git directly, with no involvement from the module under test. */
function git(repository: string, args: string[]): string {
  assert.ok(gitCommand, 'git must be resolvable for these tests to mean anything');
  const result = spawnSync(gitCommand, args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    'independent git ' + args.join(' ') + ' failed: ' + (result.stderr || ''),
  );
  return result.stdout.trim();
}

describe('GitHistory against a real repository', { skip: gitCommand ? false : 'git is not installed' }, () => {
  let workdir: string;
  let history: GitHistory;

  before(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-history-'));
    history = new GitHistory(path.join(workdir, 'history'));
  });

  after(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('creates a real repository with a real initial commit', async () => {
    await history.ensureRepository();

    // Independent proof: the directory git itself reports, and a commit count
    // read by git rather than by the module.
    assert.equal(git(history.repository, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(git(history.repository, ['rev-list', '--count', 'HEAD']), '1');
  });

  it('records an action as a commit that git can see', async () => {
    const result = await history.record({
      action: 'created',
      subject: 'Create a first document',
      documentId: 'doc-1',
      files: [{ relativePath: 'documents/doc-1.json', contents: '{"v":1}\n' }],
    });

    assert.ok(result, 'record must report a commit');

    // The commit exists, and its content is what we wrote.
    const listed = git(history.repository, ['ls-files']);
    assert.ok(listed.includes('documents/doc-1.json'), 'the file must be tracked by git');
    assert.equal(git(history.repository, ['show', 'HEAD:documents/doc-1.json']), '{"v":1}');

    // The trailer that carries the action is really in the commit message.
    const body = git(history.repository, ['log', '-1', '--format=%b']);
    assert.match(body, /^Workspace-Action: created$/m);
    assert.match(body, /^Workspace-Document: doc-1$/m);
  });

  it('records nothing when nothing changed', async () => {
    const before = git(history.repository, ['rev-list', '--count', 'HEAD']);
    const result = await history.record({
      action: 'updated',
      subject: 'Write the identical bytes again',
      files: [{ relativePath: 'documents/doc-1.json', contents: '{"v":1}\n' }],
    });
    const after = git(history.repository, ['rev-list', '--count', 'HEAD']);

    assert.equal(result, null, 'an unchanged write must report no commit');
    assert.equal(after, before, 'an unchanged write must not create a commit');
  });

  it('restores by ADDING a commit rather than rewinding', async () => {
    const original = git(history.repository, ['rev-parse', 'HEAD']);

    await history.record({
      action: 'updated',
      subject: 'Change the document',
      files: [{ relativePath: 'documents/doc-1.json', contents: '{"v":2}\n' }],
    });
    const afterChange = git(history.repository, ['rev-parse', 'HEAD']);
    const countAfterChange = Number(git(history.repository, ['rev-list', '--count', 'HEAD']));

    const restored = await history.restore(original, 'documents/doc-1.json');
    assert.ok(restored, 'restore must report a commit');

    const countAfterRestore = Number(git(history.repository, ['rev-list', '--count', 'HEAD']));

    // The content came back...
    assert.equal(git(history.repository, ['show', 'HEAD:documents/doc-1.json']), '{"v":1}');
    // ...and history GREW rather than shrank. This is the property that makes
    // the panel safe to experiment in: an undo can itself be undone.
    assert.equal(countAfterRestore, countAfterChange + 1);
    // The commit that was restored away from is still reachable.
    assert.equal(
      git(history.repository, ['cat-file', '-t', afterChange]),
      'commit',
      'the superseded commit must still exist',
    );
  });

  it('lists entries with their parsed action and document', async () => {
    const entries = await history.list({ limit: 100 });
    assert.ok(entries.length >= 4, 'expected the commits made above');

    const created = entries.find((entry) => entry.action === 'created');
    assert.ok(created, 'the created action must be parsed back out of the trailer');
    assert.equal(created.documentId, 'doc-1');

    const restored = entries.find((entry) => entry.action === 'restored');
    assert.ok(restored, 'the restored action must be parsed back out of the trailer');
  });

  it('derives the action filter from history that actually exists', async () => {
    const observed = await history.observedActions();
    const names = observed.map((entry) => entry.action);
    assert.ok(names.includes('created'));
    assert.ok(names.includes('restored'));
    // Nothing has been deleted, so that action must NOT appear. A hard-coded
    // list would offer a filter that can only ever return nothing.
    assert.ok(!names.includes('deleted'));
  });

  it('refuses to write outside its own repository', async () => {
    await assert.rejects(
      () =>
        history.record({
          action: 'updated',
          subject: 'Escape attempt',
          files: [{ relativePath: '../escaped.json', contents: 'no' }],
        }),
      /refusing to write outside/,
    );
  });

  it('rejects a commit identifier that is not one', async () => {
    await assert.rejects(() => history.diff('not-a-commit'), /not a commit identifier/);
  });

  it('reports health with a count git agrees with', async () => {
    const health = await history.health();
    assert.equal(health.available, true);
    assert.equal(health.reason, null);
    assert.equal(
      String(health.commitCount),
      git(history.repository, ['rev-list', '--count', 'HEAD']),
      'the reported count must match what git says',
    );
  });
});
