# Forms

**Status: built and verified.** 19 engine tests plus 19 checks driven against
the real built window. The eighth of the nine applications to exist.

## Design, Fill and Responses are modes, not separate surfaces

The whole value of a form builder is that **what you designed is what people
see**. A preview that renders differently from the real thing is worse than no
preview at all: it tells you the form is fine right up until somebody uses it.

So Fill renders from the same definition the designer edits, through the same
code. There is no second rendering path that could disagree.

## Help text is part of the field

Somebody who does not know what a field wants fills it in wrongly and then
blames themselves. So the format, the range and the reason are declared where
the field is declared, and are **always rendered** — never hidden behind a
tooltip nobody hovers.

The help text and any problem are both referenced from the field, so a screen
reader reads the guidance **and** what went wrong rather than one or the other.

## Required is a word

Not an asterisk. An asterisk means nothing until somebody finds the legend
explaining it, and a screen reader announces it as "star".

## An optional choice can be left unanswered

A `<select>` with no explicit empty option silently pre-selects its first
choice, which then becomes an answer nobody gave. There is a "No answer" option
at the top of every optional choice.

## Validation reports everything at once

One problem per attempt turns a form into a guessing game, and the person
filling it in has no way to know how many rounds are left. Every problem is
reported together, beside the field it belongs to, with `aria-invalid` and
`aria-describedby` wiring each message to its own field.

The browser's own validation is **off**, deliberately. A native `required`
attribute blocks submit entirely, so the engine's validation never runs — and
the engine is the half that reports everything at once and in place, where the
native bubble shows one thing and vanishes. `aria-required` keeps the
accessible semantics without taking over the submit.

Validation reuses the **data engine's** coercion. A form that validates
differently from the table it writes into accepts data the table then refuses,
and the person who filled it in is told nothing useful about why.

## Email is checked for shape, not against the specification

The real grammar permits addresses nobody types and rejects nothing anybody
does. This checks what people actually get wrong — a missing at-sign, a missing
dot, whitespace — and leaves the rest to the fact that a wrong address bounces.

Refusing a valid unusual address is worse than accepting an invalid ordinary
one.

## Problems with the form go to whoever is building it

A choice with no options, two fields sharing a label, a minimum larger than a
maximum, an unlabelled field: those are faults in the **form**, not in an
answer, so they appear in the designer rather than in front of the person
filling it in.

Two fields with the same label are refused because they are indistinguishable
in the results **and** to a screen reader, which reads the label and nothing
else.

## A skipped answer is shown as skipped

In the results table, an unanswered field reads *not answered* rather than
being left blank. A blank cell and a cell somebody deliberately left blank are
different facts, and rendering both as nothing loses the difference.

The summary says how many of the responses answered each field, so a question
everybody skips is visible without reading the whole table.

## Export

CSV, with the field **labels** as the header. Internal identifiers would
produce a file nobody can interpret without the form beside it.

## Verifying it yourself

```powershell
npm test                          # 313 tests, 19 of them the forms engine
node scripts/drive-forms.mjs      # 19 checks against the real window
```

## Not built yet

Only one form at a time, held in memory: neither the definition nor the
responses survive a restart. There is no sharing or publishing, no branching
between fields, no file upload, no multi-page forms, and no writing submissions
into a Database table — which is the obvious next step, since both already use
the same validation.

## Suggested articles

- [Database](database.md)
- [Notes](notes.md)
