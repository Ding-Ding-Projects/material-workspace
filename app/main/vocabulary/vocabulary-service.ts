/**
 * The local personal-vocabulary loader.
 *
 * What this does: lets a user supply their own JSON file of word replacements,
 * applied only at the user-facing text boundary, entirely on this machine.
 *
 * What this deliberately does NOT do, and must never be changed to do:
 *
 *   - Ship any mappings. There are no built-in entries, no samples, no
 *     templates, no defaults and no guesses. Until the user supplies a valid
 *     file, every surface renders its original shipped wording, unchanged. The
 *     upload control is always visible; that visibility is not permission to
 *     invent content for it.
 *
 *   - Touch the network. No fetch, no upload, no telemetry, no sync. Parsing,
 *     validation, replacement and caching happen here and nowhere else.
 *
 *   - Persist the source path or the file's contents anywhere except the
 *     validated private cache. Not in settings, not in logs, not in exports, not
 *     in history snapshots, not in crash reports, not in captures.
 *
 * Validation is fail-closed and total: a file that fails any check applies
 * NOTHING. A partial application would leave the interface in a state that
 * matches no file the user has ever seen.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { cacheDir } from '../storage/paths.js';
import { writeFileAtomic } from '../storage/atomic-file.js';

/** The bounds are part of the published contract, so they live in code rather
 *  than in somebody's memory of what felt reasonable. */
export const VOCABULARY_LIMITS = {
  maxFileBytes: 512 * 1024,
  maxEntries: 5000,
  maxKeyLength: 200,
  maxValueLength: 400,
  maxNestingDepth: 3,
  supportedSchemaVersions: [1] as const,
} as const;

export interface VocabularyState {
  loaded: boolean;
  entryCount: number;
  schemaVersion: number | null;
  /** Present only when a load was refused, and phrased so it names the rule
   *  broken without echoing any content from the file. */
  refusedReason: string | null;
}

interface VocabularyCache {
  schemaVersion: number;
  entries: Record<string, string>;
}

const CACHE_FILE = (): string => path.join(cacheDir(), 'personal-vocabulary.cache.json');

class VocabularyRefusal extends Error {}

function refuse(reason: string): never {
  throw new VocabularyRefusal(reason);
}

/**
 * Detect a repeated key inside any single JSON object in the text.
 *
 * A scanner rather than a regular expression, because a key can legitimately
 * contain a colon, a brace, or an escaped quote, and a pattern that bridges two
 * tokens with a lazy any-character run will happily reach past the object it was
 * written for and match something in an entirely different one.
 *
 * Returns true on the first duplicate found. Malformed input simply returns
 * false and is reported by JSON.parse a moment later, which produces a clearer
 * message than this function could.
 */
function hasDuplicateKeys(text: string): boolean {
  // The container stack tracks WHICH KIND of container we are inside, not just
  // that we are inside one. Without that, a comma inside an array reads as "the
  // next string is a key", and ["a","a"] is reported as a duplicate key when it
  // is a perfectly ordinary array.
  type Frame = { kind: 'object'; keys: Set<string> } | { kind: 'array' };
  const stack: Frame[] = [];
  let index = 0;
  let expectingKey = false;

  const readString = (): string | null => {
    // Caller guarantees text[index] === '"'.
    index += 1;
    let value = '';
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        value += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        return value;
      }
      value += character;
      index += 1;
    }
    return null;
  };

  while (index < text.length) {
    const character = text[index];

    if (character === '"') {
      const value = readString();
      if (value === null) return false;
      const frame = stack[stack.length - 1];
      if (expectingKey && frame && frame.kind === 'object') {
        if (frame.keys.has(value)) return true;
        frame.keys.add(value);
      }
      expectingKey = false;
      continue;
    }

    if (character === '{') {
      stack.push({ kind: 'object', keys: new Set<string>() });
      expectingKey = true;
    } else if (character === '[') {
      stack.push({ kind: 'array' });
      expectingKey = false;
    } else if (character === '}' || character === ']') {
      stack.pop();
      expectingKey = false;
    } else if (character === ',') {
      // Only an object's comma introduces a key.
      expectingKey = stack[stack.length - 1]?.kind === 'object';
    } else if (character === ':') {
      expectingKey = false;
    }
    index += 1;
  }

  return false;
}

function measureDepth(value: unknown, depth = 1): number {
  if (typeof value !== 'object' || value === null) return depth;
  let deepest = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, measureDepth(child, depth + 1));
  }
  return deepest;
}

/**
 * Validate raw bytes into a cache payload. Every rejection names the rule, never
 * the offending content: an error message is a surface, and echoing a private
 * term into one would leak exactly what this feature exists to keep local.
 */
export function validateVocabularyBytes(bytes: Buffer): VocabularyCache {
  if (bytes.byteLength === 0) refuse('the file is empty');
  if (bytes.byteLength > VOCABULARY_LIMITS.maxFileBytes) {
    refuse(
      'the file is larger than the ' +
        VOCABULARY_LIMITS.maxFileBytes +
        ' byte limit, so nothing was applied',
    );
  }

  const text = bytes.toString('utf8');

  // JSON.parse silently keeps the LAST of a duplicated key, so by the time we
  // have an object the duplicate is gone and unknowable. It has to be caught on
  // the raw text, before parsing.
  if (hasDuplicateKeys(text)) {
    refuse('the file declares the same entry name more than once, so nothing was applied');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse('the file is not valid JSON, so nothing was applied');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse('the file must contain a JSON object, so nothing was applied');
  }
  const root = parsed as Record<string, unknown>;

  const allowedRootKeys = new Set(['schemaVersion', 'entries']);
  for (const key of Object.keys(root)) {
    if (!allowedRootKeys.has(key)) {
      refuse('the file contains a field this version does not recognise, so nothing was applied');
    }
  }

  const schemaVersion = root.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    refuse('the file does not declare a whole-number schema version, so nothing was applied');
  }
  if (!(VOCABULARY_LIMITS.supportedSchemaVersions as readonly number[]).includes(schemaVersion)) {
    refuse(
      'the file declares schema version ' +
        schemaVersion +
        ', which this version does not support, so nothing was applied',
    );
  }

  const entries = root.entries;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    refuse('the file has no entries object, so nothing was applied');
  }
  if (measureDepth(root) > VOCABULARY_LIMITS.maxNestingDepth) {
    refuse('the file nests deeper than this version allows, so nothing was applied');
  }

  const table = entries as Record<string, unknown>;
  const keys = Object.keys(table);
  if (keys.length === 0) refuse('the file declares no entries, so nothing was applied');
  if (keys.length > VOCABULARY_LIMITS.maxEntries) {
    refuse(
      'the file declares more than ' + VOCABULARY_LIMITS.maxEntries + ' entries, so nothing was applied',
    );
  }

  const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
  const normalised: Record<string, string> = Object.create(null);
  for (const key of keys) {
    if (unsafeKeys.has(key)) {
      refuse('the file uses a reserved object key, so nothing was applied');
    }
    if (key.length === 0 || key.length > VOCABULARY_LIMITS.maxKeyLength) {
      refuse(
        'the file contains an entry name outside the 1 to ' +
          VOCABULARY_LIMITS.maxKeyLength +
          ' character range, so nothing was applied',
      );
    }
    const value = table[key];
    if (typeof value !== 'string') {
      refuse('every replacement must be a string, so nothing was applied');
    }
    if (value.length > VOCABULARY_LIMITS.maxValueLength) {
      refuse(
        'the file contains a replacement longer than ' +
          VOCABULARY_LIMITS.maxValueLength +
          ' characters, so nothing was applied',
      );
    }
    normalised[key] = value;
  }

  return { schemaVersion, entries: normalised };
}

export class VocabularyService {
  private cache: VocabularyCache | null = null;
  private refusedReason: string | null = null;

  /** Revalidate the private cache on every load. A cache that was valid when it
   *  was written is not necessarily valid against the current bounds. */
  async initialise(): Promise<void> {
    try {
      const bytes = await fsp.readFile(CACHE_FILE());
      this.cache = validateVocabularyBytes(bytes);
      this.refusedReason = null;
    } catch (error) {
      this.cache = null;
      this.refusedReason =
        error instanceof VocabularyRefusal
          ? 'the saved vocabulary could not be used (' + error.message + ')'
          : null;
    }
  }

  state(): VocabularyState {
    return {
      loaded: this.cache !== null,
      entryCount: this.cache ? Object.keys(this.cache.entries).length : 0,
      schemaVersion: this.cache?.schemaVersion ?? null,
      refusedReason: this.refusedReason,
    };
  }

  /**
   * Load from bytes the renderer read from a user-chosen file. The path is never
   * received here and is never stored: the renderer sends contents, not a
   * location, so there is nothing to leak into a log or a settings file.
   */
  async load(bytes: Buffer): Promise<VocabularyState> {
    try {
      const validated = validateVocabularyBytes(bytes);
      await writeFileAtomic(CACHE_FILE(), JSON.stringify(validated));
      this.cache = validated;
      this.refusedReason = null;
    } catch (error) {
      // The previous cache stays active: a rejected file changes nothing.
      this.refusedReason =
        error instanceof VocabularyRefusal ? error.message : 'the file could not be read';
    }
    return this.state();
  }

  /** Clear purges the cache and restores original wording immediately. */
  async clear(): Promise<VocabularyState> {
    await fsp.rm(CACHE_FILE(), { force: true });
    this.cache = null;
    this.refusedReason = null;
    return this.state();
  }

  /** The active table, for the renderer's text boundary. Empty when nothing is
   *  loaded, which renders original shipped wording. */
  entries(): Record<string, string> {
    return this.cache ? { ...this.cache.entries } : {};
  }
}
