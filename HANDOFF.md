# Handoff

Written 2026-09-07. Every claim below was checked against the tree as it stands,
not carried forward from an earlier note.

## Where this is

**Phase 0 is complete and verified. No application is built.** The shell runs,
shows honest provenance, and says plainly that each of the nine applications is
not built yet. That is the truthful state and the front screen reflects it.

## What genuinely works, and how it was verified

| Area | State | Evidence |
| --- | --- | --- |
| Fresh-machine bootstrap | Works | Installed dependencies from an empty `node_modules`; recovered an Electron install whose `dist` was empty |
| Build | Works | `node scripts/build.mjs` green; freshness assertion caught a real stale output before it was fixed |
| Application launches | Works | Launched the built artifact on an off-screen desktop and read the captured PNG back; capture committed at `docs/images/front-screen.png` |
| Provenance on front screen | Works | Version, build time to the second with timezone, commit, branch, unsigned note — all rendered and read from the capture |
| Document history (autosave) | Works | 9 tests against the real `git` binary; independently confirmed the repository, its commit, and its tracked file with a separate `git` invocation |
| Append-only restore | Works | Break test: made restore rewind, watched 3 tests go red including the exact assertion, restored, watched all 9 go green |
| Typecheck | Green | `npx tsc --noEmit -p tsconfig.json`, exit 0 |

## What is written but NOT verified

These are implemented and typecheck, and have no test or built-artifact proof
yet. Do not describe them as working.

- Atomic file writes and the Windows rename retry — no concurrency or
  sharing-violation test exists yet.
- The tamper-evident audit log — the hash chain and its verification have no
  test.
- The personal-vocabulary loader, including the duplicate-key scanner — no test.
  The scanner is hand-written and its array handling is exactly the kind of thing
  that needs one.
- Settings live-propagation via the file watcher — never exercised with two
  windows.
- Document create / save / rename / delete handlers — the service is tested only
  through the history layer.

## Known defects and gaps

- **No installer.** `build-installer.bat` and `npm run package` reference a
  packaging script that does not exist yet. Running it will fail.
- **No release workflow, no documentation site, no social preview image.**
- **`historyPrune` deliberately throws.** Pruning destroys history, so it ships
  with the two-key confirmation gate rather than before it. The message says so.
- **The dim sum surprise, command palette, regex builder, appearance editors,
  narrator, School mode, ADHD modes, toy locks and the unlock ladder are all
  unimplemented.** They are in the settings model but have no surface.
- The settings model carries fields no surface reads yet. That is deliberate at
  this stage but every one of them needs a reader before it can be called done.

## Things a next owner should know before touching anything

- **`SettingsService` resolves its paths in `initialise()`, never in the
  constructor.** It is constructed at module load, before the data root is
  injected. On Windows the fallback and the injected value happen to be
  identical, so moving that back into the constructor would appear to work here
  and write to the wrong place elsewhere.
- **The storage layer must not import Electron.** It was decoupled precisely so
  the history engine's tests can run under plain Node against a real `git`
  binary. Re-adding that import breaks the only tests that prove autosave works.
- **`AVAILABLE` in `app/renderer/index.ts` is the single source of truth for
  which applications are usable.** Adding an entry there is a claim that the
  application opens and does its job. Do not set it ahead of the implementation
  to make the grid look complete.

## Next step

Phase 0's remaining items, in this order: the packaging script and a verified
unsigned installer, then the release workflow, then the documentation site. After
that, Phase 1's shell surfaces — the command palette and the regex builder first,
because every later surface depends on them.
