# Handoff

Written for whoever picks this up next. Every figure here was measured, not
remembered — the commands that produce them are given so you can disagree with
any of it.

## Where it stands

All nine applications exist, are wired into the shell, and are verified against
the real built window rather than against mounted components.

| | Count | How to check |
| --- | --- | --- |
| Unit tests | **331** across 20 files | `npm test` |
| Checks driven against the built artifact | **245** across 10 drives | see below |
| Documentation articles | 28 | `docs/features/` |
| Project lines | 46,939 (41,628 non-blank) | `npm run lines` |

`npm test` builds the TypeScript suite and refuses to report success on a run
that executed nothing — see the warning below about what it used to do.

## The nine applications

| Application | Engine tests | Window checks | The thing it gets right |
| --- | --- | --- | --- |
| Writer | 22 | 19 | Own document model, not `contenteditable`; CJK line breaking |
| Sheets | 44 | 40 | Virtualised grid; dependency-ordered incremental recalc |
| Slides | 11 | 20 | Presenter view is a **separate rendering**, so notes cannot reach the projector |
| Notes | 19 | 23 | Computed backlinks; Unicode-aware tags |
| Draw | 23 | 21 | Stored transforms that never bake; the export **is** the rendering |
| Formula | 24 | 15 | MathML where the element decides how it is read aloud |
| Database | 27 | 17 | Null as its own value; a query builder with no injection surface |
| Forms | 19 | 19 | Design and Fill are one rendering, not a preview that can drift |
| PDF | 18 | 16 | Redaction removes the **bytes** and then proves it |

Plus 55 checks on the shell itself and 14 on the documentation site.

## How to verify all of it

```powershell
npm test                                    # 331 unit tests
npm run build                               # bundles, with a freshness assertion
npx tsc --noEmit -p tsconfig.json           # type check
node scripts/build-site.mjs                 # documentation site
```

For the window checks, launch the built application on an off-screen desktop
with a debugging port (`node scripts/launch-headless.mjs` prints the exact
command), then:

```powershell
node scripts/drive-ui.mjs        # 55  the shell
node scripts/drive-writer.mjs    # 19
node scripts/drive-sheets.mjs    # 40
node scripts/drive-slides.mjs    # 20
node scripts/drive-notes.mjs     # 23
node scripts/drive-draw.mjs      # 21
node scripts/drive-formula.mjs   # 15
node scripts/drive-database.mjs  # 17
node scripts/drive-forms.mjs     # 19
node scripts/drive-pdf.mjs       # 16
```

Every drive proves it is talking to exactly one page target before it touches
anything, and every one reloads first so its result does not depend on which
drive ran before it.

## Warnings for whoever is next

**`npm test` used to match zero files and exit 0.** It globbed
`test/**/*.test.mjs` while the tests are TypeScript bundled into `.tmp/test`.
Node printed `tests 0, fail 0` and exited cleanly — a perfectly green run of an
empty set. Every `npm test` before commit `b65e7d8` proved nothing while
reading as proof. The runner now refuses three ways: zero tests, a file that
ran no tests, and a total below a recorded floor. All three were watched going
red before being trusted.

**Unit tests cannot see the wiring.** Roughly a third of the defects found in
this project were invisible to a passing suite and appeared the first time the
built window was driven: seven CSS custom properties that do not exist (so
every padding silently resolved to zero and two cells rendered as one number),
focus lost after committing a cell edit, a preview that blanked on every
keystroke while its own comment claimed otherwise, the browser's own `required`
attribute blocking a form's real validation from ever running.

**Look at the captures.** Several defects passed every automated check and were
only visible in a screenshot. Each drive writes one to `.tmp/ui-drive/`.

**A red test is a claim about the test too.** Three PDF tests failed while the
writer was correct: they located the cross-reference table with
`lastIndexOf('xref')`, which finds the tail of `startxref`.

**One unexplained crash.** During the Forms pass the Electron process died once
after roughly twenty consecutive drive cycles, each of which reloads the page.
It has not recurred across many further runs and the cause is not known. Noted
as an observation, not as fixed.

## Guards, and the fact that each was watched failing

- **Build freshness** — a failed build cannot pass on stale output. Caught a
  genuinely stale build on its first run.
- **Test floor** — zero tests, an unloadable file, or a collapsed total all
  fail.
- **Undefined CSS tokens** — any `var()` naming a property that is never
  declared. Written after seven such references shipped.
- **Control bytes in source** — an invisible separator, one of which sat inside
  the tamper-evident audit hash.
- **Source hygiene tripwire** — every derived work list asserts it found
  something. The CSS-token guard's own first version swept six bundled files
  instead of the tree and was caught by exactly this.
- **Article completeness** — the site build fails if an article on disk missed
  the bundle.
- **Icon embedding** — proven to discriminate against the unmodified framework
  binary.
- **Append-only history** — restore adds a commit; it never rewinds.

## What is not built

Phase 1 of the plan still owes: per-element appearance editors, the infinite
colour picker, the narrator and its voice pickers, School mode, toy locks and
the unlock ladder, automatic updates, tab docking and grouping with the four
tab searches, and the per-surface completeness inventory with its negative
regressions.

Phase 2 owes the history panel, exports across every surface, and the changelog
viewer. Phases 6, 7 and 8 — governance, the collaboration server, and the full
evidence matrix — have not been started.

Per-application gaps are listed at the end of each article. The largest are:
PDF page rendering, Draw resize and rotation handles, Sheets charts and number
formats, Writer tables and footnotes, and persistence for Notes, Forms and
Database, none of which survive a restart yet.

## Conventions that are load-bearing

- **Nothing is claimed without a number beside it**, and the command that
  produces the number is in the article.
- **Every export names what it drops before it runs**, counted from the actual
  document rather than described generically.
- **A state is stated in words**, never only by colour or an icon: "Hidden",
  "Pinned", "Locked", "required", "not answered", "empty".
- **A guard nobody has watched fail proves nothing.** Break it, see red,
  restore, see green — every one above went through that.
