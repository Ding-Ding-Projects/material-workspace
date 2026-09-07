# Draw

**Status: built and verified.** 23 engine tests plus 21 checks driven against
the real built window. The fifth of the nine applications to exist.

## Transforms are stored, never baked into the geometry

This is the decision everything else follows from.

Baking a rotation into the points means a shape can never be un-rotated
exactly, because every bake rounds. Rotate a square five times by seventy-two
degrees and a baked implementation gives you a slightly crooked square. There
is a test asserting that this engine gives you the original back, to within a
billionth.

It also means the **original geometry survives editing**. A rectangle that has
been rotated is still a rectangle whose width you can type into.

A transform whose determinant is zero has collapsed the plane to a line and has
**no** inverse. That returns undefined rather than an approximation: an
approximate inverse produces coordinates that look plausible and mean nothing.

## Rendered as SVG elements, not to a canvas

Three reasons, and the third decided it:

- Each shape is a DOM node, so it has a role, an accessible name and a focus
  ring for free. A canvas drawing is one opaque rectangle to assistive
  technology, and making it accessible means building a parallel accessibility
  tree by hand.
- Zooming is one attribute on the root, not a re-render of everything.
- **The export is the rendering.** There is no second code path that draws the
  file differently from the screen — which is where a drawing application
  usually accumulates its quiet differences between what you see and what you
  get.

The cost is real: a drawing of many thousands of shapes would be slow. That is
a limit of this design, stated rather than hidden.

## Hit testing happens in the model

The pointer is transformed into the **shape's** space rather than the shape
being transformed into the pointer's. One inverse per shape beats transforming
all of its points, and it means the containment test only ever deals with
un-rotated geometry — the difference between a few lines and a rotated-polygon
intersection.

An ellipse is tested as an **ellipse**, not as its bounding box: there is a
test asserting that a bounding-box corner misses.

A line is selectable **near** it, with a minimum tolerance regardless of stroke
width. A one-pixel line that can only be hit exactly is a line nobody can
select. The projection onto the segment is clamped, so a point far beyond the
end is not reported as being on it — without the clamp the test measures to the
infinite line.

The **topmost** shape wins, searched front to back, because the shape painted
last is the one the user sees there and therefore the one they mean.

## Hidden and locked say so in words

Not an eye and a padlock. An icon alone is invisible to a screen reader and
ambiguous to anybody who has not used this particular application before.

A locked shape refuses to be deleted and says why. A hidden shape leaves the
canvas but stays in the drawing, and the export reports how many were left out.

## Colours are named, not just coloured

Every swatch carries its colour in its accessible name. A grid of unnamed
coloured squares is unusable with a screen reader, however good it looks.

Choosing a colour with something selected applies it to that shape as well as
to the next one drawn, which is the obvious behaviour and not the default one.

## Keyboard

| Key | Does |
| --- | --- |
| <kbd>V</kbd> <kbd>R</kbd> <kbd>E</kbd> <kbd>L</kbd> | Select, Rectangle, Ellipse, Line |
| Arrows | Nudge by one |
| <kbd>Shift</kbd> + arrows | Nudge by ten |
| <kbd>Delete</kbd> | Delete the selection |
| <kbd>Esc</kbd> | Clear the selection |

Nudging is the only way to position something precisely when a pointer snaps to
whole pixels.

## Export

SVG, which is what every other tool reads. A drawing exported to something
nothing else opens is a drawing that is trapped.

Every shape carries an explicit `fill`, including `fill="none"`. The SVG
default is **black**, so omitting the attribute turns every unfilled outline
into a solid block.

A polyline is exported as a polyline, never a polygon: a polygon closes itself
and silently adds a segment the user never drew.

## Verifying it yourself

```powershell
npm test                          # 243 tests, 23 of them the vector engine
node scripts/drive-draw.mjs       # 21 checks against the real window
```

The drive converts drawing coordinates to client coordinates the same way the
application converts back, so what is exercised is the round trip through the
mapping rather than a set of numbers chosen to agree with it.

## Not built yet

No resize handles, no rotation from the interface, no paths or curves, no text
tool wired up, no grouping, no snapping or alignment guides, no undo of its
own, and no SVG import. The model supports paths, text and corner radii; there
is no way to make them yet.

## Suggested articles

- [Slides](slides.md)
- [Notes](notes.md)
