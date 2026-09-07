# Handoff

Written 2026-09-07. Every claim below was checked against the tree as it stands,
not carried forward from an earlier note.

## Where this is

**Phase 0 complete. Phase 1 substantially done. No application is built.**

The shell, the settings model, the document store, the autosave history, the
regex workbench, the command palette, the settings surface, notifications, the
attention modes and the documentation site are real and verified. **None of the
nine applications exists**, and the front screen says so on each one rather than
opening an empty window.

Scale, from the committed counter: **18,175 lines** across 96 project files.

## Verified, and how

| Area | Evidence |
| --- | --- |
| Fresh-machine build | Recovered an Electron install with an empty `dist`; 158,199,548 bytes fetched from upstream, SHA-256 matching the shipped checksum |
| Autosave into a local Git repository | 9 tests against the real `git` binary, asserted through a **separate** `git` invocation |
| Append-only restore | Break test: made restore rewind, watched 3 tests go red, restored, watched 9 go green |
| Regex evaluation bound | Adversarial pattern killed at 752 ms; the in-thread version of the same case ran 94,000 ms |
| Built window | **55 checks** driven over CDP with isolation proved first (exactly one page target) |
| Documentation site | **13 checks** in an isolated browser, including a phone viewport driven through the protocol |
| Unsigned installer | Authenticode `NotSigned`; our own icon's bytes found inside the executable, and the check proven to discriminate against the unmodified framework binary |
| Published site | Read back live: embed tags in the **served** markup, preview image anonymously fetchable, 13 articles |

Unit tests: **37**, all green. Typecheck: green.

## What is written but NOT verified

Implemented and typechecking, with no test or built-artifact proof. Do not
describe these as working.

- Atomic file writes and the Windows rename retry — no concurrency or
  sharing-violation test exists.
- The tamper-evident audit log — the hash chain and its verification are untested.
- The personal-vocabulary loader, including its duplicate-key scanner. The
  scanner is hand-written and its array handling is exactly the kind of thing
  that needs a test.
- Document create / save / rename / delete handlers — the service is exercised
  only through the history layer.
- Settings live-propagation via the file watcher — never tried with two windows.
- The floating panel's drag, resize and keyboard geometry — written, never driven.

## Known gaps

- **None of the nine applications.** No text engine, no sheet engine, no codecs.
- **No collaboration server.** `server/` is an empty directory.
- **No governance surfaces.** Policy, classification, retention and DLP do not
  exist; only the audit log's implementation does.
- **`historyPrune` deliberately throws.** Pruning destroys history, so it ships
  with the two-key confirmation gate rather than before it, and says so.
- Missing from Phase 1: appearance editors, the infinite colour picker, the
  narrator and its voice pickers, School mode, toy locks, the unlock ladder, the
  destructive-action super confirmation, automatic updates, and the per-surface
  completeness inventory with its negative regressions.

## Traps a next owner should know

These cost real time here. `AGENTS.md` carries the full list.

- **`SettingsService` resolves its paths in `initialise()`, never the
  constructor.** It is constructed at module load, before the data root is
  injected. On Windows the fallback and the injected value happen to be
  identical, so moving that back would appear to work here and write to the
  wrong place elsewhere.
- **The storage layer must not import Electron.** It was decoupled so the history
  engine's tests can run under plain Node against a real `git` binary.
  Re-adding that import breaks the only tests that prove autosave works.
- **`AVAILABLE` in `app/renderer/index.ts` is the single source of truth** for
  which applications are usable. An entry there is a claim that the application
  opens and does its job.
- **A fake DOM whose `remove()` is a no-op hangs the entire test file** with no
  output, because the renderer clears a node with
  `while (node.firstChild) node.firstChild.remove()`. `test/ui/fake-dom.ts`
  detaches properly and explains why.
- **A CSS override can lose on specificity and do nothing at all.** The nested
  tab strip needed a structural fix, not more specificity, and it is checked by
  measuring the running window because a stylesheet cannot say which rule won.

## Next step

In this order:

1. The destructive-action super confirmation, because history pruning and bulk
   delete are both blocked on it.
2. The appearance editors and the infinite colour picker.
3. The per-surface completeness inventory and its negative regressions, so the
   remaining Phase 1 items cannot be quietly skipped.
4. Then Phase 3: the text and sheet engines, which is where the suite starts
   being an office suite rather than a shell.
