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


## Tables

**Table**, **Row**, **Column** on the toolbar. A new table is three by three
with a header row, and the caret lands in the paragraph after it - which is both
where you want to keep typing and what makes **Row** and **Column** find the
table you just made, since they search backwards from the caret.

### The parts that look right and are wrong

- **A cell wraps against its own width, not the page's.** Measuring against the
  page gives cells that never wrap, so text runs straight over the column beside
  it and the table appears to have no columns at all.
- **Every cell in a row takes the row's height.** Sizing each to its own content
  leaves the rules not lining up, which reads as a broken table rather than as
  one cell holding more text than another.
- **Column widths are shared out to sum exactly to the space available.** Widths
  that fall short leave a gap down the side; widths that overshoot push the last
  column off the page. Proportions are kept, so a column an author made twice as
  wide stays twice as wide.
- **The declared width count decides how many columns there are**, not the cells
  present. A table saying it has three columns whose first row holds one cell
  still has three; counting the cells alone silently discards the author's own
  widths.
- **An empty cell still occupies its column.** Dropping it shifts every later
  cell one column left, and the result is a plausible table nobody wrote.
- **A table breaks at a row boundary.** Splitting a row leaves half its cells on
  one page and half on the next with nothing lining up, which is worse than a
  shorter page. A row taller than a whole page cannot be helped, so it is placed
  and **marked** rather than silently clipped.
- **A header row repeats** at the top of every page the table runs onto.
  Without it, page two is a wall of values with no labels.
- **Adding a column reaches every row**, not only the full-length ones. A column
  added to some rows and not others shifts every later cell in the rows that
  missed it.
- **The table is drawn from the layout's own geometry**, not laid out by CSS. A
  table CSS sizes differently from the layout engine is a table whose page break
  lands somewhere nobody chose.
- **The paper is white whatever the theme is.** The rules and the header tint
  are paper colours, not theme colours - the first capture of this feature
  showed dark text on a dark header band in dark mode, which reads as unstyled
  rather than as unreadable until somebody looks. The drive measures the
  contrast ratio rather than trusting the stylesheet.

Header cells carry the `columnheader` role and body cells `cell`, so a screen
reader is not handed a stream of values with nothing to attach them to.

## Images

**Image** on the toolbar opens a file picker and then asks what the image shows.

**The alternative text is asked for before the image goes in**, not offered
afterwards as something to fill in later - because afterwards is when it does
not happen, and an image with no alternative text does not exist for a reader
who cannot see it. Leave it empty and the status line says plainly that the
image is invisible to anybody using a screen reader.

- **A resize keeps the proportions.** Fitting to a width by changing only the
  width stretches it, and a stretched photograph is a defect nobody reports
  because it looks like a bad photograph rather than a bug.
- **A whole image moves to the next page** rather than being cut in half. Half a
  photograph is not a smaller photograph, it is a mistake.
- **Sizes are points, converted from pixels at 96 per inch.** Inserting at the
  pixel count makes a screen-sized image a third larger than the page.
- Alignment follows the block: start, centred, or at the end.

## Saving a table

Tables **are** written into `.docx` and `.odt` now, and read back out of both.
Six real files in the conformance corpus prove it, read off disk rather than
handed to the reader in memory.

The parts that are easy to get wrong, and what each one costs:

- **A `<w:tbl>` is a sibling of `<w:p>`, not a child of one.** A reader that
  walks only paragraphs loses the table *and every paragraph inside it*, and the
  document comes back looking like one that never had a table.
- **`w:w` carries twentieths of a point.** Reading them as points gives a table a
  twentieth of its width and Word does not complain - it draws the thing a fifth
  of an inch across. Writing points does the same in reverse.
- **`<w:tblHeader>` is what makes a row repeat**, and `<w:tblGrid>` is what stops
  Word choosing its own column widths. A table that opens a different shape from
  the one that was saved reads as a corrupted file.
- **ODF puts header rows in their own `<table:table-header-rows>` element**, not
  among the ordinary rows - so a reader that walks only `table:table-row` loses
  the headings and comes back a row short.
- **`table:number-columns-repeated` means "n of these"**, on columns and on
  cells alike. Counting elements gives one column where the file declares three,
  and every row after the first lands in the wrong place.
- **An empty cell is still written and still read.** A `<w:tc>` with no
  paragraph in it is invalid and Word refuses the whole file rather than the
  cell, so every cell carries at least one - and on the way back the empty cell
  is kept, or the row shifts left.

## What tables and images do NOT do yet

**Images are not written into either format.** This matters more than it sounds,
because a block with no text runs writes an *empty paragraph* - so without the
disclosure the file would save cleanly, open cleanly, and the image would simply
be gone. The save says it before it writes: *"Not carried: 1 image (this format
is not written yet, so they will not be in the file at all)"*.

Also not built: merged cells, cell shading and per-cell borders, a caption tied
to the table, text wrapping around an image, and cropping.

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

## Suggested articles

- [Autosave and document history](../saving/autosave-and-history.md)
- [Notifications](../interface/notifications.md)
