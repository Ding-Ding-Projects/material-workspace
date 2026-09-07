# Notes

**Status: built and verified.** 19 engine tests plus 23 checks driven against
the real built window. The fourth of the nine applications to exist.

## A note is Markdown, not rich text

That is the choice the whole application rests on, and it buys three things:

- **Portability.** A note written here opens in every editor anybody already
  uses, and survives this application being uninstalled. Notes are exactly the
  kind of thing people keep for a decade; a proprietary blob is not.
- **Diffable history.** The autosave history stores real text, so comparing two
  versions shows the sentence that changed rather than a wall of markup.
- **Search without parsing**, which matters when search runs over thousands of
  notes on every keystroke.

## A note needs no title

The title comes from the first heading, then from the first non-empty line,
then from a placeholder. Requiring a title before a note can be written is the
single fastest way to make somebody not write the note.

The title box shows the derived title as its placeholder, so the box and the
list never appear to disagree about which note is open. That defect shipped and
was caught by looking at a capture: the box read "Untitled note" beside a list
that plainly read "Tea houses".

## Tags

Written inline with a hash. They become filters, counted and sorted by how
common they are; clicking the active one clears the filter, so there is always
a way back without hunting for a separate control.

Tag matching is **Unicode-aware**, so `#茶樓` is a tag. A word-character class
matches only Latin letters and would silently drop every tag written in any
other script — the sort of omission that is invisible to whoever wrote it.

A Markdown heading is not a tag, because its hash is followed by a space. A
colour like `#ff0000` is not a tag either.

## Links, and the notes that do not exist yet

`[[Double brackets]]` link to another note **by title**, because a link is
written by a person and a person writes the title.

**Backlinks are computed, never stored.** A stored list has to be updated on
every edit of every other note, and the one that gets missed is a link that
silently stops existing.

A link pointing at a note that does not exist is **not an error** — it is how
the next note gets created. Those appear under "Not written yet" as dashed
buttons; clicking one creates that note and opens it.

## Search

Runs over titles, bodies and tags on every keystroke. The matcher is built once
per query rather than once per note — the naive shape compiles a regular
expression inside the loop and gets slow at a few hundred notes, which is
exactly where people start relying on search.

Plain text is the default; regular expressions are an explicit opt-in. **A
malformed pattern returns no results rather than throwing**, because somebody
typing a pattern passes through several invalid states on the way to a valid
one — and the status line says the pattern is not valid yet, so an empty list
is not mistaken for "no matches".

The empty states are distinct: "No notes yet" and "No note matches that search"
need different actions from the user, so they do not share a message.

## Pinning

A pinned note sorts first in **every** order. Pinning means "keep this where I
can see it", and an order that buries a pinned note has ignored the only
instruction the user gave. There is a test asserting that for all three orders.

It says **"Pinned"** in words as well as being styled, because an icon alone is
invisible to a screen reader.

## Export

Every note as one Markdown file, with front matter carrying the title, the
dates, the tags and the pinned state — so a round trip through another editor
keeps them rather than silently discarding them. It reports that nothing was
lost, because nothing is.

## Word count

CJK characters are counted individually. A Chinese sentence has no spaces, so
splitting on whitespace counts a whole paragraph as one word; counting each
character is the convention every Chinese word processor uses.

## Verifying it yourself

```powershell
npm test                          # 220 tests, 19 of them the notes engine
node scripts/drive-notes.mjs      # 23 checks against the real window
```

## Not built yet

Notes are held in memory only — they are not yet written into the autosave
history, so they do not survive a restart. There is no Markdown preview, no
attachments, no import, and no per-note history.

## Suggested articles

- [Writer](writer.md)
- [Autosave and document history](../saving/autosave-and-history.md)
