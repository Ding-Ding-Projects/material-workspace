# Sheets

**Status: built and verified.** 44 engine tests plus 20 checks driven against
the real built window. It is the second of the nine applications to exist.

## What it is

A spreadsheet with its own formula parser, its own evaluator, its own
dependency graph and its own function library. Nothing else has to be
installed.

Open it from the front screen, from the tab strip, or from the command palette.

## The grid is virtualised, and that is the architecture

The addressable grid is 16,384 columns by 1,048,576 rows. That is sixteen
billion cells, so a node per cell was never an option — the only question was
whether virtualisation went in at the start or got retrofitted after the first
person opened a real workbook.

Only the cells inside the viewport exist, plus a few rows and columns of
overscan so a fast scroll never shows a blank band. A spacer element gives the
scrollbar its size.

What you can scroll to is smaller than what you can address: 20,000 rows. A
scrollable area a million rows tall is 26 million pixels, and browsers do not
reliably scroll past a few million — the result is a scrollbar that jumps and a
bottom you cannot reach, which reads as a bug rather than a limit. Formulas
still address the whole grid.

## Recalculation is incremental

Editing a cell marks it dirty, dirtiness spreads forward through everything
that reads it, and the dirty set is evaluated **in dependency order**.

The order is the point. Recomputing the edited cell and then whatever depends
on it is the obvious approach and it is wrong: a dependent may itself depend on
something not yet recomputed, so it reads a stale value and produces a number
that is confidently incorrect.

The walk uses an explicit stack rather than recursion, because a column of
running totals thousands deep is entirely ordinary. There is a test that builds
a chain 5,000 long.

### Cycles

Detected, never prevented. Typing a formula that closes a cycle is a legitimate
thing to do by accident, and the answer is a circular-reference error **in every
cell of the cycle** — not a hang, not a stack overflow, and not one arbitrary
member reporting the error while the rest show numbers that depend on which cell
happened to be visited first.

Breaking the cycle restores real values immediately.

## The compatibility rules

Each of these is a decision that looks like a bug until you know why:

| Rule | Why it is not a bug |
| --- | --- |
| A blank cell is 0 in arithmetic | …but `COUNT` does not count it and `AVERAGE` does not include it. One "blank means zero" shortcut makes an average over a partly empty column quietly wrong. |
| Text sorts above **every** number | So a number is never greater than text. Surprising exactly once. |
| Comparison binds looser than arithmetic | `1+2=3+4` is one comparison of two sums. |
| Exponentiation is left-associative | `2^3^2` is 64, not 512. Mathematics disagrees; every mainstream spreadsheet does not. |
| `MOD` takes the sign of its **divisor** | The opposite of a remainder operator, so it cannot be written as one. |
| `INT` floors | `INT(-2.5)` is −3, not −2. |
| `ROUND` is half-away-from-zero | `ROUND(-2.5)` is −3. `Math.round` gives −2. |
| `VLOOKUP` defaults to **approximate** | The single most surprising thing about it, and the source of most wrong lookups. Preserved for compatibility rather than improved. |
| `FIND` is case-sensitive, `SEARCH` is not | And a miss is an error, not 0. |

`IF`, `IFS`, `AND`, `OR`, `IFERROR` and `IFNA` are **lazy**. An eager `IF` makes
`IF(A1=0, "n/a", B1/A1)` divide by zero anyway — that is, it breaks the exact
guard everybody writes.

## Errors

Real values, not text that looks like an error. `#DIV/0!`, `#VALUE!`, `#REF!`,
`#NAME?`, `#NUM!`, `#N/A`, `#NULL!` and a circular-reference error.

They propagate, and the **first** error wins, so the reported error names the
original cause rather than whatever noticed it last.

## Alignment tells you the type

Numbers align right, text aligns left, booleans centre, errors centre in red.

This matters more than it looks: text that *resembles* a number stays
left-aligned, so the difference between a real number and text that looks like
one is visible without clicking the cell. That difference is behind most of the
"why will it not add up" questions any spreadsheet ever receives.

Type a leading apostrophe to force text — a part code, a phone number with a
leading zero, a version string. A number long enough that it would not survive
double precision is kept as text rather than silently losing its last digits.

## Bounds

A formula cannot take the application down:

- A range wider than 1,048,576 cells is refused rather than materialised.
- `REPT` refuses to build a string beyond 32,767 characters.
- The status-bar aggregate stops at 10,000 cells, because summing a whole
  column on every arrow key would make the grid unusable to answer a question
  nobody asked.
- Ranges up to 4,096 cells are tracked cell-by-cell in the dependency graph;
  larger ones are tracked against their sheet, so a whole-column reference does
  not allocate a million graph entries.

## Keyboard

| Key | Does |
| --- | --- |
| Arrows | Move |
| <kbd>Ctrl</kbd> + arrows | Move a screenful |
| <kbd>Shift</kbd> + arrows | Extend the selection |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / previous cell |
| <kbd>Enter</kbd> | Edit, then commit and move down |
| <kbd>F2</kbd> | Edit in place |
| <kbd>Esc</kbd> | Abandon the edit |
| <kbd>Home</kbd> | First column of this row |
| <kbd>Ctrl</kbd>+<kbd>Home</kbd> | Cell A1 |
| <kbd>Ctrl</kbd>+<kbd>End</kbd> | End of the data, not end of the grid |
| <kbd>Delete</kbd> | Clear the selection |
| Any character | Start editing with it |

## Verifying it yourself

```powershell
npm test                          # 110 tests, 44 of them the sheet engine
node scripts/drive-sheets.mjs     # 20 checks against the real window
```

The window checks type through the same events a keystroke produces, and
navigate to an exact cell before every write rather than assuming where the
previous commit left the caret.

They also **measure** two things rather than reading them off the stylesheet:
that a cell has real horizontal padding, and that its font size resolved. The
first version of the stylesheet referenced seven custom properties that do not
exist in this project, so every padding silently became zero — `100` in A1 and
`0012` in B1 rendered flush against each other and read as one number,
`1000012`. Every automated check passed. Only a capture showed it.

## Not built yet

Per-column widths, sorting and filtering, charts, pivot tables, conditional
formatting, number-format strings, multi-sheet tabs in the UI, and `.xlsx` and
`.ods` import and export. The engine already supports several sheets and
cross-sheet references; there is no UI for adding one.

## Suggested articles

- [Writer](writer.md)
- [Autosave and document history](../saving/autosave-and-history.md)

## Filtering

Choose a column, a comparison and a value, then press **Filter rows**. It hides
what does not match.

**It hides. It never removes.** A spreadsheet that deletes what a filter
excludes loses data every time somebody narrows a view, and the loss is
invisible until they clear the filter and find the rows gone. So the sentence
after every filter says so, and **Clear filter** brings every row back.

The comparisons are chosen, not assumed. A button that applies a rule nobody
picked is a decorative control: it does something, and the person who pressed it
cannot say what.

What the comparisons do with the things that are **not values**:

| | |
| --- | --- |
| A blank | Matches **nothing** except *is blank*. Treating it as `0` makes "less than 10" select every empty row in the sheet; treating it as `""` puts it in the same bucket as a cell somebody deliberately cleared |
| An error | Matches nothing except *is an error*. Stringifying it makes "contains 0" select every `#DIV/0!` in the column |
| A number stored as text | Is **not** the number. `"10"` sorts before `"9"` as text and after it as a number, so coercing gives an answer that is right for one reading and wrong for the other with nothing to say which happened |
| A word compared to a number | Not comparable, and therefore not a match. Inventing an ordering puts rows in a filtered view nobody asked for |

The header row always stays visible. Filtering it out is what makes a filtered
table unreadable.

Text comparison ignores case and **keeps accents**. Somebody filtering for
"smith" expects "Smith"; nobody filtering for "resume" expects "résumé", and
folding accents merges names that are genuinely different people.

## Charts

Select a range where the first column is the categories and every other column
is a series, then press **Chart**.

**A bar chart's axis always includes zero.** Bar length *is* the comparison, so
an axis starting at 90 makes 91 look twice 90. A line chart may crop, because
position rather than length carries the meaning - and when it does, the chart
says so on itself. A reader who cannot see that an axis is cropped reads the
exaggeration as the data.

Other things the chart refuses to do:

- **A blank is a gap, not a zero.** Plotting it as zero draws a bar to the floor
  and the reader sees a month with no sales rather than a month nobody has
  entered yet. The note under the chart says how many values were not drawn.
- **A line does not join across a gap.** A line drawn through missing data
  asserts a value nobody recorded.
- **An error is a gap too**, for the same reason with an extra step.
- **Flat data still draws.** Every value equal gives a zero-height range;
  dividing by it puts every point at `NaN`, which draws nothing at all and looks
  like a chart that failed to load rather than one with flat data.
- **A negative bar draws downward from the baseline.** Pinning every bar to the
  bottom of the plot loses the sign, and a chart of temperatures reads as though
  every month were above freezing.

Ticks land on 1, 2, 2.5 or 5 times a power of ten. An axis from 0 to 97 with
five ticks otherwise gives 19.4, 38.8, 58.2 - technically correct and
unreadable.

The chart is an SVG with an accessible name. A chart with no accessible name is
a chart that does not exist for anybody using a screen reader.
