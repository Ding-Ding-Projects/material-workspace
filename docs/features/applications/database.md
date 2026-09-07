# Database

**Status: built and verified.** 27 engine tests plus 17 checks driven against
the real built window. The seventh of the nine applications to exist.

## Null is its own value

This is the whole reason a database is not a spreadsheet. "We do not know this
person's age" and "this person is zero years old" are **different facts**, and
every place they can be collapsed is a place where a wrong number looks right.

So:

- An empty value in a text column is an empty **string**; in every other column
  it is the **absence** of a value.
- A null never satisfies an ordered comparison. Treating it as zero is how a
  row with a missing value silently joins a "less than ten" result.
- `isEmpty` and `isNotEmpty` exist precisely because comparisons cannot find
  nulls.
- An average skips nulls. Counting them as zero turns 41 over two into 41 over
  three, and the answer looks perfectly reasonable.
- An aggregate over no numbers is **null**, not zero. Zero is a plausible
  answer to a question that has none.
- The grid shows an unknown value as *empty* rather than as blank space,
  because rendering it as nothing is exactly the collapse this all exists to
  prevent.

## The query builder is controls, not a text box

That is not a simplification — it is the security property. A value the user
types **never becomes part of an expression**, so there is nothing to escape
and no injection surface to get wrong.

The cost is real: a query this cannot express cannot be written. That limit is
stated rather than worked around with a "raw query" escape hatch, which would
reintroduce the entire problem it was designed out of.

Two smaller decisions:

- A typo in a column name is an **error**, not a query that silently matches
  nothing. An empty result reads as "there is no such data", which is a
  different and much more misleading answer.
- A half-built filter with no value yet is ignored rather than matching
  nothing, so the grid does not empty itself while somebody is still typing.

## Constraints are enforced on write

A store that accepts a row and reports the problem afterwards has already lost
the guarantee that made the constraint worth declaring: every reader from that
moment on has to handle data the schema says cannot exist.

**Every problem is reported at once**, beside the field it belongs to. One
problem per attempt turns filling in a form into a guessing game, and a list at
the bottom says that something is wrong without saying which box.

Editing a row does not clash with **itself** — without that exemption, saving
an unchanged row reports its own key as a duplicate and nothing can ever be
edited.

## Deleting is refused, never cascaded

A delete that quietly removes rows in other tables is the most destructive
default a database can have, and it is not recoverable from an interface. A row
that others point at cannot be deleted, and the refusal says how many rows
depend on it.

A foreign key pointing at a table that **does not exist** is refused too. A
validator that silently skips the check when it cannot see the other table
passes on exactly the data it was written to refuse.

## Dates are dates, not instants

Stored as `2026-03-15`, never as a timestamp. A date with no time is not an
instant, and turning it into one attaches a timezone that was never in the
data — which is how a birthday moves by a day.

`2026-02-30` is **refused**. Almost every date library turns it into the second
of March, so a typo silently becomes a different real date.

## Two form decisions that came from driving it

**The browser's own validation is off.** A native `required` attribute blocks
submit entirely, so the engine's validation never runs — and the engine reports
everything at once, in place, where the native bubble shows one thing at a time
and then vanishes. `aria-required` keeps the accessible semantics without
taking over the submit.

**A number field is text with a numeric input mode**, not `type="number"`. A
number input discards anything non-numeric before any script sees it, so the
engine's own message — which names the column and quotes the value — could
never be shown. The numeric keyboard still appears on a phone.

## The status line

Row counts, and a real aggregate over the **visible** rows, so a filtered view
answers the obvious question without anybody building a report.

A confirmation appears **beside** the counts rather than instead of them. The
first version replaced them, so the moment somebody added a row the numbers
they were watching vanished.

## Verifying it yourself

```powershell
npm test                          # 294 tests, 27 of them the data engine
node scripts/drive-database.mjs   # 17 checks against the real window
```

## Not built yet

Editing an existing row, creating or altering tables from the interface, joins
across tables, grouping, reports, indexes, transactions, import, and
persistence — the sample data is rebuilt on every launch.

## Suggested articles

- [Sheets](sheets.md)
- [File formats](../files/formats.md)
