/**
 * Atomic file replacement that survives Windows.
 *
 * The usual pattern — write a temp file, rename it over the target — is correct
 * on POSIX, where rename(2) replaces the destination unconditionally. On Windows
 * it is not sufficient, and the gap is the expensive kind: silent data loss that
 * happens intermittently and MORE often on well-protected machines.
 *
 * MoveFileEx fails with a sharing violation whenever the DESTINATION is open by
 * anyone at that instant. Not held open for long — merely opened. The culprits
 * are ordinary, which is why this is common rather than theoretical:
 *
 *   - the real-time antivirus scanner opening the file it just watched us write
 *   - the search indexer doing the same
 *   - a backup or sync client holding a read handle over the user profile
 *   - two of our own concurrent writers racing their renames onto one target
 *
 * Node surfaces that as EPERM, sometimes EACCES or EBUSY. The save throws and
 * the data is gone.
 *
 * Two properties make the fix safe:
 *
 *   1. Each attempt is still ONE indivisible rename, so retrying cannot tear a
 *      write. It only tries again once whoever held the destination let go, and
 *      the scanner windows are milliseconds.
 *   2. The temp name is unique per call. A fixed <file>.tmp shared by concurrent
 *      writers lets one writer publish another's half-written bytes, or move the
 *      temp out from under it so the loser fails with a confusing ENOENT.
 *
 * Deliberately NOT branched on platform, so the behaviour under test on a
 * developer machine is the behaviour shipped to a user on Windows.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** Codes worth retrying. ENOENT means the temp vanished — a caller bug, where
 *  retrying only delays a clearer error. ENOSPC will not improve by waiting. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const MAX_ATTEMPTS = 12;
const BASE_DELAY_MS = 8;
const MAX_DELAY_MS = 60;

let temporaryCounter = 0;

function nextTemporaryPath(target: string): string {
  temporaryCounter += 1;
  const unique = process.pid.toString(36) + '-' + temporaryCounter.toString(36);
  return path.join(
    path.dirname(target),
    '.' + path.basename(target) + '.' + unique + '.tmp',
  );
}

function delayFor(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.max(1, attempt));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

/**
 * Rename with a bounded retry. Never retries forever, and never swallows the
 * final error — callers commonly have a did-it-persist contract, and that
 * contract is worth more than a save that eventually lands.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransient(error)) throw error;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(delayFor(attempt));
    }
  }
  const code = (lastError as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
  const wrapped = new Error(
    'could not replace ' +
      to +
      ' after ' +
      MAX_ATTEMPTS +
      ' attempts (last code ' +
      code +
      '). Something is holding the destination open.',
  );
  (wrapped as NodeJS.ErrnoException).code = code;
  (wrapped as { cause?: unknown }).cause = lastError;
  throw wrapped;
}

/** Replace a file's contents atomically. Creates parent directories. */
export async function writeFileAtomic(
  target: string,
  contents: string | Uint8Array,
): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = nextTemporaryPath(target);
  try {
    const handle = await fsp.open(temporary, 'w');
    try {
      await handle.writeFile(contents);
      // Flush before the rename, or a crash can publish a name pointing at
      // bytes that never reached the platter.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Synchronous variant, for the small number of paths that genuinely cannot await. */
export function writeFileAtomicSync(target: string, contents: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = nextTemporaryPath(target);
  try {
    const descriptor = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        fs.renameSync(temporary, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransient(error)) throw error;
        if (attempt === MAX_ATTEMPTS) break;
        // Busy-wait deliberately: this path is rare, short, and must not yield.
        const until = Date.now() + delayFor(attempt);
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
    throw lastError;
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* the original error is the one that matters */
    }
    throw error;
  }
}
