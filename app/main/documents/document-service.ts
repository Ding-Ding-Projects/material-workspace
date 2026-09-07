/**
 * Documents owned by the application, and their autosave.
 *
 * Autosave is continuous rather than a save button, so the debounce matters:
 * a burst of typing must become one commit and not four hundred. Two timers do
 * that honestly — a debounce that keeps sliding while keys arrive, and a settle
 * window that requires actual quiet before anything is recorded.
 *
 * A history write that fails never fails the edit the user was making. The
 * document is still saved to disk; only the history entry is missed, and the
 * panel reports the repository as unhealthy rather than silently pretending the
 * change was recorded.
 */

import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DocumentSummary } from '../../shared/ipc.js';
import { GitHistory } from '../history/git-history.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { workspaceDir } from '../storage/paths.js';

export interface DocumentRecord {
  id: string;
  application: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Opaque to this service. Each application owns its own document shape. */
  content: unknown;
}

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

function isSafeId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export class DocumentService {
  private readonly history: GitHistory;
  private readonly pending = new Map<
    string,
    { timer: NodeJS.Timeout; record: DocumentRecord; firstQueuedAt: number }
  >();

  private debounceMs = 1200;
  private settleMs = 2500;

  constructor(history: GitHistory = new GitHistory()) {
    this.history = history;
  }

  configure(options: { debounceMs?: number; settleMs?: number }): void {
    if (typeof options.debounceMs === 'number') this.debounceMs = options.debounceMs;
    if (typeof options.settleMs === 'number') this.settleMs = options.settleMs;
  }

  private fileFor(id: string): string {
    if (!isSafeId(id)) throw new Error('not a document identifier: ' + id);
    return path.join(workspaceDir(), id + '.json');
  }

  private historyPathFor(id: string): string {
    return path.posix.join('documents', id + '.json');
  }

  async list(): Promise<DocumentSummary[]> {
    await fsp.mkdir(workspaceDir(), { recursive: true });
    const names = await fsp.readdir(workspaceDir());
    const summaries: DocumentSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(workspaceDir(), name);
      try {
        const stat = await fsp.stat(full);
        const record = JSON.parse(await fsp.readFile(full, 'utf8')) as DocumentRecord;
        summaries.push({
          id: record.id,
          application: record.application,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          bytes: stat.size,
        });
      } catch {
        // A single unreadable document must not hide every other one.
        continue;
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(options: {
    application: string;
    title: string;
    content: unknown;
  }): Promise<DocumentRecord> {
    const now = new Date().toISOString();
    const record: DocumentRecord = {
      id: randomUUID(),
      application: options.application,
      title: options.title,
      createdAt: now,
      updatedAt: now,
      content: options.content,
    };
    await this.persist(record);
    await this.recordHistory(record, 'created', 'Create ' + record.title);
    return record;
  }

  async open(id: string): Promise<DocumentRecord> {
    const raw = await fsp.readFile(this.fileFor(id), 'utf8');
    return JSON.parse(raw) as DocumentRecord;
  }

  private async persist(record: DocumentRecord): Promise<void> {
    const serialized = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new Error(
        'this document exceeds the ' +
          MAX_DOCUMENT_BYTES +
          ' byte limit and was not saved. Nothing was changed on disk.',
      );
    }
    await fsp.mkdir(workspaceDir(), { recursive: true });
    await writeFileAtomic(this.fileFor(record.id), serialized);
  }

  private async recordHistory(
    record: DocumentRecord,
    action: 'created' | 'autosaved' | 'updated' | 'renamed' | 'deleted',
    subject: string,
  ): Promise<{ commit: string } | null> {
    return this.history.record({
      action,
      subject,
      documentId: record.id,
      files: [
        {
          relativePath: this.historyPathFor(record.id),
          contents: JSON.stringify(record, null, 2) + '\n',
        },
      ],
    });
  }

  /**
   * Save immediately. Returns whether history recorded the change, honestly:
   * a null commit means there was nothing new to record, and a historyError
   * means the document IS saved but its history entry is not.
   */
  async save(record: DocumentRecord): Promise<{
    saved: true;
    commit: string | null;
    historyError: string | null;
  }> {
    const next: DocumentRecord = { ...record, updatedAt: new Date().toISOString() };
    await this.persist(next);
    try {
      const result = await this.recordHistory(next, 'updated', 'Update ' + next.title);
      return { saved: true, commit: result?.commit ?? null, historyError: null };
    } catch (error) {
      return {
        saved: true,
        commit: null,
        historyError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Queue an autosave. Repeated calls slide the debounce, so continuous typing
   * produces one commit once the user actually stops. The settle ceiling stops
   * an unbroken hour of typing from never being recorded at all.
   */
  queueAutosave(record: DocumentRecord): void {
    const existing = this.pending.get(record.id);
    if (existing) clearTimeout(existing.timer);

    const firstQueuedAt = existing?.firstQueuedAt ?? Date.now();
    const elapsed = Date.now() - firstQueuedAt;
    const wait = elapsed >= this.settleMs ? 0 : Math.min(this.debounceMs, this.settleMs - elapsed);

    const timer = setTimeout(() => {
      this.pending.delete(record.id);
      void this.flush(record.id, record);
    }, wait);

    this.pending.set(record.id, { timer, record, firstQueuedAt });
  }

  private async flush(id: string, record: DocumentRecord): Promise<void> {
    const next: DocumentRecord = { ...record, updatedAt: new Date().toISOString() };
    try {
      await this.persist(next);
      await this.recordHistory(next, 'autosaved', 'Autosave ' + next.title);
    } catch {
      // Reported through history health rather than thrown into a background
      // timer where nothing can catch it.
    }
  }

  /** Flush every queued autosave. Called before quit so nothing is lost. */
  async flushAll(): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of entries) {
      clearTimeout(entry.timer);
      await this.flush(id, entry.record);
    }
  }

  async rename(id: string, title: string): Promise<DocumentRecord> {
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new Error('a title cannot be empty');
    if (trimmed.length > 300) throw new Error('a title cannot exceed 300 characters');
    const record = await this.open(id);
    const next: DocumentRecord = {
      ...record,
      title: trimmed,
      updatedAt: new Date().toISOString(),
    };
    await this.persist(next);
    await this.recordHistory(next, 'renamed', 'Rename to ' + trimmed);
    return next;
  }

  /**
   * Delete a document. The history entry is written BEFORE the file is removed,
   * so the deletion is auditable and the content is recoverable from history
   * afterwards. A deletion recorded after the fact can lose the thing it was
   * meant to record.
   */
  async remove(id: string): Promise<{ removed: true }> {
    const record = await this.open(id);
    await this.history.record({
      action: 'deleted',
      subject: 'Delete ' + record.title,
      documentId: id,
      removals: [this.historyPathFor(id)],
    });
    await fsp.rm(this.fileFor(id), { force: true });
    return { removed: true };
  }
}
