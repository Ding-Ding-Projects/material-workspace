# The conformance corpus

```
node test/corpus/build-corpus.mjs   # rebuild the fixtures
npm test                            # read them back
```

Twenty-five real files on disk - real zip containers with real parts inside them -
each exercising one named format feature. The tests **read those binaries**.
They never build a file, read it back, and declare the format handled: a round
trip through one module's own output proves only that the module agrees with
itself, which is equally true of a module that is wrong in a self-consistent
way.

## Why generated rather than collected

A file saved by Word or LibreOffice carries that application's licence, its
metadata, and often a person's name. Committing one to a public repository is a
licensing question and a privacy question at once.

So each fixture is generated in the **shape** a real producer emits, with the
provenance of that shape recorded beside it. That gives a corpus which can be
committed, reviewed in a diff, and corrected when a shape turns out to be wrong.

**What that costs, plainly:** a generated fixture cannot surprise you the way a
real file does. It contains what somebody *thought* a producer emits, and where
that belief is wrong the corpus is wrong in the same direction as the reader.
That is why every entry records where its shape came from - so a wrong belief is
correctable rather than invisible.

## What each fixture pins

| File | Feature | Why a naive reader gets it wrong |
| --- | --- | --- |
| `docx/paragraphs.docx` | Paragraphs and a break inside one | Treating each `<w:p>` as a line loses the distinction |
| `docx/formatting.docx` | Bold, italic, underline, and an explicit **off** | `<w:b w:val="0"/>` is present, so a presence test marks it bold |
| `docx/styles.docx` | A paragraph style reference | The style ID is not the display name; that lives in `styles.xml` and is localised |
| `docx/lists.docx` | A numbered list with its numbering part | The list *type* lives in `numbering.xml`, not in the paragraph |
| `docx/lists-unknown-numbering.docx` | A list whose numbering cannot be resolved | Guessing ordered invents numbers the author never wrote |
| `docx/tabs-and-entities.docx` | `<w:tab/>` and XML entities | Decoding twice turns `&amp;lt;` into `<` and mangles a document about markup |
| `docx/preserved-space.docx` | `xml:space="preserve"` | Trimming every run silently joins words together |
| `xlsx/shared-strings.xlsx` | Shared strings, where the cell holds an **index** | Taking the value literally shows `0` and `1` - plausible, and wrong |
| `xlsx/numbers-and-booleans.xlsx` | Numbers, and booleans that are 0 or 1 | A boolean read as a number shows `1` where the sheet says TRUE |
| `xlsx/formulas.xlsx` | A cell carrying both formula and last value | Keeping only the value loses the sheet; only the formula shows nothing |
| `xlsx/inline-strings.xlsx` | `t="inlineStr"` | Streaming exporters emit these because they cannot build a shared table in one pass |
| `xlsx/sparse-rows.xlsx` | Gaps: omitted cells and skipped row numbers | Assuming contiguity puts every value one place to the left |
| `odt/paragraphs.odt` | `<text:h>` with an outline level | A reader that only handles `<text:p>` drops every heading |
| `odt/spaces.odt` | `<text:s text:c="3"/>` | ODF collapses whitespace in XML; ignoring this squashes runs of spaces |
| `ods/values.ods` | Typed cell values | The `<text:p>` is a *rendering* in the producer's locale, not the value |
| `ods/repeated-cells.ods` | `table:number-columns-repeated` | Expanding blindly allocates a million cells for an empty sheet |
| `pptx/order-and-titles.pptx` | Slide **order** from `presentation.xml`, title by placeholder | The parts are named `slide9.xml` then `slide1.xml`; sorting by filename reverses the deck. The title is the *second* shape, so taking the first is wrong |
| `pptx/emu-geometry.pptx` | EMU positions and `sz` in hundredths of a point | EMU read as points puts every shape 12700x too far out; `sz="2400"` read as points is 2400pt text |
| `pptx/paragraphs-and-notes.pptx` | Paragraphs of runs, and notes that are not the slide text | Concatenating every `<a:t>` runs a list into one sentence; the notes part carries the slide title too |
| `odp/units.odp` | Lengths carrying their unit, in cm **and** in | `Number("8.467cm")` is `NaN`, and NaN in a frame is a shape at the origin with no size |
| `odp/notes-and-spaces.odp` | Notes **inside** the page, and encoded spaces | The opposite of OOXML: a reader looking for a related part reports every slide as unnoted |
| `pdf/rectangles.pdf` | The upward Y axis, asserted on **pixels** | PDF's origin is the bottom-left; drawing onto screen coordinates puts every page upside down. Red is low and blue is high, so a flip swaps them |
| `pdf/transforms.pdf` | `q`/`Q` and `cm` **concatenating** | Assignment loses the outer transform and lands the shape in a plausible wrong place |
| `pdf/paths-not-painted.pdf` | `re` builds a subpath; `n` paints nothing | A renderer that paints on `re` fills every clip region and it looks like a deliberate background |
| `pdf/text-positions.pdf` | `Tm` and `Td` as two matrices; `TJ` kerning | Collapsing them misplaces the second line of every paragraph; appending the kern writes numbers into the page |

A PDF fixture is checked for its `%PDF-` header, a real cross-reference table with **real byte offsets**, and an `%%EOF` marker. A file whose xref is wrong still opens in a forgiving reader, which is exactly why faking it would prove nothing about a reader that follows the table.

An ODF package is additionally checked to store its `mimetype` entry **first and uncompressed** - that is the whole reason the entry exists, and it is what lets a content sniffer tell an `.odp` from a renamed `.pptx` without unzipping anything.

Every other fixture is checked to be a real **deflated** zip. A reader that only
handles stored entries passes against a corpus that only contains stored
entries, and fails on the first file anybody actually has.

## What the presentation corpus found

**The corpus itself was wrong, and the driver caught it.** The builder deflated
every zip entry, including an ODF package's `mimetype`. Real producers store
that one uncompressed and first, precisely so the media type is readable from
the head of the file - so the content sniffer that works against real files
could not see it, and an `.odp` would not open.

Fixed in three places at once: the builder stores it, the conformance test now
asserts that rule instead of a blanket "everything is deflated", and the Slides
open path falls back to trying the other reader rather than trusting the sniff
alone - because some tools do deflate it, which is legal, and a file that opens
everywhere else must not be refused here over a packaging detail.

## What the document corpus found on its first run

**`<w:numPr>` alone did not make a list item.** The reader required a
`ListParagraph` style beside it. Word usually writes one - but it is not
required to, and Google Docs export and pandoc do not. So a list from either of
those imported as **flat body text with the numbering silently gone**, and
nothing anywhere said so.

Fixed: `numPr` alone makes a list item, bullet by default, numbered when the
numbering part resolves the id to a non-bullet format.

The corpus also corrected an expectation of mine in the other direction. My
first `lists.docx` had no `numbering.xml` and expected `numbered` - which is a
guess the reader is right to refuse, because a document with no numbering part
cannot be known to be ordered. The fixture gained a numbering part, and a second
fixture now pins the bullet fallback so a later "improvement" cannot quietly
start guessing.

## Known losses, asserted rather than noted

A loss recorded only in prose goes stale the day somebody implements it, and a
stale caveat is worse than none: it is a lie in a file people trust.

So each is a **test**. `KNOWN LOSS: list nesting depth is not carried` asserts
that the depth is absent. The day the model grows one, that test goes red and
whoever added it updates the documentation instead of leaving this page wrong.

Currently asserted as lost:

- **A compressed PDF content stream.** Skipped rather than misread: interpreting
  compressed bytes produces a page of noise that looks like a rendering, which
  is far worse than a page that honestly does not render.
- **List nesting depth.** `<w:ilvl>` is read and discarded; every list item is
  flat.

For presentations, the same honesty applies at the format level: images, theme
colours, masters, charts and animation are **not read and not written**. They
are absent rather than approximated, because a shape drawn in the wrong place
from a half-understood theme is worse than a shape that is honestly missing -
and the Slides surface says so after every import and every export.

## Adding a fixture

1. Add an entry to `CORPUS` in `test/corpus/build-corpus.mjs`, with its
   `feature` and - not optional - its `shape`: where the XML shape came from and
   why a naive reader gets it wrong. A fixture with no note is a fixture nobody
   can fix when it goes red, because there is nothing to say whether the reader
   or the file is right.
2. Run the builder. The file is committed alongside the entry.
3. Add the assertion to `test/corpus/conformance.test.ts`.

The inventory is hand-written on purpose. A rule that only checks the fixtures it
can find passes cleanly on an empty directory, so the count is asserted too.

## Related

- [Reading and writing files](README.md)
