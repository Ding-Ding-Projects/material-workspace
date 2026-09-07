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
- [ ] Unsigned Squirrel.Windows installer produced and verified
- [ ] Release workflow publishing per push
- [ ] Documentation site published
- [ ] Social preview graphic at the repository root

## Phase 1 — Shell

- [ ] Command palette on `Ctrl+Shift+F`, teleporting to the exact element
- [ ] Settings surfaces, tabbed, each with its own search and anchored regex builder
- [ ] The regex builder itself
- [ ] Per-element appearance editors
- [ ] Infinite colour picker with the colour translator and the animated rainbow
- [ ] Notification centre with bulk actions
- [ ] Tab docking, reordering, pinning, grouping, and the four tab searches
- [ ] Narrator with per-language voice pickers
- [ ] School mode, shared and propagating live
- [ ] ADHD modes
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

- [ ] Text engine: layout, pagination, styles, footnotes, change tracking
- [ ] Sheet engine: dependency graph, incremental recalculation, function library
- [ ] `.docx` / `.odt` / `.xlsx` / `.ods` / CSV round-trip with a conformance corpus

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
