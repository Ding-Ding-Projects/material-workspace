# Handoff

Written for whoever picks this up next. Every figure here was measured on
`6571a7e`, not remembered — the command that produces each one is given, so you
can disagree with any of it.

**The previous version of this file was badly stale**: it claimed 331 tests and
245 driven checks against a real 1,150 and 414, and it described an application
set three lanes out of date. That is the failure this document exists to
prevent, and it is worth knowing it happened here.

## Where it stands

All nine applications exist, are wired into the shell, and are verified against
the **real built window** rather than against mounted components.

| | Count | How to check |
| --- | --- | --- |
| Unit and engine tests | **1,150** across 52 files | `node scripts/run-tests.mjs` |
| Checks driven against the built artifact | **414** across 13 drives | see below |
| Format conformance | **31 real files** off disk, 57 checks | in the suite above |
| Layout matrix | **0 findings across 960 tuples** | `node scripts/drive-layout.mjs <port>` |
| Feature inventory | **94 of 95** built, the one gap named | in the suite above |
| Documentation articles | 27 | `docs/features/` |
| Project lines | 94,833 (84,410 non-blank) | `npm run lines` |

## How to verify any of it

```powershell
.\build.bat --run                 # fresh Windows to a running application
node scripts/build.mjs            # just the bundles
node scripts/run-tests.mjs        # the whole suite
node scripts/launch-headless.mjs 9344   # prints the launch command
node scripts/drive-writer.mjs 9344 .tmp/ui-drive
node scripts/drive-layout.mjs 9344 .tmp/ui-drive
```

The drives **attach** to a running instance; they do not launch one. Launch it
through the cheap headless route with the command `launch-headless.mjs` prints,
then confirm `http://127.0.0.1:9344/json/list` returns **exactly one** target of
type `page` before driving anything. More than one means the profile picked up
state that is not yours, and every capture after that is about a window you did
not build.

## Two things about this codebase that will cost you a day each

**Roughly a third of the real defects this session were invisible to a green
unit suite.** They were found by reading a capture or by measuring the running
window. The union of two rectangles rendered as a self-crossing tangle while the
shape count, the layer name and the status line all read correctly. A stretchy
bracket carried its attribute and rendered 24 pixels tall beside a 64-pixel
matrix. An empty-canvas message claimed the PDF engine could not decompress —
true when written, false about the product the moment it stopped being true.
**Measure the built artifact; do not read the config and conclude.**

**A backslash inside a template literal handed to the page is eaten before the
page sees it.** `\s` arrives as `s` and `\d` as `d`. Two of these were found
this session, and one had been silently disabling a Database check for its
entire life. `test/source/hygiene.test.ts` now follows a template literal across
lines and will catch the next one — but build patterns from `[0-9]` and literal
separators rather than character classes when the expression crosses that
boundary.

## What is not built, and is not pretending to be

`ROADMAP.md` is the authority; 33 items are unticked and each says what it
covers. The ones most likely to be asked about:

- **Merged table cells, cell shading, captions, text wrap around an image,
  cropping.** Tables and images round-trip through `.docx` and `.odt` with
  bytes, grids, header rows, relationships and manifest entries — but none of
  the above.
- **PDF annotations, form fields, signatures.** Compressed streams decode on
  both the read and the draw path; those three do not exist.
- **Sheets multi-sheet UI.** Sorting, number formats and column widths are
  built; the workbook holds several sheets and the interface shows one.
- **Writer change-tracking review.** Deletions are retained in the model and
  excluded from export; there is no interface to accept or reject them.
- **The release workflow has never been observed green.** It is written and
  YAML-validated. Account-level Actions is disabled, which returns
  `HTTP 422: Actions has been disabled for this user` on dispatch — an external
  blocker, not a failed build.

## The rule this project keeps and you should too

**A guard nobody has watched fail proves nothing.** Every inventory row added
this session was broken on purpose — by a rename that still compiles, not by
deleting the file — watched go red, and restored. Two guards written earlier
stayed green under a deliberate break, which was more informative than any
passing run: one anchored on a descendant selector, the other on a substring a
rename could carry with it. Anchor to line starts, and break it before you trust
it.

## Where the work is

One Gerk Tong Hui, one jer, no stashes. `main` at `6571a7e`, dewed and proved
with `git ls-remote`. Nothing is waiting in a branch or a worktree.
