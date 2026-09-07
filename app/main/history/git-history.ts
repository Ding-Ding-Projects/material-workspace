/**
 * Document history, backed by a real Git repository that this application owns.
 *
 * Design rules, each of which exists because the obvious alternative is worse:
 *
 *   - The repository is ISOLATED and lives beside the application's own data
 *     directory. Never a .git inside a folder the user owns. A history that
 *     plants itself in somebody's Documents folder is a surprise at best and a
 *     conflict with their own version control at worst.
 *
 *   - History is APPEND-ONLY. Restoring writes a NEW commit; it never rewinds,
 *     resets or rewrites. That is what makes the history panel safe to
 *     experiment in — an undo can be undone, and that undo undone in turn. A
 *     destructive restore that discards the branch it replaced is the single
 *     failure mode that makes a history panel unsafe to use.
 *
 *   - Nothing here is pushed or synced by default.
 *
 *   - Every command names its exit code and stderr on failure. A history write
 *     that fails must never fail the operation the user actually asked for;
 *     callers log it and carry on, and the panel reports the repository as
 *     unhealthy rather than as empty.
 *
 * A note on testing, because this module is exactly the shape that gets tested
 * wrongly: it has a small pure half and a large subprocess half. Tests that
 * cover only the pure half can be elegant, thorough, and prove nothing at all
 * about whether a single commit was ever created. The suite for this file runs
 * the real git binary against a real temporary repository and asserts through an
 * INDEPENDENT git invocation, never by believing this module's own report of its
 * own success.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HistoryAction, HistoryEntry, HistoryHealth } from '../../shared/ipc.js';
import { historyRepoDir } from '../storage/paths.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { resolveGit } from './git-executable.js';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

const COMMIT_IDENTITY = {
  name: 'Material Workspace',
  email: 'history@material-workspace.invalid',
};

/**
 * Separators for the log format. ASCII unit (0x1F) and record (0x1E)
 * separators are used because they cannot occur in a commit subject, unlike
 * every printable character somebody might reasonably type.
 *
 * Written as explicit escapes rather than literal control characters. A
 * literal separator is invisible in a diff and in most editors, so a tool that
 * strips unprintables turns it into the empty string — and an empty separator
 * makes every parse below return one giant field, silently, with no error.
 */
const FIELD = '\u001f';
const RECORD = '\u001e';

export class GitHistory {
  readonly repository: string;

  private initialised = false;
  private unavailableReason: string | null = null;

  constructor(repository: string = historyRepoDir()) {
    this.repository = repository;
  }

  private run(args: string[], options: { cwd?: string } = {}): Promise<GitResult> {
    return new Promise((resolve) => {
      const resolved = resolveGit();
      if (!resolved.command) {
        resolve({ status: -1, stdout: '', stderr: resolved.reason ?? 'git is unavailable' });
        return;
      }
      const child = spawn(resolved.command, args, {
        cwd: options.cwd ?? this.repository,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
          GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
          GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
          GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
        },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        resolve({ status: -1, stdout: '', stderr: String(error) });
      });
      child.on('close', (code) => {
        resolve({ status: code ?? -1, stdout, stderr });
      });
    });
  }

  /** Throwing variant, for the places where a failure genuinely must stop. */
  private async mustRun(args: string[]): Promise<string> {
    const result = await this.run(args);
    if (result.status !== 0) {
      throw new Error(
        'git ' + args.join(' ') + ' exited ' + result.status + ': ' + result.stderr.trim(),
      );
    }
    return result.stdout;
  }

  async ensureRepository(): Promise<void> {
    if (this.initialised) return;

    const resolved = resolveGit();
    if (!resolved.command) {
      this.unavailableReason = resolved.reason ?? 'git is unavailable';
      throw new Error(this.unavailableReason);
    }

    await fsp.mkdir(this.repository, { recursive: true });

    const inside = await this.run(['rev-parse', '--is-inside-work-tree']);
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
      await this.mustRun(['init', '--quiet', '--initial-branch=main']);
      // Local identity only. Never global: a checkout this application does not
      // own must never be re-attributed behind somebody's back.
      await this.mustRun(['config', 'user.name', COMMIT_IDENTITY.name]);
      await this.mustRun(['config', 'user.email', COMMIT_IDENTITY.email]);
      await this.mustRun(['config', 'core.autocrlf', 'false']);
      await this.mustRun(['config', 'gc.auto', '0']);

      await writeFileAtomic(
        path.join(this.repository, 'README.md'),
        [
          '# Material Workspace document history',
          '',
          'This repository is created and owned by Material Workspace. It records an',
          'append-only history of the documents you edit, so any change can be reviewed',
          'and undone.',
          '',
          'It is local. Nothing here is pushed or synchronised anywhere unless you',
          'explicitly ask for it.',
          '',
          'Restoring an earlier version adds a NEW commit rather than rewriting history,',
          'so an undo can itself be undone.',
          '',
        ].join('\n'),
      );
      await this.mustRun(['add', '--', 'README.md']);
      await this.mustRun([
        'commit',
        '--quiet',
        '-m',
        'Create the document history repository',
      ]);
    }

    this.initialised = true;
    this.unavailableReason = null;
  }

  /** True when the index holds staged changes. Note the command: there is no
   *  `git status --porcelain --cached`; that combination exits 129. */
  private async hasStagedChanges(): Promise<boolean> {
    const result = await this.run(['diff', '--cached', '--name-only']);
    return result.status === 0 && result.stdout.trim().length > 0;
  }

  /**
   * Record one action. Returns the new commit, or null when there was genuinely
   * nothing to record — an unchanged state records nothing, so the panel stays a
   * list of real events rather than a list of times somebody pressed a key.
   */
  async record(options: {
    action: HistoryAction;
    subject: string;
    documentId?: string | null;
    files?: { relativePath: string; contents: string | Uint8Array }[];
    removals?: string[];
  }): Promise<{ commit: string } | null> {
    await this.ensureRepository();

    for (const file of options.files ?? []) {
      const target = path.join(this.repository, file.relativePath);
      if (!target.startsWith(this.repository + path.sep)) {
        throw new Error('refusing to write outside the history repository: ' + file.relativePath);
      }
      await writeFileAtomic(target, file.contents);
      await this.mustRun(['add', '--', file.relativePath]);
    }

    for (const removal of options.removals ?? []) {
      const result = await this.run(['rm', '--quiet', '--ignore-unmatch', '--', removal]);
      if (result.status !== 0) {
        throw new Error('could not remove ' + removal + ': ' + result.stderr.trim());
      }
    }

    if (!(await this.hasStagedChanges())) return null;

    const trailer =
      'Workspace-Action: ' +
      options.action +
      (options.documentId ? '\nWorkspace-Document: ' + options.documentId : '');
    const message = options.subject + '\n\n' + trailer + '\n';

    await this.mustRun(['commit', '--quiet', '-m', message]);
    const commit = (await this.mustRun(['rev-parse', 'HEAD'])).trim();
    return { commit };
  }

  async list(query: { limit?: number; since?: string; until?: string; actions?: HistoryAction[] } = {}): Promise<
    HistoryEntry[]
  > {
    await this.ensureRepository();

    const format = ['%H', '%h', '%aI', '%s', '%b'].join(FIELD) + RECORD;
    const args = ['log', '--no-color', '--pretty=format:' + format];
    if (query.limit && query.limit > 0) args.push('--max-count=' + Math.min(query.limit, 5000));
    if (query.since) args.push('--since=' + query.since);
    if (query.until) args.push('--until=' + query.until);

    const output = await this.mustRun(args);
    const wanted = query.actions && query.actions.length > 0 ? new Set(query.actions) : null;

    const entries: HistoryEntry[] = [];
    for (const record of output.split(RECORD)) {
      const trimmed = record.trim();
      if (trimmed.length === 0) continue;
      const [commit = '', shortCommit = '', at = '', subject = '', body = ''] =
        trimmed.split(FIELD);

      const actionMatch = /^Workspace-Action:[ \t]*(\S+)$/m.exec(body);
      const documentMatch = /^Workspace-Document:[ \t]*(\S+)$/m.exec(body);
      const labelMatch = /^Workspace-Label:[ \t]*(.+)$/m.exec(body);
      const action = (actionMatch?.[1] ?? 'updated') as HistoryAction;

      if (wanted && !wanted.has(action)) continue;

      entries.push({
        commit,
        shortCommit,
        action,
        subject,
        documentId: documentMatch?.[1] ?? null,
        at,
        label: labelMatch?.[1]?.trim() ?? null,
      });
    }
    return entries;
  }

  /** The set of actions actually present, so the panel's action filter is
   *  derived from real history rather than from a hard-coded list that drifts. */
  async observedActions(): Promise<{ action: HistoryAction; count: number }[]> {
    const entries = await this.list({ limit: 5000 });
    const counts = new Map<HistoryAction, number>();
    for (const entry of entries) counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
    return [...counts.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count);
  }

  async diff(commit: string): Promise<string> {
    await this.ensureRepository();
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('not a commit identifier: ' + commit);
    // The separator form, never rev:path, so nothing has to survive shell path
    // conversion on Windows.
    return this.mustRun(['show', '--no-color', '--stat', '--patch', commit]);
  }

  async readAtCommit(commit: string, relativePath: string): Promise<string> {
    await this.ensureRepository();
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('not a commit identifier: ' + commit);
    return this.mustRun(['show', commit + ':' + relativePath]);
  }

  /**
   * Restore a file as it was at a commit, by writing a NEW commit on top.
   * Nothing is rewound and nothing is lost.
   */
  async restore(commit: string, relativePath: string): Promise<{ commit: string } | null> {
    const contents = await this.readAtCommit(commit, relativePath);
    return this.record({
      action: 'restored',
      subject: 'Restore ' + relativePath + ' as it was at ' + commit.slice(0, 8),
      files: [{ relativePath, contents }],
    });
  }

  /** Attach a label as its own commit, keeping history append-only. */
  async label(commit: string, label: string): Promise<{ commit: string } | null> {
    await this.ensureRepository();
    const trimmed = label.trim();
    if (trimmed.length === 0) throw new Error('a label cannot be empty');
    if (trimmed.length > 200) throw new Error('a label cannot exceed 200 characters');
    const notePath = path.join('labels', commit.slice(0, 12) + '.txt');
    return this.record({
      action: 'label-added',
      subject: 'Label ' + commit.slice(0, 8) + ': ' + trimmed,
      files: [{ relativePath: notePath, contents: trimmed + '\n' }],
    });
  }

  async health(): Promise<HistoryHealth> {
    try {
      await this.ensureRepository();
    } catch (error) {
      return {
        available: false,
        repositoryPath: this.repository,
        commitCount: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const count = await this.run(['rev-list', '--count', 'HEAD']);
    return {
      available: true,
      repositoryPath: this.repository,
      commitCount: count.status === 0 ? Number.parseInt(count.stdout.trim(), 10) : null,
      reason: null,
    };
  }
}
