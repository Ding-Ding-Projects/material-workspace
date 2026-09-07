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
npm test                          # 267 tests, 24 of them the formula engine
node scripts/drive-formula.mjs    # 15 checks against the real window
```

## Not built yet

Matrices, cases, aligned multi-line equations, over- and under-braces,
accents, `\left.` with an invisible fence, MathML import, and rendering to an
image for consumers that cannot show MathML.

## Suggested articles

- [Writer](writer.md)
- [Draw](draw.md)
