/**
 * Notes.
 *
 * A note is Markdown plus metadata. Not rich text, and that is the choice the
 * whole application rests on:
 *
 *   - MARKDOWN IS PORTABLE. A note written here opens in every editor anybody
 *     already uses, and survives this application being uninstalled. A
 *     proprietary rich-text blob does neither, and notes are exactly the kind
 *     of thing people keep for a decade.
 *   - IT IS DIFFABLE. The autosave history stores real text, so a version
 *     comparison shows the sentence that changed rather than a wall of markup.
 *   - IT IS SEARCHABLE WITHOUT PARSING. Which matters when a search runs over
 *     thousands of notes on every keystroke.
 *
 * Links between notes use the double-bracket form. Resolving them by TITLE
 * rather than by identifier is deliberate: a link is written by a person, and
 * a person writes the title. A link to a note that does not exist yet is not
 * an error — it is the normal way a second note gets created.
 */

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tags: readonly string[];
  /** A pinned note sorts above the rest, whatever the sort order. */
  readonly pinned: boolean;
}

export interface NoteCollection {
  readonly schema: 'material-workspace/notes@1';
  readonly notes: readonly Note[];
}

let counter = 0;

export function newNoteId(): string {
  counter += 1;
  return 'n' + counter.toString(36);
}

export function emptyCollection(): NoteCollection {
  return { schema: 'material-workspace/notes@1', notes: [] };
}

export function newNote(at: string, title = ''): Note {
  return {
    id: newNoteId(),
    title,
    body: '',
    createdAt: at,
    updatedAt: at,
    tags: [],
    pinned: false,
  };
}

/**
 * A note's title, derived when it has not been set.
 *
 * From the first heading, then the first non-empty line, then a placeholder.
 * Requiring a title before a note can be written is the single fastest way to
 * make somebody not write the note.
 */
export function displayTitle(note: Note): string {
  if (note.title.trim().length > 0) return note.title.trim();

  for (const line of note.body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const text = heading?.[1] ?? trimmed;
    return text.length > 80 ? text.slice(0, 77) + '...' : text;
  }
  return 'Untitled note';
}

const TAG_PATTERN = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/**
 * Tags, read out of the body.
 *
 * Unicode-aware, so a Chinese tag works. A word-character class would match
 * only Latin letters and silently drop every tag written in any other script,
 * which is the sort of omission that goes unnoticed by whoever wrote it.
 *
 * A hash must be preceded by whitespace or start the line, so a colour like
 * #ff0000 in a code fence is not a tag — and neither is a Markdown heading,
 * because a heading's hash is followed by a space.
 */
export function extractTags(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(TAG_PATTERN)) {
    const tag = match[1];
    if (tag !== undefined) found.add(tag.toLowerCase());
  }
  return [...found].sort();
}

const LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Every note this one links to, by title. */
export function extractLinks(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(LINK_PATTERN)) {
    const target = match[1]?.trim();
    if (target !== undefined && target.length > 0) found.add(target);
  }
  return [...found];
}

/**
 * Which notes link TO this one.
 *
 * Computed rather than stored. A stored backlink list has to be updated on
 * every edit of every other note, and the one that gets missed is a link that
 * silently stops existing.
 */
export function backlinks(collection: NoteCollection, note: Note): Note[] {
  const title = displayTitle(note).toLowerCase();
  return collection.notes.filter((candidate) => {
    if (candidate.id === note.id) return false;
    return extractLinks(candidate.body).some((link) => link.toLowerCase() === title);
  });
}

/** Links that point at no existing note. Not an error — an invitation. */
export function unresolvedLinks(collection: NoteCollection, note: Note): string[] {
  const titles = new Set(collection.notes.map((candidate) => displayTitle(candidate).toLowerCase()));
  return extractLinks(note.body).filter((link) => !titles.has(link.toLowerCase()));
}

export type SortOrder = 'updated' | 'created' | 'title';

/**
 * Sorted for display.
 *
 * Pinned notes come first in EVERY order, because pinning means "keep this
 * where I can see it" and an order that buries a pinned note has ignored the
 * only instruction the user gave.
 */
export function sortNotes(notes: readonly Note[], order: SortOrder): Note[] {
  const compare = (a: Note, b: Note): number => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (order === 'title') {
      return displayTitle(a).localeCompare(displayTitle(b), undefined, { sensitivity: 'base' });
    }
    const key = order === 'created' ? 'createdAt' : 'updatedAt';
    // Most recent first, which is what somebody looking for what they were
    // just working on expects.
    return b[key].localeCompare(a[key]);
  };
  return [...notes].sort(compare);
}

export interface SearchOptions {
  readonly query: string;
  readonly useRegex?: boolean;
  readonly tag?: string;
}

export interface SearchResult {
  readonly note: Note;
  /** The line the match was found on, for a preview. */
  readonly excerpt: string;
}

/**
 * Search across title, body and tags.
 *
 * A malformed regular expression returns NO results rather than throwing.
 * Somebody typing a pattern passes through several invalid states on the way
 * to a valid one, and an exception on each keystroke makes the field unusable.
 */
export function searchNotes(
  collection: NoteCollection,
  options: SearchOptions,
): SearchResult[] {
  const { query, useRegex = false, tag } = options;

  let matcher: (text: string) => boolean;
  if (query.trim().length === 0) {
    matcher = () => true;
  } else if (useRegex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, 'iu');
    } catch {
      return [];
    }
    matcher = (text) => pattern.test(text);
  } else {
    const needle = query.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(needle);
  }

  const results: SearchResult[] = [];
  for (const note of collection.notes) {
    if (tag !== undefined && !note.tags.includes(tag.toLowerCase())) continue;

    const title = displayTitle(note);
    if (matcher(title)) {
      results.push({ note, excerpt: firstLine(note.body) });
      continue;
    }

    const line = note.body.split('\n').find((candidate) => matcher(candidate));
    if (line !== undefined) {
      results.push({ note, excerpt: line.trim() });
      continue;
    }

    if (note.tags.some((candidate) => matcher(candidate))) {
      results.push({ note, excerpt: note.tags.map((t) => '#' + t).join(' ') });
    }
  }
  return results;
}

function firstLine(body: string): string {
  const line = body.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
}

/** Every tag in the collection, with how many notes carry it. */
export function tagCounts(collection: NoteCollection): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of collection.notes) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * The CJK range, as escapes rather than as literal boundary characters.
 *
 * U+3000 to U+9FFF covers CJK punctuation, kana and the unified ideographs;
 * U+F900 to U+FAFF covers the compatibility ideographs. Written literally,
 * those four boundary characters are indistinguishable from their
 * neighbours in any editor, so nobody can check the range by reading it.
 */
const CJK = /[\u3000-\u9fff\uf900-\ufaff]/gu;

/** Word count, counting CJK characters individually. */
export function wordCount(body: string): number {
  const withoutCjk = body.replace(CJK, ' ');
  const latin = withoutCjk.split(/\s+/u).filter((word) => word.length > 0).length;
  // A Chinese sentence has no spaces, so splitting on whitespace counts a
  // whole paragraph as one word. Each character is counted instead, which is
  // the convention every Chinese word processor uses.
  const cjk = (body.match(CJK) ?? []).length;
  return latin + cjk;
}
