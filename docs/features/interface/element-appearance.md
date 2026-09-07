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

## What is not built yet

The editor changes properties. It does **not** have layer stacks, masks, blend
modes, adjustment layers, or the rest of a full image-editing workspace.

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

- `test/appearance/element-style.test.ts` - 46 tests over the model, including
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
- Captures `33-element-menu.png`, `34-element-appearance.png`,
  `35-element-appearance-reset.png` and `36-element-presets.png` come from that
  run against the real build.

## Related

- [The regex builder](regex-builder.md) - the editor's own search field uses it.
- [Command palette](command-palette.md) - another route to a setting.
- [Tabs and navigation](tabs.md) - tabs are elements too, and take their own
  appearance.
