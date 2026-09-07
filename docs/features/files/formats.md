# File formats

**Status: CSV, TSV, ZIP, XML, `.xlsx`, `.docx`, `.ods` and `.odt` are built and
verified.** 99 tests across the codec layer, plus round trips driven through
the real applications' own file controls.

## What opens and saves

| Format | Read | Write | Where |
| --- | --- | --- | --- |
| CSV, TSV | ✅ | ✅ | Sheets |
| `.xlsx` | ✅ | ✅ | Sheets |
| `.ods` | ✅ | ✅ | Sheets |
| JSON, Markdown, HTML | — | ✅ | Sheets |
| `.docx` | ✅ | ✅ | Writer |
| `.odt` | ✅ | ✅ | Writer |
| Markdown, plain text | ✅ | ✅ | Writer |

`.odp` and `.pptx` are not built yet.

## Every export says what it drops, before it runs

This is a rule, not a nicety. An export that quietly loses formulas is one
somebody discovers has lost them a week later, when the original is gone.

So each save control names its own losses in its tooltip, and the note after
the export repeats them. Writer counts them **from your actual document** —
"3 explicit page breaks and 12 runs with size, font or colour" — rather than
printing a generic list of things that might apply.

JSON is the only export here that loses nothing, and it says so.

## Opening dispatches on the bytes, not the extension

A `.csv` that is really a ZIP is a spreadsheet somebody renamed. Reading its
binary as text gives a screen of mojibake instead of an error anyone can act
on, so both applications read the first four bytes and decide from those.

Inside a ZIP the four office formats are told apart by which parts they
contain, because they all begin with the same two bytes. A file the
application cannot open is **named** — "that file is a Word document, which
Sheets cannot open" — rather than reported as a bare failure.

## Imported data that looks like a formula stays data

A downloaded file whose cell begins with `=` must not become a live formula the
moment it is opened. Every import path forces such values to text.

## ZIP

Every modern office format is a ZIP of XML, so this is the floor everything
stands on.

**Reading** supports stored and deflated entries, because real files are
deflated. Inflation goes through `DecompressionStream`, which both Node and
Chromium provide, so there is one code path and no vendored inflate to go
subtly wrong on one of them.

**Writing** emits stored entries only. Files are larger; in exchange there is
one implementation that behaves identically in the main process and the
renderer with no compression dependency. A stored ZIP is a valid ZIP and every
consumer opens it.

Two details that decide whether a reader works on real archives:

- **The central directory is what gets read, never the local headers.** A local
  header may carry zeroed sizes with the real values in a trailing descriptor,
  so walking local headers works on files from some writers and silently
  mis-reads files from others.
- **The end record is searched backwards.** Its signature also occurs inside
  compressed data, so a forward scan finds a false positive on almost any large
  archive. There is a test whose entry content is that exact signature.

Entry names that escape their directory are refused at the reader, and the
whole archive is bounded by entry count, per-entry size and total expanded
size.

## XML

Small and deliberately not general — it handles what office formats contain.

**A DOCTYPE is refused outright.** That is the whole XXE and billion-laughs
surface, and refusing it is more reliable than configuring a general parser not
to expand entities: a flag can be missed, and this has no code that could.

It is used in both the main process and the renderer, which is why it does not
use `DOMParser` — that exists in only one of the two.

## `.xlsx`

Four things decide whether a spreadsheet reader works on real files:

- **Most text is not in the worksheet.** Strings live in a shared table and the
  cell holds an index. A reader that takes the cell's own value gets 0, 1, 2 —
  numbers that look entirely plausible in a spreadsheet and are completely
  wrong. A run-formatted string is split across pieces, and reading only the
  first truncates it.
- **A cell may omit its reference**, in which case it is the next column along.
  Every cell after the first omission otherwise lands a column too far left.
- **A formula cell carries both** the formula and its last computed value.
  Reading only the formula shows nothing until recalculation; reading only the
  value discards every formula in the file.
- **The 1900 leap-year bug is part of the format.** Day 60 is 29 February 1900,
  a date that never existed. Correcting it shifts every earlier date by a day
  relative to every other application, so it is reproduced deliberately.

## `.docx`

- **A paragraph is not a line.** Breaks inside a paragraph are elements.
  Collapsing the two changes the document's structure rather than its
  appearance, and that difference survives into every later edit.
- **Whitespace is dropped unless explicitly preserved**, so "Hello " followed
  by "world" silently becomes "Helloworld".
- **A style is a reference, not a name.** The visible name is localised in
  documents produced by a localised application, so matching on it works in
  English and fails everywhere else.
- **Bold is absent, present, or explicitly off.** Treating the element's
  presence as truth makes explicitly-unbolded text bold — exactly the case the
  author used the explicit off to express.
- **Bullets versus numbers is defined in a separate part.** The paragraph
  carries only a numbering ID; whether that ID produces bullets or numbers
  lives in `numbering.xml`. The first version of this reader guessed from the
  ID, which worked on files it wrote itself and would have been wrong on every
  real file. There is now a test with the definitions swapped, which a guessing
  reader fails.

## `.ods` and `.odt`

OpenDocument is also a ZIP of XML, but it is **not** a dialect of the OOXML
formats. Different design, different traps:

- **The mimetype entry must be first and stored.** A reader identifies the file
  by reading it at a fixed offset without unpacking the archive, so its
  position is part of the format rather than a convention.
- **Empty cells are run-length encoded.** A sheet with a value in A1 and
  another further along is written as one cell plus a repeat count, and a
  reader that ignores the count collapses every gap — producing a tidy little
  table that is wrong. Writers also pad rows to the full sheet width with a
  single repeated cell, so an enormous count is treated as padding rather than
  honoured into a million allocations.
- **The formula syntax is different.** Not slightly: `of:=SUM([.A1:.A9])`
  rather than `SUM(A1:A9)`. References are bracketed and dot-prefixed, and a
  range must land inside **one** bracket pair — converting each reference
  independently produces two pairs, which looks reasonable and is a syntax
  error. Formulas are translated both ways, with a round-trip test.
- **A cell carries its value and its display text separately.** The typed value
  is an attribute; the text inside is what was on screen. Reading the text
  gives a locale-formatted string where a number belongs.
- **Consecutive list items belong to one list element.** One list per item
  restarts numbering at every item, which is visible immediately in any reader.

## Verifying it yourself

```powershell
npm test                          # 190 tests, 99 of them the codec layer
node scripts/drive-sheets.mjs     # includes full xlsx AND ods round trips
node scripts/drive-writer.mjs     # includes a full docx round trip
```

Every codec is tested against **hand-built XML in the shapes real writers
emit**, not only against files this project wrote. A codec tested on its own
output proves the two halves agree with each other and nothing at all about the
format.

The ZIP reader is additionally tested against a genuinely deflated archive
produced by Node's own zlib, with an assertion that the fixture really did
compress — otherwise the test would pass on a reader that never inflates
anything.

## Not built yet

`.odp`, `.pptx`, PDF and RTF. Cell formatting, column widths, images, tables
and footnotes are not carried by any path yet, in any format.

## Suggested articles

- [Sheets](../applications/sheets.md)
- [Writer](../applications/writer.md)
