# Tabs and navigation

**Status: built and verified.**

## The strip docks to any edge, and defaults to the left

That default is deliberate rather than contrarian. A screen is wider than it is
tall, while a tab label is wider than it is high, so a vertical strip shows more
tabs legibly than the horizontal one every browser has trained people to expect.

Change it in **Settings → Navigation**, or from the command palette.

## Docking is an orientation change, not a rotation

Everything the tab contract requires works at every edge, and the axis change is
where each part is most easily got wrong:

- `aria-orientation` follows the **axis**, not the markup. Getting this wrong
  produces a strip that looks correct and is unusable by keyboard, which no
  screenshot will ever reveal.
- The arrow keys that move between tabs become up and down.
- Labels are **never** rotated ninety degrees. A sideways word is a word nobody
  reads.

At narrow widths a side strip collapses to icons rather than crowding the content
it exists to reveal.

## Keyboard

Roving tabindex: only the selected tab is in the tab order, so you tab **into**
the strip once and then arrow within it. Home and End jump to the ends.

## Nested strips

The settings surface is itself tabbed. Its strip is marked as nested and is
unaffected by the main strip's docking edge.

That distinction is structural rather than a styling override, and the reason is
worth recording: an override written for the nested case lost on specificity to
the main docking rule and was a **silent no-op** — the type check passed, the
build succeeded, and the interface was unchanged. The correction is checked by
measuring the running window's computed layout, because a stylesheet cannot tell
you which rule won.

## Suggested articles

- [Command palette](command-palette.md)
- [The regex builder](regex-builder.md)
