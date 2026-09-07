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
- [ ] Infinite colour picker with the colour translator and the animated rainbow
- [x] Notification centre with bulk actions — severity-aware auto-dismiss, keyed replacement, bounded retention, honestly-scoped select-all, outcome reported rather than selection
- [ ] Tab docking, reordering, pinning, grouping, and the four tab searches
- [ ] Narrator with per-language voice pickers
- [ ] School mode, shared and propagating live
- [x] Attention modes — five, independent, all off by default, each with a real reader proven by measuring the running interface
- [ ] Toy locks, Support Tickets, and the unlock ladder
- [ ] Destructive-action super confirmation
- [ ] Automatic updates with the ready-to-restart banner
- [ ] The per-surface completeness inventory and its negative regressions

## Phase 2 — Document core

- [ ] History panel: browse, search, date picker, action filter, diff, restore, label
- [ ] Export in every format that can faithfully carry the data
- [ ] Bulk actions on every collection
- [ ] Changelog viewer with commit links

## Phase 3 — Writer and Sheets

- [x] Text engine: blocks and runs, CJK-aware line breaking, pagination with keep-with-next — 22 tests against an injected deterministic measurer
- [x] Writer: a real editor over that engine, not contenteditable, with IME input through a hidden field — 13 checks driven against the real window
- [x] Sheet engine: formula parser, evaluator, incremental dependency-ordered recalculation, cycle detection, 90+ functions — 44 tests asserting exact values
- [x] Sheets: a virtualised grid over that engine — 20 checks driven against the real window, two of which measure rendered geometry rather than reading the stylesheet
- [ ] Writer: footnotes, table of contents, tables, images, change-tracking review
- [ ] Sheets: per-column widths, sorting, filtering, charts, number formats, multi-sheet UI
- [x] CSV and TSV, read and written properly — a state machine, not a split; 21 tests including the hostile round trips
- [x] ZIP and XML, the floor every office format stands on — stored and deflated reading, DOCTYPE refused outright; 24 tests
- [x] `.xlsx` read and written, with a full round trip driven through the real import and export controls
- [x] `.docx` read and written, with a full round trip driven through the real open and save controls
- [x] Every export names what it drops BEFORE it runs, counted from the actual document
- [x] `.ods` and `.odt` read and written, with the OpenDocument formula syntax translated both ways
- [x] File type detected from CONTENT, never from the extension, and an unopenable file is NAMED
- [ ] `.odp` and `.pptx`
- [ ] Cell formatting, column widths, images, tables and footnotes across every codec

## Phase 4 — Slides and PDF

- [ ] Slide engine and presenter view
- [ ] PDF: parse, render, annotate, redact by removing bytes, sign, verify

## Phase 5 — The remaining five

- [ ] Draw
- [ ] Formula
- [ ] Database
- [ ] Notes
- [ ] Forms

## Phase 6 — Governance

- [ ] Policy engine
- [ ] Classification labels
- [ ] Retention rules
- [ ] Data-loss-prevention checks
- [ ] Signature verification

## Phase 7 — Collaboration

- [ ] CRDT co-authoring
- [ ] Presence
- [ ] Offline queue and reconnection
- [ ] Identity: SSO, SAML, SCIM
- [ ] Container stack, deployed and verified

## Phase 8 — Evidence

- [ ] Capture matrix at 100/125/150/200%, all language modes, both themes
- [ ] Committed screen recording of the real application
- [ ] Line counts published in every release
