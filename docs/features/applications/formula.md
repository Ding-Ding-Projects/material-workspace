# Formula

**Status: built and verified.** 24 engine tests plus 15 checks driven against
the real built window. The sixth of the nine applications to exist.

## The output is MathML, and that is the whole point

An equation editor that produces a picture has failed at the one thing that
distinguishes it from a drawing of a formula.

- **A screen reader speaks MathML as mathematics** — "the fraction with
  numerator a plus b" — where an image is silent and a pile of positioned spans
  is gibberish.
- **It is selectable and searchable**, so a formula pasted elsewhere is still a
  formula.
- **The platform renders it**, so it matches the surrounding font and scales
  with it instead of being a fixed-size picture.

## The element decides how it is read

This is where a MathML generator quietly goes wrong. `mi` is a variable, `mn` a
number, `mo` an operator, `mtext` prose. Using `mi` for everything renders
**identically** and is read aloud as nonsense — so the tests assert the exact
element, not that some markup came out.

Two details in the same family:

- **A function name is set upright.** Italic `sin` is *s* times *i* times *n*.
  This is the detail that makes a rendering look wrong to anybody who reads
  mathematics, without their being able to say why.
- **Letters are separate variables.** In mathematics `ab` is *a* times *b*, not
  a variable called `ab`. Grouping the letters would set it upright as a word
  and change what the formula says.

## Big operators take limits, not scripts

A sum's bounds go **above and below** it, not beside. A sum with its bounds
beside it is a different — and wrong — piece of notation, so `\sum` and its
relatives produce `munderover` rather than `msubsup`.

Brackets are written out with stretchy operators rather than `mfenced`, which
is deprecated and unsupported in current engines: a formula using it renders as
a flat run of characters.

## The spoken reading is shown, not hidden

It sits under the preview in words.

Two reasons. It is how somebody checks that what they typed means what they
intended before pasting it anywhere. And it is the only part of an equation
editor that a person who cannot see the rendering can verify at all — hiding it
would make the accessible path the unverifiable one.

The same description goes into the exported MathML's `aria-label`, so it
travels with the formula.

## The preview survives a half-typed formula

Most partial input is invalid on its way to being valid, so clearing the
preview on a parse failure makes it flicker empty on nearly every keystroke.

The first version cleared it at the top of the render and returned early on
failure, while its own comment claimed the opposite. Only driving the built
window showed which was true. The parse now happens **before** anything is
cleared.

A problem is stated **in words** — which brace, at what position — rather than
by turning the field red. A colour tells a screen-reader user nothing and tells
everybody else only that something is wrong, not what.

## The palette

Buttons are named by what they **mean** — "Fraction", not `\frac{a}{b}`. A
button labelled with a backslash command is unreadable aloud and meaningless to
anybody who does not already know the notation; the source is the tooltip, for
those who do.

Inserting puts the symbol **at the caret**, not at the end. Appending is what a
palette usually does and it is wrong: somebody who has put the caret inside a
fraction wants the symbol there.

## The preview is built, not assigned

The MathML is parsed as XML and imported into the document rather than assigned
to `innerHTML`. The input is user text, and building a DOM from a string is
precisely how user text becomes markup.

## Not a TeX implementation

TeX is a programming language with macros. This is a precedence climber over a
small token set, and it says what it covers rather than pretending to be the
whole thing: fractions, roots, scripts, fences, big operators with limits,
around fifty named symbols, upright function names, and text runs.

An unknown command is refused **by name** rather than silently dropped.

## Verifying it yourself

```powershell
npm test                          # 1,031 tests, 51 of them the formula engine
node scripts/drive-formula.mjs    # 26 checks against the real window
```

## Tables: matrices, cases and aligned equations

Nine environments, written the way TeX writes them:

| Written | Gives |
| --- | --- |
| `\begin{matrix}` | rows and columns, no delimiters |
| `\begin{pmatrix}` | round brackets |
| `\begin{bmatrix}` | square brackets |
| `\begin{Bmatrix}` | braces |
| `\begin{vmatrix}` | single bars, a determinant |
| `\begin{Vmatrix}` | double bars, a norm |
| `\begin{cases}` | one opening brace and no closing one |
| `\begin{aligned}`, `\begin{align}` | equations meeting at their ampersands |

`&` separates cells and `\\` separates rows, and four buttons in the palette
write a small one for you so the feature can be found without knowing the
syntax first.

### The parts that look right and are wrong

- **An aligned block alternates right then left.** That alternation is the
  entire feature: the ampersand marks the point every row should meet at, so
  centring the columns instead leaves a column of equals signs that do not line
  up, which was the only reason to reach for it.
- **An empty cell keeps its place.** Dropping it shifts every later cell one
  column to the left, and the result is a perfectly plausible matrix that is
  not the one anybody wrote.
- **A trailing `\\` before `\end` means nothing** and is ignored, because it
  is idiomatic to write it. A blank row in the *middle* is spacing somebody
  asked for and is kept.
- **A nested table's row breaks belong to the inner table.** Cells are parsed
  with the ordinary atom parser rather than by splitting the token stream, so
  an inner break cannot end the outer row.
- **A short row is padded, and the padding is said.** A cases block genuinely
  mixes one-cell and two-cell rows, so padding is right - but a matrix a cell
  short is nearly always a typo, and the status line names how many tables were
  padded rather than quietly squaring them off.
- **The brackets need a font, not just an attribute.** `stretchy="true"` is a
  request, and it is honoured only where the font carries the larger glyph
  variants an OpenType MATH table describes. With the CSS generic alone, a
  two-line matrix rendered with parentheses 24 pixels tall beside a 64-pixel
  table: the markup was correct and nothing acted on it. A named math font
  comes first in the chain now, and the drive **measures the rendered height**
  rather than reading the attribute back. Where no math font exists at all the
  formula is still correct and still read aloud correctly; the brackets simply
  do not grow.

### What it is read as

A table is spoken as a shape and then row by row - "2 by 2 matrix, row 1, a, b;
row 2, c, d" - because a reader handed the cells one after another gets a
stream of letters with no way to tell where a row ended. Cases and aligned
equations announce what they are rather than calling themselves matrices, and
an empty cell is spoken as "blank" instead of passing in silence.

### What it refuses

An unknown environment is refused by name and the message lists the real ones;
a mismatched `\end` names both halves; an unterminated table is refused rather
than silently closed. Rendering an empty row instead would put a formula on
screen that had quietly dropped everything the author typed.

## Not built yet

Over- and under-braces, accents, `\left.` with an invisible fence, MathML
import, and rendering to an image for consumers that cannot show MathML.

## Suggested articles

- [Writer](writer.md)
- [Draw](draw.md)
