# Slides

**Status: built and verified.** 11 engine tests plus 20 checks driven against
the real built window. The third of the nine applications to exist.

## What it is

A presentation editor with a real presenter view. Its own model, its own
layouts, no other software involved.

## A slide is positioned elements, not a document flow

That is the one structural decision everything else follows from, and it is
deliberately the opposite of Writer's design. A paragraph reflows when the page
changes; a slide element does not move when anything else does.

## Coordinates are ratios, not pixels

Every position and size is stored in a normalised 0–1 space.

A presentation is shown at whatever size the screen happens to be — a laptop, a
projector at 4:3, a hall at 16:9. Pixel coordinates mean rebuilding the
geometry at every one of them, with a rounding error at each step. Ratios scale
exactly: there is a test asserting that a frame rendered at 1920 wide is
precisely three times its size at 640, with no drift.

Text scales the same way, expressed as a percentage of the slide's own width
through a container query. A deck authored on a laptop is readable on a
projector because the type grows with the slide rather than staying
laptop-sized.

Scaling from the **width** rather than the height keeps the relationship to
line length constant, and line length is what actually governs readability.

## The presenter view

This is the hard part, and it is where presentation software most often
disappoints.

The presenter needs the current slide, the **next** one, the speaker notes and
a clock. The audience must see the current slide and nothing else.

**The two are separate renderings of the same model, not one view with things
hidden by CSS.** A note hidden with a stylesheet is one mistake away from being
on the projector, and it is already in the document for anyone who looks. The
drive asserts that the notes text appears **nowhere** inside any slide surface.

The presenter view uses `display: none` when idle rather than being moved
off-screen, so it is not in the tab order and not read by a screen reader while
nobody is presenting.

Notes are set at title size, because the presenter is reading them from a
distance while talking. Notes at body size are notes nobody can use.

| Key | Does |
| --- | --- |
| <kbd>F5</kbd> | Start presenting |
| <kbd>→</kbd> <kbd>↓</kbd> <kbd>PgDn</kbd> <kbd>Space</kbd> | Next slide |
| <kbd>←</kbd> <kbd>↑</kbd> <kbd>PgUp</kbd> | Previous slide |
| <kbd>Esc</kbd> | Stop |

These are the keys every other presentation tool uses. Inventing new ones would
be a small, constant tax on everybody who has ever presented before.

## Hidden slides

A hidden slide stays in the file and is skipped when presenting. It says
**"Hidden"** in words rather than only being dimmed — a colour alone is
invisible to a screen reader and to anyone who cannot distinguish it.

The status line counts them, and the presenter's position counts over the
visible slides only.

## Timing

Each slide can advance after a set number of seconds, or wait for a keypress.

The total run time is reported only when **every** visible slide is timed.
Treating a keypress-advanced slide as zero would tell a presenter their
forty-minute talk takes four minutes, which is worse than showing no number at
all.

## Layouts

Title, title and content, two content, section header, and blank.

They are stored as data rather than as code that positions things, so adding a
layout is adding a row — and a slide's geometry can be checked against its
layout without running any rendering. There are tests asserting that every
placeholder sits inside the slide and that the two content columns do not
overlap.

A new slide's placeholders show what they are for. A blank rectangle gives no
indication that anything can be typed into it.

## Duplicating

A duplicated slide gets **new element identifiers throughout**. Sharing them
would make editing one copy edit both, which reads as the application randomly
changing a slide nobody touched.

## Verifying it yourself

```powershell
npm test                          # 201 tests, 11 of them the slide engine
node scripts/drive-slides.mjs     # 20 checks against the real window
```

## Not built yet

Images and shapes exist in the model but have no toolbar; there is no drag or
resize, no transitions beyond the field that records them, no `.pptx` or
`.odp`, and no second-screen output — the presenter view currently covers the
same window.

## Suggested articles

- [Writer](writer.md)
- [Sheets](sheets.md)
