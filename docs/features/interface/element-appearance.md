# Editing the appearance of one element

Right-click anything the application draws. The menu that opens belongs to that
exact element, and **Edit appearance...** opens a small editor anchored beside
it. Hold Shift while right-clicking to skip the menu and open the editor
directly.

Keyboard: focus the element and press <kbd>Shift</kbd>+<kbd>F10</kbd>, or the
Menu key if your keyboard has one. The menu and everything in it works without a
pointer.

## What you can change

Twenty-four properties, grouped:

| Group | Properties |
| --- | --- |
| Typography | Font, size, weight, style, small caps, capitalization |
| Text | Underline, strikethrough and overline with their own style and colour, superscript and subscript, alignment, direction |
| Colour | Text colour, highlight, border colour |
| Spacing | Character spacing, word spacing, line height, inner space |
| Shape | Corner radius, border width, border style |
| Effects | Shadow, opacity, glow, outline |

Every colour control is the infinite colour picker used everywhere else, so a
colour can be entered or read back in any notation it supports.

The editor has its own search field with its own regular-expression builder,
because twenty-four rows is more than anybody wants to scroll through to find
line height.

## Saved styles

Set what you want on one element, type a name into the presets row, and press
**Save**. The name then appears in the list on every element's editor, and
**Apply to this element** puts the whole saved look onto whatever you are
editing.

Applying **replaces** what was on the element rather than merging into it. A
merge would leave whatever happened to be set already mixed in with the preset,
so the same preset would give a different result on every element it touched -
which is the one thing a preset exists to prevent.

Saving from an element with nothing customized is refused with that reason,
rather than saving an empty style that would sit in the list doing nothing.

## Copying a look

**Copy appearance** in an element's right-click menu takes its overrides;
**Paste appearance** on another element puts them on. Both items are always in
the menu: when there is nothing to copy, or nothing has been copied yet, the
item is disabled and says which. A menu whose shape changes under the pointer is
a menu nobody learns.

Pasting replaces, for the same reason applying a preset does.

## Layers

Below the presets row is a stack. Add a solid fill, a gradient, a drop shadow,
an inner shadow, a ring, or a backdrop blur; each one gets its own opacity and
its own blend mode from the sixteen CSS provides.

The list reads **top first**, and that is also the paint order, so what you see
at the top of the list is what sits on top of the element. Every layer can be
hidden, locked, moved up or down, duplicated and removed.

Nothing here is destructive:

- **Hiding** a layer stops it painting and leaves it in the list with every
  value it had, so it comes back exactly as it was.
- **Locking** a layer refuses edits, moves and removal *out loud*, naming the
  layer. A lock that silently swallows an edit is worse than no lock: the
  control moves, nothing happens, and there is no way to learn why. Unlocking is
  always allowed, or a lock could never be undone.
- **Moving** stops at the ends rather than wrapping round. A layer that jumps
  from the top to the bottom because you pressed up once too often is a surprise
  nobody wants from an ordering control.
- **Duplicating** always produces an unlocked copy, whatever the original was -
  editing it is the one thing you are about to do.

Opacity is folded into each layer's own colour rather than applied to the
element. Using the element's own opacity would fade its text and its children
along with the decoration, which is the classic mistake and the one that makes a
layer stack useless on anything with words in it.

## What is not built yet

There are no pixels here, so there is no brush, no eraser, and no arbitrary
mask - a mask is the element's own shape, because an element has exactly one.

That is a decision rather than an omission. The alternative is rendering the
element to a canvas and showing a picture where the control used to be, which
takes its accessible name, its focus ring and its selectable text with it. A
prettier button nobody can tab to is a worse button.

This is stated here rather than left to be discovered, and the project's
completeness inventory carries the same gap as an open row.

## Resetting

Three separate actions, all always available:

- **Reset** beside any single property returns that one property.
- **Reset this element** at the foot of the editor returns everything on it.
- **Reset this element** in the right-click menu does the same without opening
  the editor, and is disabled with a reason when there is nothing to reset.

Nothing is destroyed by an override. Your value is stored beside the value the
application shipped, never instead of it, so a reset genuinely returns to what
shipped rather than to a remembered guess.

## How an element is identified

Overrides are stored under a short key derived from the element: an explicit
identity the surface declared, or failing that the nearest few class names.

The key is deliberately **short**. A full path from the window root would encode
every container in between, so inserting one wrapper - a layout change nobody
thinks of as breaking anything - would rename every stored style beneath it and
your work would silently stop applying. A short key can occasionally match two
similar elements; a long one is guaranteed to break eventually. A visible
collision is a better failure than silent loss.

## Configuration and storage

Overrides live in your settings file under `appearance.elementStyles`, as data:

```json
{
  "appearance": {
    "elementStyles": {
      "tab": { "fontSize": "18", "color": "#c62828" }
    }
  }
}
```

They are stored as **values, not as CSS text**. A stylesheet fragment in a
settings file would have to be parsed back before a control could show it, and
would be an injection surface in a file that anybody can open in an editor.

## Failure modes

**A value the editor refuses.** Reported in words above the rows, naming the
range or the reason, and nothing is written. What you typed is left where it is
so you can correct it rather than retype it.

**A property this engine does not fully honour.** The control stays visible and
says so. Text outline is the current example: it renders here and may be ignored
if the same theme is opened by another engine. A control that vanishes reads as
a build that forgot it rather than as a limitation somebody decided.

**A settings file edited by hand, or a theme imported from elsewhere.** Every
value is checked again on the way in, by exactly the rules the editor uses.
Anything that fails is skipped and *reported*, never silently dropped - an
import that quietly discards half a theme is an import that looks like it
worked.

**A stored property this version no longer knows about.** Skipped rather than
written blind, so an old theme cannot put an unknown property name into the
page.

## Security

The stored value reaches a style attribute, so this is the one settings field
that is not treated as ordinary text.

Colours are accepted only as a hex value, a colour function, or a colour name.
Font names are accepted only as letters, digits, spaces and the few punctuation
marks fonts really use. Both shapes are closed: there is nowhere in them to put
a `url()`, a semicolon that would end the declaration, or a brace that would
escape it. Everything else is a fixed list of values chosen by the editor
itself.

## Verification

- `test/appearance/element-layers.test.ts` - 30 tests over the layer stack. The
  order test was watched failing on a deliberately reversed `compose` before
  being trusted, because reversing it is the change that puts every stack upside
  down while every counting test keeps passing.
- `test/appearance/element-style.test.ts` - 46 tests over the property model,
  including
  a set of deliberate injection attempts through both the colour and the font
  paths, and the identity rules.
- `scripts/drive-appearance.mjs` - drives the built application: opens the menu
  from a real right-click, checks the shortcut and the disabled reason are shown,
  filters the menu to nothing and checks it says so, opens the editor with
  Shift, sets a size and **measures the rendered element** to confirm it really
  changed, sends a refused value and checks nothing moved, then resets and
  checks the element returned.
  It then saves a preset, clears the element, applies the preset back and
  measures again, and copies a look onto a second element through the menu.
- Captures `40-element-menu.png`, `41-element-appearance.png`,
  `42-element-appearance-reset.png`, `43-element-presets.png` and
  `44-element-layers.png` come from that run against the real build. The layer
  checks measure the rendered `box-shadow` and `background-image` rather than
  the stored values.

## Related

- [The regex builder](regex-builder.md) - the editor's own search field uses it.
- [Command palette](command-palette.md) - another route to a setting.
- [Tabs and navigation](tabs.md) - tabs are elements too, and take their own
  appearance.
