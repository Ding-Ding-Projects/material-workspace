# Roadmap

A checklist, ticked only for work that is genuinely finished **and verified**. An
item that is written but unverified stays unticked with its state named beside
it. A roadmap full of optimistic ticks is worse than none, because it is the one
file a next owner trusts to tell them what is left.

## Phase 0 — Foundation

- [x] Repository created, MIT licensed, public
- [x] `build.bat` / `build-installer.bat` / `download-dependencies.bat`
- [x] Fresh-machine bootstrap that installs Node, Git and project dependencies
- [x] Electron binary recovery for the empty-`dist` failure — verified by recovering a real broken install
- [x] Build freshness assertion — verified: it caught a genuinely stale output on its first run
- [x] Build provenance frozen into the artifact at build time
- [x] Front screen showing version and build time to the second, with the timezone labelled
- [x] Atomic file writes with the Windows rename retry
- [x] Settings model covering the full feature contract
- [x] Document store with autosave into an isolated local Git repository
- [x] Append-only history: restore adds a commit, never rewinds — proven by a red-then-green break test
- [x] Tamper-evident audit log with hash-chain verification
- [x] Personal-vocabulary loader, fail-closed, shipping no mappings
- [x] Real-git test suite (9 tests), proven red-then-green
- [x] Original application mark, generated from code, embedded in the executable — verified against the unmodified framework binary so the check discriminates
- [x] Unsigned Squirrel.Windows installer produced and verified — `Setup.exe`, `RELEASES` and full `.nupkg`, Authenticode status `NotSigned`
- [ ] Release workflow publishing per push — written and YAML-validated; unverified until a run goes green
- [x] Documentation site — the same shell components, real articles read from docs/, 13/13 checks in an isolated browser including a phone viewport
- [x] Social preview graphic at the repository root — generated from code, 1280x640

## Phase 1 — Shell

- [x] Command palette on `Ctrl+Shift+F` — live controls inline, provenance per setting, teleport-and-reveal, own search with anchored regex builder
- [x] Search field with its own anchored regex builder, plain text by default (used on the application grid)
- [x] Settings surface, tabbed into five sections, each with its own search and anchored regex builder; every row explains itself and names the shipped value it would fall back to
- [x] Browser-style tabbed navigation with edge docking, roving tabindex and axis-correct arrow keys
- [x] The regex builder — engine capability matrix probed at run time, token-by-token explanation, static backtracking scanner, worker-based bounded evaluation; 18/18 checks driven against the real built application
- [ ] Per-element appearance editors
- [x] Infinite colour picker with the colour translator and the animated rainbow
  - [x] Continuous field, keyboard-operable, with a hue track that shows the hues
  - [x] Every notation translated, non-CSS ones marked, each copyable
  - [x] Contrast readout with a named verdict; gamut clipping reported
  - [x] The rainbow as a sentinel, animated by the stylesheet, settling under reduced motion
  - [ ] Eyedropper, named user presets, and theme import/export
- [x] Notification centre with bulk actions — severity-aware auto-dismiss, keyed replacement, bounded retention, honestly-scoped select-all, outcome reported rather than selection
- [x] Tab docking, reordering, pinning, grouping, and the four tab searches
  - [x] Layout model: pinning survives grouping, the active tab survives a collapse
  - [x] All four searches, each with its own query, regex opt-in and flags
  - [x] Bulk close with a preview that names what it kept and why
  - [x] The strip scrolls and reports what is out of view; nothing is clipped away
  - [ ] Drag reordering and the group editor in the strip itself
- [x] Narrator with per-language voice pickers
  - [x] Off by default; serialized queue so nothing overlaps
  - [x] Voices resolved by URI, list re-read when the platform reports a change
  - [x] Honest status per language, including no voice installed and no engine at all
  - [x] Rate and pitch per language; preview wired to the real engine
  - [x] Yields to an active screen reader, told by the operating system
  - [ ] Quiet-hours awareness
- [x] School mode: forces English and level 1, live, keeping the choice underneath
  - [x] Suppression list is hand-written, so a forgotten capability fails the check
  - [x] Rename guard: after a rename the shipped name must appear nowhere
  - [x] Refusal wording says nothing about the credential and always names recovery
  - [ ] The shared cross-application record, the unlock credential, and the surface itself
- [x] Attention modes — five, independent, all off by default, each with a real reader proven by measuring the running interface
- [x] Toy locks, Support Tickets, and the unlock ladder
  - [x] All six credential policies, each lock with its own independent credential
  - [x] A locked element refuses its action but stays an unlock target
  - [x] The ladder, with the skip budget that keeps it from being a second password
  - [x] Support Tickets: the recovery route, naming the real folder
  - [ ] The anchored per-element wizard, the PIN keypad, and TOTP verification
- [x] Destructive-action super confirmation, actually wired to destructive actions
  - [x] Reset-every-setting, from both the settings surface and the palette
  - [x] Deleting a Database row, naming the exact row rather than a count
  - [x] Hand-written inventory guard, red when a gate call is commented out
  - [ ] Discarding unsaved work, and deleting a Notes note or a Draw shape
- [x] Automatic updates: the feed model, its validation, and the ready banner
  - [x] Versions compared numerically, so 0.10.0 is not older than 0.9.0
  - [x] https only, no credentials, package hash and size both checked
  - [x] Persistent non-blocking banner; the restart is always the user's press
  - [x] The ready state says the installer is unsigned and why the warning appears
  - [x] A real feed read from this project's own releases, verified in the built app
  - [x] Download verified against the published hash; a wrong one is discarded
  - [x] Only a staged installer can be run, resolved inside the staging folder
  - [ ] Running the checks on the jittered background schedule rather than once
- [x] The per-surface completeness inventory and its negative regressions
  - [x] 35 hand-written rows; 31 built, 4 pending with their reasons reported each run
  - [x] Red when a proof is commented out, when a file is missing, and when emptied

## Phase 2 — Document core

- [x] History panel: browse, search, date picker, action filter, diff, restore
  - [x] Actions listed from what the engine has observed, counted in the current view
  - [x] Date picked or typed; a bad date is reported without wiping what was typed
  - [x] An unavailable history reads as a diagnosis, never as an empty archive
  - [ ] Labelling, pruning with its retention policy, and bulk selection
- [x] Export in every format that can faithfully carry the data
  - [x] Ten formats, each checked by parsing the output back rather than string-matching
  - [x] Warnings name the ACTUAL columns that would lose something, before it runs
  - [x] Filenames are names, proved unable to climb out of a folder
  - [ ] Wiring the shared writer into every surface's own export button
- [x] Bulk actions: a shared model, used by tabs, notifications and history
  - [x] Click, control-click and shift-click, each with a keyboard equivalent
  - [x] Select-all states WHICH all it means when the two differ
  - [x] The plan names what it kept and why, and the two counts stay separate
  - [ ] Writer, Sheets, Notes and Forms still select one at a time — Draw and Database mark many
- [x] Changelog viewer with commit links, generated from git on every build
  - [x] Every referenced commit is proved to exist, or the build fails
  - [x] Date range picked or typed, category filter, regex search, Markdown export
  - [x] Links open through an allowlisted host handler, never in the app window
  - [ ] Grouping by released version rather than by kind of change

## Phase 3 — Writer and Sheets

- [x] Text engine: blocks and runs, CJK-aware line breaking, pagination with keep-with-next — 22 tests against an injected deterministic measurer
- [x] Writer: a real editor over that engine, not contenteditable, with IME input through a hidden field — 13 checks driven against the real window
- [x] Sheet engine: formula parser, evaluator, incremental dependency-ordered recalculation, cycle detection, 90+ functions — 44 tests asserting exact values
- [x] Sheets: a virtualised grid over that engine — 20 checks driven against the real window, two of which measure rendered geometry rather than reading the stylesheet
- [x] Writer: footnotes, with space reserved on the line BEFORE it is placed rather than after — a footnote that steals space already given away pushes its own reference to the next page
- [x] Writer: a table of contents built in two passes, because the numbers move once the entries are inserted
- [x] Writer: tables that break at a row boundary, repeat their header row, and are drawn from the LAYOUT's geometry rather than by CSS
- [x] Writer: images that keep their proportions, move whole to the next page, and ask for their alternative text BEFORE going in
- [x] Writer: tables written into `.docx` and `.odt` and read back out of both, with six real fixtures in the conformance corpus
- [x] Writer: images written into `.docx` and `.odt` and read back out of both, media part, relationship and manifest entry included
- [x] Writer: an image can be dropped onto the page, and an undescribed one raises a row that will not go away until it is answered
- [ ] Writer: merged cells, cell shading, captions, text wrap around an image, change-tracking review
- [x] Sheets: filtering with real column, comparison and value controls, stating that rows are HIDDEN rather than removed
- [x] Sheets: charts drawn as real bars with an accessible name, saying how many blanks they could not draw
- [x] Sheets: sorting that moves WHOLE ROWS, with a header-row control and a refusal when a formula sits in the range
- [x] Sheets: number formats where the percent multiplies the DISPLAY and the column says when it will not add up to its own total
- [x] Sheets: per-column widths by drag, double-click-to-fit and keyboard, summed rather than multiplied, persisted and bounded
- [ ] Sheets: multi-sheet UI
- [x] CSV and TSV, read and written properly — a state machine, not a split; 21 tests including the hostile round trips
- [x] ZIP and XML, the floor every office format stands on — stored and deflated reading, DOCTYPE refused outright; 24 tests
- [x] `.xlsx` read and written, with a full round trip driven through the real import and export controls
- [x] `.docx` read and written, with a full round trip driven through the real open and save controls
- [x] Every export names what it drops BEFORE it runs, counted from the actual document
- [x] `.ods` and `.odt` read and written, with the OpenDocument formula syntax translated both ways
- [x] File type detected from CONTENT, never from the extension, and an unopenable file is NAMED
- [x] `.odp` and `.pptx` read and written — 5 real fixtures in the conformance corpus, including a sniffer check that tells an `.odp` from a `.pptx` renamed to look like one
- [ ] Cell formatting, column widths, images, tables and footnotes across every codec

## Phase 4 — Slides and PDF

- [x] Slide engine: normalised coordinates that scale exactly, layouts as data, hidden slides, honest timing — 11 tests
- [x] Slides: an editor and a real presenter view where the notes are a SEPARATE rendering, not hidden by CSS — 20 checks against the real window
- [ ] Drag, resize, shapes and images in the editor; transitions; second-screen output
- [x] PDF write: byte-exact cross-reference table, standard fonts, real metrics, CJK-aware wrapping — 18 tests
- [x] PDF read: objects found by SCANNING so a damaged table does not lose them; text extraction
- [x] PDF redact: removes the BYTES and then verifies they are gone — 16 checks against the real window
- [x] PDF: page rendering through a display list and a software scanline rasterizer, with the content-stream graphics state kept on a real stack
- [x] PDF: compressed streams decoded on BOTH paths — the text read and the page drawn — with an unsupported filter named rather than silently absent
- [ ] PDF: annotations, form fields, signatures
- [ ] PDF export from Writer, Sheets and Slides — the writer exists and is tested, but nothing calls it yet

## Phase 5 — The remaining five

- [x] Notes: Markdown, Unicode-aware tags, computed backlinks, links to notes that do not exist yet — 19 tests, 23 checks
- [ ] Notes: persistence into the autosave history, Markdown preview, attachments
- [x] Draw: stored transforms that never bake, model-side hit testing, SVG that IS the rendering — 59 engine tests, 32 checks
- [x] Draw: eight resize handles and a rotate handle, each with its own cursor and accessible name; a locked shape shows them and refuses the drag with a reason
- [x] Draw: union, subtract and intersect over exactly two marked shapes, with the empty result applied rather than refused
- [ ] Draw: paths drawn by hand, grouping, snapping and alignment guides, SVG import
- [x] Formula: TeX-like input, MathML output where the ELEMENT decides how it is read, the spoken description shown rather than hidden — 51 tests, 26 checks
- [x] Formula: matrices, cases and aligned equations as real `mtable`s, spoken row by row, with the bracket height MEASURED rather than assumed from the attribute
- [ ] Formula: matrices, cases, aligned equations, accents, MathML import
- [x] Database: null as its own value, constraints enforced on write, a query builder that is CONTROLS rather than a text box — 27 tests, 17 checks
- [ ] Database: editing rows, schema editing, joins, reports, persistence
- [ ] Notes
- [x] Forms: Design, Fill and Responses as MODES over one definition, help text always rendered, validation shared with the data engine — 19 tests, 19 checks
- [ ] Forms: persistence, sharing, branching, writing submissions into a Database table

## Phase 6 — Governance

- [x] Classification: a label only goes UP without authority, unknown outranks public, a derived document inherits the highest of its sources, an over-limit export is REFUSED rather than warned
- [x] Retention: nothing deleted automatically, a legal hold outranks every policy, the clock starts at an EVENT, month arithmetic clamps rather than rolls
- [x] Data-loss prevention: Luhn and Hong Kong check digits so it does not cry wolf, previews that never disclose the match, a caveat beside every finding
- [x] Tamper-evident audit log with hash-chain verification
- [x] 30 tests, 18 checks against the real window
- [ ] Policy distribution from a server, per-user authority, signature generation and verification
- [ ] Applying a label to a real document, and writing governance events into the audit log

## Phase 7 — Collaboration

- [x] CRDT co-authoring — convergence proved over every ordering, not three scenarios
- [x] Presence, expiring rather than needing a goodbye
- [x] Offline queue and reconnection with capped jittered backoff
- [x] Identity: session tokens, SAML attribute mapping, SCIM deprovisioning
- [x] Container stack, deployed and verified — 18 checks against the running container
- [x] The Collaboration surface in the shell — 13 checks against the built window
- [ ] Tombstone collection (needs causal stability across every replica)
- [ ] A real SAML terminator; the mapping assumes an already-verified assertion
- [ ] Horizontal scaling; the room registry is in-process

## Phase 8 — Evidence

- [ ] Capture matrix at 100/125/150/200%, all language modes, both themes
- [ ] Committed screen recording of the real application
- [ ] Line counts published in every release
