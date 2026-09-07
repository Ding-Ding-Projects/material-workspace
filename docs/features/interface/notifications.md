# Notifications

**Status: built and verified.** Six unit tests over the store, plus checks driven
against the real built window.

## Nothing that only informs will block you

Anything that merely reports something appears as a non-blocking toast in a
corner. A modal dialog is reserved for a decision that genuinely must be made
before you can continue: a confirmation, an unsaved-changes prompt, a destructive
gate, a credential step.

Everything else gets out of the way.

## An error or a warning never disappears on its own

| Severity | Auto-dismiss |
| --- | --- |
| Success | after 4 seconds |
| Information | after 6 seconds |
| Progress | when whoever is reporting it says so |
| Warning | never |
| Error | never |

A message that vanishes before it is read was never delivered, and the ones most
likely to be missed are the ones that mattered.

**The severity decides, not the caller.** An earlier version honoured an explicit
timeout even on an error, which quietly contradicted the rule two lines above it
in its own source. A caller asking for a five-second error toast is asking for a
message nobody will read.

## Dismissed is not deleted

Everything goes to the notification centre and stays there. "It flashed up and I
did not catch it" is the single most common complaint about toasts anywhere, and
it is entirely avoidable.

Retention is bounded at 500 entries. When that fills, the oldest **dismissed**
entries go first — nothing still on screen is ever discarded to make room.

## Progress replaces rather than stacks

A notification with a key replaces the existing one with that key. Without this,
a progress report becomes forty toasts.

## The centre is a real list

It is a list, so it carries what every list here carries:

- Its own search field with its own anchored regular-expression builder.
- Multi-select, with a keyboard equivalent — <kbd>Space</kbd> or <kbd>Enter</kbd>
  on a focused row.
- **Select-all that says which set it means.** With a search active it reads
  "Select all 7 matching", not a bare "Select all". A select-all that silently
  means only what is visible is how people act on the wrong things.
- Inverse selection, and clear.
- Bulk dismiss, and copy that **honours the active filter** rather than dumping
  the entire log.

"It is just a log" is not an exemption. A log is exactly the surface where
somebody needs to select forty things and act on them.

### A bulk action reports what happened, not what was selected

Selecting three and dismissing them, when one was already dismissed and one no
longer exists, reports **one** dismissed. Reporting three would be a false
statement about what changed.

## Accessibility

- An error is announced immediately; everything else waits its turn, so a toast
  never interrupts a screen reader mid-sentence.
- Severity is carried as a **word** as well as a colour, so the categorisation
  survives for anyone who cannot distinguish the colours.
- The dismiss control is a real 36-pixel target, not a 12-pixel cross.
- The toast container is pointer-transparent, so it cannot swallow a click meant
  for the interface behind it.

## Suggested articles

- [The regex builder](regex-builder.md)
- [Command palette](command-palette.md)
