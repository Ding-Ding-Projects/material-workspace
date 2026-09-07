# Document history panel

**Status: not built yet.** The history it will show is real and is being
recorded now; the panel that browses it is not written.

This article describes what the panel *will* do, and says so, rather than
describing an intention in the present tense.

## What it will do

Browse, search, filter, diff, restore, label, prune and export the history
described in [Autosave and document history](autosave-and-history.md).

- **A date picker** with month and year jump, range selection and named presets,
  accepting a typed date in your locale's format and a plain ISO date alike. An
  invalid or partial entry reports inline without discarding what you typed.
- **An action filter** derived from the actions actually present in your history,
  with a count beside each so an empty one is visibly empty rather than
  mysteriously absent. Several actions can be selected at once.
- **A search field** with its own anchored regular-expression builder, like every
  other search field here.
- All three compose. None overrides another.

## What is already true

The data layer supports all of it today: `historyList` returns entries with their
parsed action and document, and the observed-action set is derived from real
history. What is missing is the surface.

## Pruning

Pruning destroys history permanently, so it ships **with** the two-key
confirmation gate rather than before it. Until then the operation refuses and
says exactly that, rather than silently doing nothing.

## Suggested articles

- [Autosave and document history](autosave-and-history.md)
- [The regex builder](../interface/regex-builder.md)
