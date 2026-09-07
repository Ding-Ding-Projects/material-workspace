# PDF

**Status: built and verified.** 18 engine tests plus 16 checks driven against
the real built window. The ninth and last of the applications.

## What it does not do, said first

**It does not render pages.** Rendering a PDF faithfully means implementing
font programs, colour spaces, shading, transparency groups and a graphics state
machine — more work than everything else in this project combined.

Showing a grey rectangle and labelling it "page" would be a decorative control,
which this project forbids everywhere else. So the surface itself says what it
shows and what it does not, in the panel where a page view would otherwise be.

What it does instead is the part that is genuinely easy to get wrong elsewhere.

## Redaction removes the bytes

Drawing a black rectangle over text leaves the text in the file, where anybody
can select it, copy it, or read it in a text editor. **That mistake has exposed
real secrets in real published documents, repeatedly.**

So redaction here removes the objects and rewrites the file with a fresh
cross-reference table. The removed object becomes a **free** entry rather than
a dangling offset — a zero offset marked in-use points every reader at the file
header.

And then it **checks**. The text that was removed is searched for in the new
bytes, and the result says either that none of it remains or, loudly, that some
of it does. A redaction verified by looking at the rendered page is not
verified at all; that is precisely the mistake.

## Writing a PDF

A PDF is numbered objects, a cross-reference table saying where each starts in
**bytes**, and a trailer. Three things decide whether the file opens:

- **The offsets are bytes, not characters.** Any non-ASCII text anywhere shifts
  every later offset, and a reader following a wrong one reports the file as
  damaged. There is a test that puts a pound sign in the title and then checks
  that every offset still lands on its own `N 0 obj`.
- **The table is fixed-width** — exactly twenty bytes per entry including the
  line ending. A shorter line makes every later lookup land mid-entry, and the
  result is a file that opens in one reader and not another.
- **Object zero is the free-list head**, generation 65535. It is not a real
  object, and omitting it makes the whole table one entry out.

A stream declares its **byte** length too. A character count truncates the
stream on any page containing non-ASCII text.

The file begins with a comment of high bytes, which tells a transfer program it
is binary. Without it a naive text-mode copy rewrites the line endings and
every offset becomes wrong.

## The fonts are the standard fourteen

Every reader has them built in. Embedding a font is a much larger piece of
work, and a PDF that depends on a font the reader does not have renders in
something else entirely.

The consequence is stated rather than hidden: a character outside WinAnsi
cannot be rendered, so it becomes a question mark **and the writer reports
which characters those were**, before the export runs. Producing a page of
question marks and letting somebody discover it later is the failure this
avoids.

Text is measured from the real Adobe metrics, so wrapping happens in the right
places without needing a browser to measure it — the main process cannot.
Wrapping breaks between CJK characters as well as at spaces, for the same
reason the text engine does.

## Reading finds objects by scanning

Not by following the cross-reference table. A file that has been incrementally
updated, appended to, or damaged has offsets that no longer point where they
claim, and a reader that trusts them reports a perfectly recoverable file as
broken. Real readers scan; there is a test that corrupts every offset and
checks the text still comes out.

Text extraction is honestly an **approximation**, and is documented as one: a
PDF may position every glyph individually, in which case the extracted words
come out in drawing order rather than reading order. It is right for text this
project wrote and for most text from ordinary tools. A compressed stream is
skipped rather than misread — emitting its compressed bytes as text produces a
page of noise that looks like extracted content.

## Verifying it yourself

```powershell
npm test                          # 331 tests, 18 of them the PDF engine
node scripts/drive-pdf.mjs        # 16 checks against the real window
```

The drive builds a sample containing a known secret, redacts it, and then
searches the **saved bytes** for that secret — not the rendered page, and not
the extracted text alone.

## Not built yet

Page rendering, compressed-stream decoding, annotations, form fields,
encryption, digital signatures and their verification, and PDF export from the
other applications — the writer exists and is tested, but nothing else calls it
yet.

## Suggested articles

- [File formats](../files/formats.md)
- [Writer](writer.md)
