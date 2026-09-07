/**
 * A small, bounded, atomically-written JSON store.
 *
 * Every persisted surface in this application goes through here, so the Windows
 * rename retry and the size bounds are decided once rather than re-argued at
 * twenty call sites. A store written next year gets the correct behaviour
 * because this is the only route, not because its author remembered.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.js';

export interface JsonStoreOptions<T> {
  /** Absolute path to the backing file. */
  file: string;
  /** Returned when the file is absent, empty, unparseable or fails validation. */
  fallback: () => T;
  /** Validate and normalise. Throw to reject; the fallback is then used. */
  validate: (value: unknown) => T;
  /** Hard ceiling on the serialized payload. Refuses rather than truncates. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export class JsonStore<T> {
  readonly file: string;

  private readonly fallback: () => T;
  private readonly validate: (value: unknown) => T;
  private readonly maxBytes: number;

  /** Serializes writes so two callers cannot interleave read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve();

  private cache: T | null = null;
  private loadFailure: string | null = null;

  constructor(options: JsonStoreOptions<T>) {
    this.file = options.file;
    this.fallback = options.fallback;
    this.validate = options.validate;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** The reason the last load fell back, or null. Surfaces honestly in the UI
   *  rather than letting a corrupt file look like a fresh install. */
  get lastLoadFailure(): string | null {
    return this.loadFailure;
  }

  async read(): Promise<T> {
    if (this.cache !== null) return this.cache;

    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.loadFailure = 'could not be read (' + code + ')';
      }
      this.cache = this.fallback();
      return this.cache;
    }

    if (raw.length > this.maxBytes) {
      this.loadFailure = 'exceeded the ' + this.maxBytes + ' byte limit';
      this.cache = this.fallback();
      return this.cache;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.loadFailure = 'was not valid JSON';
      this.cache = this.fallback();
      return this.cache;
    }

    try {
      this.cache = this.validate(parsed);
      this.loadFailure = null;
    } catch (error) {
      this.loadFailure =
        'failed validation: ' + (error instanceof Error ? error.message : String(error));
      this.cache = this.fallback();
    }
    return this.cache;
  }

  /** Read-modify-write, serialized. The mutation receives the current value and
   *  returns the next one; it must not mutate in place. */
  async update(mutate: (current: T) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const next = this.validate(mutate(current));
      const serialized = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
        throw new Error(
          'refusing to write ' +
            path.basename(this.file) +
            ': the result exceeds the ' +
            this.maxBytes +
            ' byte limit. Nothing was changed.',
        );
      }
      await writeFileAtomic(this.file, serialized);
      this.cache = next;
      this.loadFailure = null;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async write(value: T): Promise<T> {
    return this.update(() => value);
  }

  /** Drop the in-memory copy so the next read hits disk. Used by tests and by
   *  the recovery route; never as a substitute for validation. */
  invalidate(): void {
    this.cache = null;
  }
}
