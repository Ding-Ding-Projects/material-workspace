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
