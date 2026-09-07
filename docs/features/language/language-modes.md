# Language modes and funny levels

**Status: built and verified.**

## Three modes

| Mode | What you see |
| --- | --- |
| English | English only |
| Cantonese | Playful Hong Kong Cantonese only |
| Bilingual | English prominent, with a compact Cantonese line beneath |

Bilingual mode keeps the two as **separate elements** rather than one joined
string. A concatenated label removes any chance of laying the two out properly,
and it is where clipping starts at narrow widths.

Set it in **Settings → Language**, or from the command palette.

## Two funny levels, set independently

One slider for English, one for Cantonese, each from 1 to 5. **Both ship at 5.**

They are independent because they are read by different people in different
moods, and because a person comfortable with playful Cantonese may want English
that reads straight.

| Level | Reads like |
| --- | --- |
| 1 | Fully professional |
| 3 | Light |
| 5 | Maximum playfulness |

## The rule that governs every string

**The funny level changes voice, never facts.**

At any level a message still names what happened, what is affected, and what your
options are, in unambiguous words. Humour wraps the facts; it never replaces,
softens or omits them.

Compare the same message about a missing build timestamp at level 1 and level 5:

> Not available. This build recorded no timestamp.

> Not available. This build never wrote down its own birthday, and inventing one
> would be a lie you could not check.

The tone moves a long way. The instruction does not move at all, and neither does
what you now know.

This applies to **every** category with no exemption — errors, warnings and
destructive confirmations included. You are told plainly what the setting affects
before you opt in, so nothing is carved out of it.

Interpolated values — counts, paths, versions, error text — are substituted
verbatim at every level and are never restyled.

A change that makes a message funnier and less clear is a regression. A warning
nobody can act on is a broken warning, not a funny one.

## Emoji in dialogs

A separate switch adds a relevant emoji to dialogs and message boxes. Emoji never
appear in buttons, field labels, accessible names, or anything assistive
technology reads as information — decoration must never be the only thing
carrying meaning.

## Fonts

Cantonese and bilingual modes merge a CJK-safe font stack, so Traditional Chinese
never falls back to a font with no coverage and renders as boxes.

## Suggested articles

- [Personal vocabulary](personal-vocabulary.md)
- [Command palette](../interface/command-palette.md)
