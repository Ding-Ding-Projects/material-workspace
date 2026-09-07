/**
 * Notes engine conformance.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Note,
  type NoteCollection,
  backlinks,
  displayTitle,
  extractLinks,
  extractTags,
  newNote,
  searchNotes,
  sortNotes,
  tagCounts,
  unresolvedLinks,
  wordCount,
} from '../../app/engines/notes/model';

function note(overrides: Partial<Note>): Note {
  return { ...newNote('2026-01-01T00:00:00.000Z'), ...overrides };
}

function collection(notes: Note[]): NoteCollection {
  return { schema: 'material-workspace/notes@1', notes };
}

// ---------------------------------------------------------------- titles --

test('a title is derived from the first heading, then any text', () => {
  // Requiring a title before a note can be written is the fastest way to make
  // somebody not write the note.
  assert.equal(displayTitle(note({ title: 'Explicit' })), 'Explicit');
  assert.equal(displayTitle(note({ body: '# From a heading\n\nbody' })), 'From a heading');
  assert.equal(displayTitle(note({ body: '\n\njust a line\nmore' })), 'just a line');
  assert.equal(displayTitle(note({})), 'Untitled note');
});

// ------------------------------------------------------------------ tags --

test('tags are read out of the body', () => {
  assert.deepEqual(extractTags('a #kitchen note about #dim-sum'), ['dim-sum', 'kitchen']);
});

test('a Chinese tag works', () => {
  // A word-character class matches only Latin letters and would silently drop
  // every tag in any other script — an omission invisible to whoever wrote it.
  assert.deepEqual(extractTags('筆記 #茶樓 #點心'), ['茶樓', '點心']);
});

test('a Markdown heading is not a tag, and neither is a colour', () => {
  // A heading's hash is followed by a space; a colour's hash is not preceded
  // by one when it sits inside a word.
  assert.deepEqual(extractTags('# Heading\n\nnot a tag'), []);
  assert.deepEqual(extractTags('color:#ff0000;'), []);
});

test('tags are counted across the collection, most common first', () => {
  const notes = collection([
    note({ tags: ['tea', 'food'] }),
    note({ tags: ['tea'] }),
    note({ tags: ['tea', 'food'] }),
    note({ tags: ['work'] }),
  ]);
  assert.deepEqual(tagCounts(notes), [
    { tag: 'tea', count: 3 },
    { tag: 'food', count: 2 },
    { tag: 'work', count: 1 },
  ]);
});

// ----------------------------------------------------------------- links --

test('links are read, including the piped display form', () => {
  assert.deepEqual(
    extractLinks('see [[Dim sum]] and [[Tea houses|the other note]]'),
    ['Dim sum', 'Tea houses'],
  );
});

test('backlinks are computed rather than stored', () => {
  // A stored list has to be updated on every edit of every other note, and the
  // one that gets missed is a link that silently stops existing.
  const target = note({ title: 'Dim sum' });
  const linking = note({ title: 'Lunch', body: 'we had [[Dim sum]]' });
  const unrelated = note({ title: 'Other', body: 'nothing here' });
  const found = backlinks(collection([target, linking, unrelated]), target);
  assert.deepEqual(found.map((n) => n.title), ['Lunch']);
});

test('a note does not link to itself through its own body', () => {
  const self = note({ title: 'Loop', body: 'see [[Loop]]' });
  assert.deepEqual(backlinks(collection([self]), self), []);
});

test('a link to a note that does not exist is reported, not treated as an error', () => {
  // It is the normal way a second note gets created.
  const one = note({ title: 'First', body: 'see [[Second]] and [[Third]]' });
  const two = note({ title: 'Second' });
  assert.deepEqual(unresolvedLinks(collection([one, two]), one), ['Third']);
});

// --------------------------------------------------------------- sorting --

test('a pinned note comes first in every order', () => {
  // Pinning means "keep this where I can see it"; an order that buries a
  // pinned note has ignored the only instruction the user gave.
  const pinned = note({ title: 'Zulu', pinned: true, updatedAt: '2020-01-01T00:00:00.000Z' });
  const recent = note({ title: 'Alpha', updatedAt: '2026-06-01T00:00:00.000Z' });

  for (const order of ['updated', 'created', 'title'] as const) {
    const sorted = sortNotes([recent, pinned], order);
    assert.equal(sorted[0]?.title, 'Zulu', 'pinned note was buried in ' + order + ' order');
  }
});

test('the default order is most recently updated first', () => {
  const older = note({ title: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' });
  const newer = note({ title: 'Newer', updatedAt: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual(
    sortNotes([older, newer], 'updated').map((n) => n.title),
    ['Newer', 'Older'],
  );
});

// ---------------------------------------------------------------- search --

test('search covers the title, the body and the tags', () => {
  const notes = collection([
    note({ title: 'Tea houses', body: 'about tea' }),
    note({ title: 'Other', body: 'mentions dumplings here' }),
    note({ title: 'Third', tags: ['kitchen'] }),
  ]);
  assert.equal(searchNotes(notes, { query: 'tea' }).length, 1);
  assert.equal(searchNotes(notes, { query: 'dumplings' }).length, 1);
  assert.equal(searchNotes(notes, { query: 'kitchen' }).length, 1);
});

test('a result carries the line the match was on, for a preview', () => {
  const notes = collection([
    note({ title: 'Long', body: 'first line\nthe needle is here\nlast line' }),
  ]);
  assert.equal(searchNotes(notes, { query: 'needle' })[0]?.excerpt, 'the needle is here');
});

test('regex search works, and a malformed pattern returns nothing rather than throwing', () => {
  // Somebody typing a pattern passes through several invalid states on the way
  // to a valid one. An exception on each keystroke makes the field unusable.
  const notes = collection([note({ title: 'abc123' }), note({ title: 'xyz' })]);
  assert.equal(searchNotes(notes, { query: '[a-c]+\\d+', useRegex: true }).length, 1);
  assert.doesNotThrow(() => searchNotes(notes, { query: '([unclosed', useRegex: true }));
  assert.deepEqual(searchNotes(notes, { query: '([unclosed', useRegex: true }), []);
});

test('a tag filter composes with the query rather than overriding it', () => {
  // The query deliberately does NOT collide with the tag name. The first
  // version of this test searched for "Tea" while filtering on the tag "tea",
  // and every tea-tagged note matched — through its tag, not its title. That
  // is correct behaviour and a useless test of composition.
  const notes = collection([
    note({ title: 'Har gow', tags: ['tea'] }),
    note({ title: 'Har gow elsewhere', tags: ['work'] }),
    note({ title: 'Siu mai', tags: ['tea'] }),
  ]);
  assert.deepEqual(
    searchNotes(notes, { query: 'Har gow', tag: 'tea' }).map((r) => r.note.title),
    ['Har gow'],
  );
});

test('searching a tag name finds the notes carrying it', () => {
  // The behaviour the test above had to be rewritten around, pinned here on
  // purpose so a later change to it is a decision rather than an accident.
  const notes = collection([
    note({ title: 'Nothing in the title', tags: ['tea'] }),
    note({ title: 'Also nothing', tags: ['work'] }),
  ]);
  assert.deepEqual(
    searchNotes(notes, { query: 'tea' }).map((r) => r.note.title),
    ['Nothing in the title'],
  );
});

test('an empty query returns everything, so the list is not blank on open', () => {
  const notes = collection([note({ title: 'a' }), note({ title: 'b' })]);
  assert.equal(searchNotes(notes, { query: '' }).length, 2);
  assert.equal(searchNotes(notes, { query: '   ' }).length, 2);
});

// ------------------------------------------------------------ word count --

test('CJK characters are counted individually, not as one word per paragraph', () => {
  // A Chinese sentence has no spaces, so splitting on whitespace counts a whole
  // paragraph as one word. Counting each character is what every Chinese word
  // processor does.
  assert.equal(wordCount('hello there world'), 3);
  assert.equal(wordCount('香港茶樓'), 4);
  // Mixed: three Latin words plus four characters.
  assert.equal(wordCount('I visited 香港茶樓'), 2 + 4);
});

test('an empty body counts as nothing', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   \n\n  '), 0);
});
