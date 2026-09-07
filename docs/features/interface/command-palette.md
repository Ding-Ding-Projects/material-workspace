# Command palette

**Status: built and verified.** Driven against the real built window.

## Opening it

`Ctrl+Shift+F`. One discoverable global shortcut, everywhere in the product.

Not `Ctrl+K`: that combination is claimed by too much else, and this project uses
a single documented shortcut rather than one that competes.

The shortcut matches on the key **code**, not the character. With a non-US
keyboard layout the character produced by that physical key can be something else
entirely, and a shortcut matched on the character works on the author's keyboard
and nowhere else.

## What it contains

The whole product, searchable: every command, every destination, and every
setting.

| Kind | What it does |
| --- | --- |
| Command | Does something, and shows the shortcut that actually works |
| Destination | Goes somewhere, and reveals the exact element |
| Setting | **Is** the control |

## A setting row is the control

A setting result renders its live switch, stepper or select **inline**, wired to
the same code the settings surface uses.

Somebody who can see a value has usually come to change it, and sending them
somewhere else to do that is a round trip the interface could have saved. More
importantly, two paths to one value that disagree is a defect; sharing the code
makes disagreement impossible rather than unlikely.

Each row also says whether its value was genuinely changed or is the compiled-in
fallback. That signal requires **both** that the key is present on disk and that
its value differs from the shipped default — because the application persists
whole objects, and a key can be on disk purely because a sibling changed.

## Destinations teleport

Selecting a destination opens the owning surface, reveals the exact element,
scrolls it into view, focuses it and highlights it briefly. Landing on a general
page and leaving you to hunt does not satisfy that.

The highlight clears on a timer and on your next interaction, so no stray outline
is left behind.

## Search

The palette has its own search field with its own anchored regular-expression
builder, like every other search field here. It matches on **both** languages
regardless of the active mode, so a Cantonese term finds its row while the
interface is in English.

## Size

A bounded card or the full window, your choice, persisted. The bounded card is
the default: a full-window palette showing six results is a lot of empty space.

## Keyboard

Arrow keys move, Enter activates, Escape closes and focus returns to wherever it
came from. Focus stays in the search field while the active row is announced
through `aria-activedescendant`, so typing never stops working.

Enter inside a setting's own control adjusts that control and does not also
activate the row.

## Suggested articles

- [The regex builder](regex-builder.md)
- [Tabs and navigation](tabs.md)
- [Language modes and funny levels](../language/language-modes.md)
