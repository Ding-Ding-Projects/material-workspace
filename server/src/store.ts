/**
 * The document vault: where a room's operation log survives a restart.
 *
 * Two failures are designed against, both of which look like nothing until the
 * day they are everything:
 *
 *   1. A CRASH MID-WRITE leaving a truncated file. Written to a unique
 *      temporary name and renamed into place, so a reader sees the old bytes
 *      or the new ones and never half of either.
 *   2. A RENAME REFUSED because something else has the destination open. On
 *      Windows a real-time scanner, an indexer or a sync client opens a file
 *      the moment it is written, and the rename then fails with EPERM. This
 *      server runs on Linux in its container, where that does not happen — but
 *      the same code is exercised by the suite on a developer's Windows
 *      machine, and a branch on platform would mean the shipped behaviour is
 *      not the tested behaviour. So the retry is unconditional.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { isValidRoomId, type LoggedOperation } from './rooms';

/** Transient rename failures. ENOENT and ENOSPC are not retried. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

let temporaryCounter = 0;

/**
 * Write bytes to a path so no reader ever sees a partial file.
 *
 * The temporary name is unique per call rather than a fixed `<file>.tmp`. Two
 * concurrent writers sharing one temporary name is a genuine data-loss bug:
 * one publishes the other's half-written bytes, or moves the temporary out
 * from under it and the loser fails with a confusing ENOENT.
 */
export async function writeAtomic(target: string, bytes: Buffer): Promise<void> {
  temporaryCounter += 1;
  const temporary = target + '.' + process.pid + '.' + temporaryCounter + '.tmp';

  await fs.writeFile(temporary, bytes);

  const deadline = Date.now() + 300;
  for (;;) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || Date.now() >= deadline) {
        // Never swallowed. A caller with a did-it-persist contract needs the
        // truth more than it needs a save that eventually lands.
        await fs.rm(temporary, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

export interface StoredRoom {
  readonly id: string;
  readonly operations: readonly LoggedOperation[];
  readonly savedAt: string;
}

export class Vault {
  constructor(private readonly root: string) {}

  async prepare(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /**
   * The file a room's log lives in.
   *
   * Validated rather than joined, because the id arrives from a client. The
   * check is `isValidRoomId`, the same one the room registry uses, so a shape
   * that is refused there cannot reach the filesystem through here either.
   */
  private pathFor(id: string): string {
    if (!isValidRoomId(id)) throw new Error('refusing an unusable document id');
    return path.join(this.root, id + '.log.json');
  }

  async save(id: string, operations: readonly LoggedOperation[]): Promise<void> {
    const payload: StoredRoom = { id, operations, savedAt: new Date().toISOString() };
    await writeAtomic(this.pathFor(id), Buffer.from(JSON.stringify(payload), 'utf8'));
  }

  /**
   * Read a room's log back.
   *
   * A missing file is an empty room, which is normal. A CORRUPT file is not
   * normal and is not silently treated as empty: returning an empty log there
   * would present a document that still exists on disk as a blank one, and the
   * client would then happily save the blank version over it.
   */
  async load(id: string): Promise<StoredRoom | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.pathFor(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('the stored log for ' + id + ' is corrupt and was not treated as empty');
    }

    const candidate = parsed as Partial<StoredRoom>;
    if (!Array.isArray(candidate.operations)) {
      throw new Error('the stored log for ' + id + ' is malformed and was not treated as empty');
    }
    return {
      id,
      operations: candidate.operations as LoggedOperation[],
      savedAt: candidate.savedAt ?? '',
    };
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((name) => name.endsWith('.log.json'))
      .map((name) => name.slice(0, -'.log.json'.length))
      .sort();
  }
}
