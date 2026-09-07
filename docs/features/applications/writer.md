# Writer

**Status: built and verified.** 22 engine tests plus 13 checks driven against the
real built window. It is the first of the nine applications to exist.

## What it is

A word processor with its own document model, its own line-breaking engine and
its own pagination. Nothing else has to be installed, and no other office suite
is involved anywhere.

Open it from the front screen, from the tab strip, or from the command palette.

## It does not use contenteditable

That is a deliberate choice with a real cost and a real payoff.

`contenteditable` gives you input handling free and takes away any control over
what the document actually contains, because every browser has its own opinion
about what pasting, undoing and pressing Enter should do to the markup. Owning
the model means the document is exactly what the file codecs, the autosave
history and the collaboration layer think it is — not an approximation recovered
by reading HTML back.

Input arrives through a hidden, focused text field, which is what gives working
IME composition for Cantonese and Chinese **without reimplementing it**. A word
processor that cannot accept Chinese input is not one.

## The model

A document is a list of **blocks**; each block is a list of **runs**; a run is a
span of text with uniform formatting.

That split is not arbitrary. Layout works block by block, so editing paragraph
nine does not force paragraph one to be measured again. Formatting splits and
merges runs, which keeps "bold these three words" an operation on a list rather
than a rewrite of the paragraph. Change tracking attaches to runs, so an
insertion and a deletion in the same paragraph stay distinguishable.

A run marked deleted is **retained** rather than removed, so the change can be
rejected. It takes no space on the page.

## Line breaking

Break opportunities are found properly, not by splitting on spaces:

| Where | Why |
| --- | --- |
| After a space or tab | The obvious one |
| After a hyphen or dash | Where English actually breaks |
| Between CJK characters | They have **no spaces at all** |

Without the last of those, a Chinese paragraph is one unbreakable token that
overflows the page entirely — the single most common way a wrapper that looks
finished turns out not to be. A line never begins with closing punctuation.

The engine breaks at the last opportunity that **fits**, not the first that does
not, and a token wider than the line goes on its own line rather than vanishing
or overflowing silently.

Trailing whitespace is trimmed off the rendered line. The break was measured
against the trimmed candidate, so leaving the space in makes the drawn line wider
than the measurement that chose the break — visible immediately with centred or
justified text.

## Pagination

Pages are real: A4 by default, at the real point geometry converted to pixels, so
what is on screen is what the engine computed rather than an approximation of it.

A heading is **kept with the block that follows it**. If the heading would fit at
the bottom of a page but the first line of its body would not, the heading moves
to the next page with it.

An explicit page break starts a new page.

## Formatting

Bold, italic, underline and strikethrough, from the toolbar or from
<kbd>Ctrl</kbd>+<kbd>B</kbd>, <kbd>Ctrl</kbd>+<kbd>I</kbd>,
<kbd>Ctrl</kbd>+<kbd>U</kbd> and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> —
and each toolbar button shows the shortcut that **actually works**, so it is
learnable from where people look for it.

With no selection, toggling a format applies it to the next thing you type.

A mixed selection reports **nothing** rather than the first run's answer, so the
toolbar never claims the whole selection is bold when half of it is.

## Paragraph styles

Body text, three heading levels, bulleted and numbered lists, quotations and
code. Pressing Enter at the end of a heading gives you body text, because that is
what somebody who has just written a heading is about to type.

## Measurement

Text is measured on a canvas rather than through the DOM. DOM measurement forces
a layout on every call, and measuring a paragraph one word at a time that way is
what makes a naive editor stutter on a long document. The measurement cache is
bounded, so a long editing session cannot grow it without limit.

## Verifying it yourself

```powershell
npm test                          # 59 tests, 22 of them the text engine
node scripts/drive-writer.mjs     # 13 checks against the real window
```

The engine tests inject a **deterministic** measurer, so they pin exact break
positions rather than "it produced some lines" — a layout test that only counts
lines passes on an engine that breaks in all the wrong places.

The window checks type through the same input event a keystroke produces, in
English and in Cantonese, and confirm the page is A4 at its real converted size.

## Not built yet

Footnotes, a table of contents, tables, images, change-tracking review, and
`.docx` and `.odt` import and export. The model has room for footnotes and change
tracking; there is no surface for either.

## Suggested articles

- [Autosave and document history](../saving/autosave-and-history.md)
- [Notifications](../interface/notifications.md)

## Footnotes

Press **Footnote** and the note is attached to the paragraph the caret is in -
not to a page. Which page it appears on is decided by the layout, so it moves
with its reference when the text above it grows. Storing a page here would make
every note wrong the moment somebody typed a sentence.

Two things the layout does that are easy to get wrong:

- **The note lands on the same page as its own reference.** A reader who meets a
  marker and has to turn the page to find the note has been given a worse
  document than one with no notes at all.
- **The space is reserved BEFORE the lines are placed.** Reserving afterwards
  overfills the page and pushes the last line below the paper, which is the
  classic footnote bug.

Notes are numbered by **document order**, not per page. Numbering per page makes
a note change its number when a paragraph above it grows, so a cross-reference
written yesterday points at the wrong note today.

## Table of contents

Press **Contents** to insert one, and press it again to refresh it. It is built
from the headings, indented by level, with the page each heading is on.

**It is a two-pass operation, and the second pass is not optional.** The contents
takes pages, so numbers built before it was inserted are short by however many it
occupies - and they look plausible, get followed, and are wrong.

Refreshing **replaces** rather than stacking: refreshing five times leaves one
contents, not five. The contents does not list its own title either, which would
otherwise grow it on every refresh.

A document with no headings gets an honest line saying so rather than a blank
page, and a heading that produced no line gets no page number rather than page 1
- a wrong page number is worse than an absent one, because it will be followed.

Both survive a `.docx` round trip: the notes reach `word/footnotes.xml` with the
relationship that makes them reachable, and the contents is written back as a
**field** rather than as frozen text, so a reader can still refresh it.
