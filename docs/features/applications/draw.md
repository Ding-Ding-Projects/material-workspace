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
npm test                          # 1,006 tests, 59 of them the vector engine
node scripts/drive-draw.mjs       # 32 checks against the real window
```

The drive converts drawing coordinates to client coordinates the same way the
application converts back, so what is exercised is the round trip through the
mapping rather than a set of numbers chosen to agree with it.

## Selection handles

A selected shape carries eight handles for resizing and a ninth, above the
shape, for rotating it. Each one has its own pointer cursor, so what a drag
will do is visible before the drag starts, and its own accessible name, so a
handle is a control rather than a decoration that only exists for people who
can see it.

Resizing scales about the opposite corner, not about the origin. Scaling about
the origin is the mistake that makes a shape wander across the canvas as it
grows, and it looks like a bug in the pointer mapping rather than in the
transform. Holding Shift keeps the proportions.

Rotation is composed onto the shape's original transform on every pointer move
rather than accumulated, so a drag that wanders back and forth ends where the
pointer is instead of drifting a little further round each time.

A **locked** shape still shows its handles, marked as locked and drawn with a
"not allowed" cursor. Hiding them would make a locked shape look unselected;
what the lock does is refuse the drag and say why in the status line.

Handles are hit-tested before shapes, because a handle sits on top of the shape
it belongs to and a test that asks the shape first can never reach one. The
tolerance is in drawing units rather than screen pixels, so handles stay
grabbable when the canvas is zoomed out.

## Combining shapes

**Union**, **Subtract** and **Intersect** combine exactly two marked shapes.
Two, not "the selection": a boolean of three shapes has an order, the order
changes the answer, and asking for two is honest rather than picking one
silently. The status line says how many are marked when it refuses.

The one nearer the front is the subject, so subtracting takes the shape on top
out of the one beneath, which is what somebody looking at the canvas means by
it. An empty result is applied rather than refused: subtracting a shape that
covers another genuinely leaves nothing, and returning the original instead
makes the button look broken to somebody who will simply press it again.

An ellipse is flattened to its outline first. That is exact for a rectangle or
a line and an approximation for a curve, and the status line says so rather
than leaving it to be discovered from an edge that is slightly the wrong shape.

### What the clipper handles, and what it refuses

Simple closed polygons, including concave ones, two at a time. Not
self-intersecting input, not holes, not curves without flattening. An operation
that cannot be done says so; returning the inputs unchanged is
indistinguishable from a button that was never wired up.

Four things decide whether a boolean looks right and is wrong:

- **Winding decides which side is inside.** Two rings wound the same way union
  cleanly; wound oppositely, the same code subtracts. Winding is normalised
  rather than assumed, because a shape drawn clockwise and one drawn
  anticlockwise look identical on screen.
- **Disjoint shapes have no crossings at all.** A clipper that requires one
  returns empty for a union of two separate squares, which is not a union, it
  is a deletion. Those cases are decided by containment instead.
- **A point exactly on an edge is neither in nor out**, and floating point puts
  points there constantly. Containment uses a tolerance, and a vertex landing on
  the other ring counts as touching rather than crossing.
- **The walk must hop between the two rings at every crossing.** Filtering each
  ring for the vertices worth keeping and concatenating the two runs compiles,
  returns one ring, and is right only when the runs happen to join end to end.
  Two rectangles overlapping at a corner came out as a self-crossing tangle
  eight per cent short on area, while the shape count and the status line both
  read as correct. The capture is what caught it; the tests now assert the area
  and that no edge of a result ring crosses another.

## Not built yet

No paths or curves drawn by hand, no text tool wired up, no grouping, no
snapping or alignment guides, no undo of its own, and no SVG import. The model
supports paths, text and corner radii; there is no way to make them yet.

## Suggested articles

- [Slides](slides.md)
- [Notes](notes.md)
