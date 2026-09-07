# PDF

**Status: built and verified.** 18 engine tests plus 16 checks driven against
the real built window. The ninth and last of the applications.

## What it does not do, said first

**It renders pages, and says exactly how much.** Paths are drawn faithfully -
fills, colours, the graphics-state stack, transforms. Text is *placed*
faithfully and drawn with the application's own font, because the standard
fourteen fonts are not embedded in a file that uses them and this engine has no
glyph outlines for them. Inventing shapes would be inventing a typeface, and a
page in a typeface nobody chose is worse than one in the viewer's own.

Not drawn at all, and said on the surface beneath every page: embedded fonts,
images, shading, transparency, and any page whose content stream is compressed.
Those are absent rather than approximated - a page half-drawn from a
half-understood stream looks like a rendering and is not one.

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

## Compressed streams

Nearly every PDF produced by anything deflates its content, so a reader that
skips compressed streams reads almost no real file at all. It does not fail
while doing it, either: it returns an empty page and reports success, which is
the worst shape a gap can take — "no readable text" is indistinguishable from a
document that genuinely has none.

Both paths decode now. The text panel reads the words, and the page beside it
is **drawn** from the same decompressed content. Fixing one and leaving the
other gives a reader that can quote a document it cannot show.

| Filter | Handled |
| --- | --- |
| `FlateDecode` | yes, zlib first and raw deflate as a fallback |
| `ASCIIHexDecode` | yes, including an odd final digit |
| `ASCII85Decode` | yes, including the `z` shorthand |
| `RunLengthDecode` | yes |
| PNG predictors | yes, all five row filters including Paeth |
| `DCTDecode`, `JPXDecode`, `CCITTFaxDecode`, `JBIG2Decode` | reported as images, which is what they are |
| anything else | refused **by name** |

### The parts that look right and are wrong

- **A filter chain is ordered.** `/Filter [/ASCII85Decode /FlateDecode]` means
  ASCII85 first and then Flate. Applied the other way round the bytes are not
  merely wrong, they decode without complaint.
- **`FlateDecode` is zlib, not raw deflate.** The two differ by a two-byte
  header, and a raw inflate of a zlib stream eats that header as data and
  returns rubbish. Some producers emit raw regardless, so both are tried, zlib
  first because that is what the specification says.
- **A predictor is not a filter.** It lives in `/DecodeParms` and applies
  *after* decompression. Ignore it and the bytes inflate perfectly and are
  still wrong, every row off by the row above it.
- **The newline before `endstream` is a separator, not data.** Counting it
  hands the decompressor one byte too many, which is not a rounding error to
  inflate: it rejects the whole stream, so a perfectly good page comes back as
  a decode failure. A literal `/Length` is preferred where it agrees, and an
  *indirect* one — `12 0 R` — is ignored, because reading it as a number
  truncates the stream to nothing.
- **An image is not a failure.** Calling a JPEG an error makes an ordinary
  scanned document look broken, so it is reported as an image and counted.
- **An unknown filter is named.** Returning the compressed bytes and letting
  them be treated as text produces a page of noise that looks exactly like
  extracted content.
- **One damaged object costs that object, not the document.** A truncated
  stream is common in a damaged file; the refusal is recorded beside the pages
  that did read.

### What the surface says

Streams that could not be read are listed by object number and reason, above
the text, because a reader who skims past that will believe they have seen the
whole document. Image streams get their own line. An empty result says *why* it
is empty — "for the reasons above" when there were reasons, and "this file
stores no text at all" when there were none.

Both the text panel and the drawing are guarded by a generation counter.
Decompression is asynchronous, and two overlapping renders each clear the panel
and then each append to it: the interleaving leaves the document rendered
twice. The drive caught exactly that, as a two-page file reporting four pages.

## Not built yet

Annotations, form fields, encryption, digital signatures and their
verification, and PDF export from the other applications — the writer exists
and is tested, but nothing else calls it yet.

## Suggested articles

- [File formats](../files/formats.md)
- [Writer](writer.md)
