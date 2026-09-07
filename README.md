# Material Workspace

An office suite for Windows that brought its own engines. Nine applications, its
own document model, its own layout and calculation engines, its own file readers
and writers — and nothing else to install alongside it.

> [!IMPORTANT]
> **Status: all nine applications are built and driven. Read this anyway.**
>
> Every application opens, does its own work, and is exercised against the
> **real built artifact** by its own driver on every change - not against a
> mock, and not by reading the source. The counts are in
> [Verifying it yourself](#verifying-it-yourself).
>
> What that does **not** mean: this is not a finished office suite. The engines
> are real and young. Round-tripping a complicated `.docx` from elsewhere will
> lose things, and the surfaces say which rather than pretending otherwise.
>
> There is no release to install yet. When there is, it will be unsigned, and
> Windows will show an unknown-publisher warning.

## Build and run it, from a completely fresh Windows install

```powershell
.\build.bat --run
```

That one command assumes **nothing** is installed — no Node, no package manager,
no build tools, no Git. It obtains every dependency itself from each ecosystem's
canonical upstream into a user-scoped location, builds the real artifact, and
launches it. No preparatory step, no manual download, no administrator detour.

| Command | What it does |
| --- | --- |
| `.\build.bat` | Build, then ask whether to launch |
| `.\build.bat --run` | Build, then launch without asking |
| `.\build.bat /s` | Silent: no prompts, no pause, non-zero exit on first failure |
| `.\build-installer.bat` | Produce the unsigned Squirrel.Windows installer |
| `.\download-dependencies.bat` | Fetch dependencies without building |

`/s` is the mode CI and automation use: it never blocks on a keypress and never
opens a window.

## What it looks like right now

Recorded from the real built application on an off-screen desktop. Nothing on
the visible desktop is captured, ever - the recorder asks the renderer for its
own pixels over the debugging protocol.

![A recording of Material Workspace running: the front screen with its build
card, the writer with text being typed into it, the spreadsheet, the drawing
canvas, the database, the appearance editor and the settings surface, at 900 by
600 in the dark theme.](docs/images/walkthrough.gif)

The GIF was written by [an encoder in this
repository](scripts/gif-encoder.mjs), because this machine has no video encoder
and the project has no dependencies. GIF carries 256 colours a frame, so a
gradient will band - that is the format, not the capture.

<details>
<summary><strong>Every surface, captured from the real build</strong></summary>

Each of these comes from a driver run against the packaged renderer, at the
commit it says. None is a mockup, a design file, or a hand-edited image.

### The shell

| | |
| --- | --- |
| ![The front screen](docs/images/surfaces/01-front-screen.png)<br>**Front screen** | ![Search, filtered](docs/images/surfaces/02-search-filtered.png)<br>**Search, filtered** |
| ![No match](docs/images/surfaces/03-search-no-match.png)<br>**An honest no-match** | ![The regex builder](docs/images/surfaces/04-regex-builder-open.png)<br>**The regex builder** |
| ![A dangerous pattern flagged](docs/images/surfaces/05-regex-danger-flagged.png)<br>**A catastrophic pattern, flagged** | ![Matches](docs/images/surfaces/06-regex-matches.png)<br>**Live matches** |
| ![The command palette](docs/images/surfaces/07-palette-open.png)<br>**The palette** | ![Palette search](docs/images/surfaces/08-palette-search.png)<br>**Palette search** |
| ![Settings](docs/images/surfaces/09-settings.png)<br>**Settings** | ![A setting on another tab](docs/images/surfaces/10-settings-cross-tab.png)<br>**A result on another tab** |
| ![Notifications](docs/images/surfaces/11-notifications.png)<br>**Notifications** | ![Dismissed](docs/images/surfaces/12-notifications-dismissed.png)<br>**Dismissed, and reviewable** |
| ![Attention modes](docs/images/surfaces/13-attention-modes.png)<br>**Attention modes** | ![The narrator](docs/images/surfaces/33-narrator.png)<br>**The narrator** |
| ![Tab search](docs/images/surfaces/34-tab-search.png)<br>**Tab search** | ![Locks](docs/images/surfaces/35-locks.png)<br>**Toy locks** |
| ![History](docs/images/surfaces/38-history.png)<br>**Local history** | ![Changelog](docs/images/surfaces/39-changelog.png)<br>**The changelog** |

### The nine applications

| | |
| --- | --- |
| ![Writer](docs/images/surfaces/14-writer.png)<br>**Writer** | ![Sheets](docs/images/surfaces/16-sheets-xlsx.png)<br>**Sheets, after an .xlsx round trip** |
| ![Slides](docs/images/surfaces/17-slides-editor.png)<br>**Slides** | ![Presenter view](docs/images/surfaces/18-slides-presenter.png)<br>**Presenter view** |
| ![Notes](docs/images/surfaces/19-notes.png)<br>**Notes** | ![Draw](docs/images/surfaces/20-draw.png)<br>**Draw** |
| ![Formula](docs/images/surfaces/21-formula.png)<br>**Formula** | ![Database](docs/images/surfaces/22-database.png)<br>**Database** |
| ![Forms](docs/images/surfaces/23-forms.png)<br>**Forms** | ![PDF](docs/images/surfaces/24-pdf.png)<br>**PDF** |

### Governance, collaboration and appearance

| | |
| --- | --- |
| ![Governance](docs/images/surfaces/25-governance.png)<br>**Governance** | ![Offline](docs/images/surfaces/26-collaboration-offline.png)<br>**Collaboration, offline** |
| ![Connecting](docs/images/surfaces/27-collaboration-connecting.png)<br>**Connecting** | ![Queued](docs/images/surfaces/28-collaboration-queued.png)<br>**Edits queued** |
| ![Disconnected](docs/images/surfaces/29-collaboration-disconnected.png)<br>**Disconnected, and honest about it** | ![The colour picker](docs/images/surfaces/30-appearance-picker.png)<br>**The infinite colour picker** |
| ![A refused colour](docs/images/surfaces/31-appearance-refused.png)<br>**A refused value, in words** | ![The rainbow](docs/images/surfaces/32-appearance-rainbow.png)<br>**The animated rainbow** |
| ![An element menu](docs/images/surfaces/40-element-menu.png)<br>**Any element's own menu** | ![The appearance editor](docs/images/surfaces/41-element-appearance.png)<br>**Editing one element** |
| ![Reset](docs/images/surfaces/42-element-appearance-reset.png)<br>**Reset, back to what shipped** | ![Presets](docs/images/surfaces/43-element-presets.png)<br>**Saved styles** |
| ![Layers](docs/images/surfaces/44-element-layers.png)<br>**A layer stack on one element** | |

</details>

<details>
<summary><strong>The nine applications</strong></summary>

Each carries the full feature contract independently. None delegates a
capability to a sibling.

| Application | What it does | Driven checks |
| --- | --- | --- |
| Writer | Layout, pagination, styles, footnotes, a table of contents, `.docx` and `.odt` | 24 |
| Sheets | A dependency graph, incremental recalculation, a real function library, filtering, charts, `.xlsx` and `.ods` | 50 |
| Slides | Layouts, speaker notes, presenter view, `.pptx` and `.odp` | 25 |
| Draw | Paths, shapes, layers, selection in bulk, real SVG export | 24 |
| Formula | Mathematical typesetting, MathML in and out | 15 |
| Database | A relational store, a query builder that is controls rather than text, bound forms | 25 |
| PDF | Page rendering, reading, annotating, redaction that removes the bytes | 19 |
| Notes | Structured notes that link to the documents they describe | 23 |
| Forms | Design a form, fill it, validate what comes back | 24 |

</details>

<details>
<summary><strong>Autosave, and where your history lives</strong></summary>

Saving is continuous rather than a button. Every change is recorded into a Git
repository that this application creates and owns.

- It is **isolated**, beside the application's own data directory. Never a
  `.git` inside a folder you own — your documents folder is yours, and a tool
  that plants a repository in it conflicts with your own version control.
- History is **append-only**. Restoring an earlier version writes a *new*
  commit; it never rewinds, resets or rewrites. So an undo can itself be undone,
  and that undo undone in turn. This is what makes the history panel safe to
  experiment in.
- Discarding unsaved work is itself recorded, before the close completes, so a
  discard is auditable and recoverable.
- It is **local**. Nothing is pushed or synchronised anywhere unless you ask.

The repository lives at `%APPDATA%\material-workspace\history`. It is an
ordinary Git repository; you can open it with any Git tool you like.

</details>

<details>
<summary><strong>Collaboration</strong></summary>

Real-time co-authoring runs against a self-hosted server, shipped as a container
stack under `server/`. It is **optional and off by default**.

It is deployed and verified on a private host: two real clients over the
network, joining, seeing each other, exchanging operations in a shared order,
resuming after a drop, and a forged token refused at the handshake - **10 of 10
checks**. The deployment reports the resource limits the host **actually
applied** rather than the ones the compose file declares, because on that host
the kernel has no memory cgroup controller and silently discards the memory cap.
See [Running the collaboration server](docs/features/collaboration/deployment.md).

Offline is the normal case, not the error case: the suite is fully usable with
the server unreachable, edits queue locally, and they reconcile on reconnect. A
server that is down degrades collaboration and nothing else.

</details>

<details>
<summary><strong>Privacy, money, and what this will never do</strong></summary>

- **No network calls** are made by the desktop application except to a
  collaboration server you configure yourself. No CDN, no remote font, no
  analytics, no telemetry, no crash reporting to anyone.
- **Nothing is ever for sale.** Accessibility, the language modes, the funny
  levels, School mode, and export of your own data can never sit behind a
  payment. There is no trial that expires into a locked application.
- **No nagging.** No donation prompts, no rating requests, no upgrade banners.
- **No code signing, ever.** Installers are unsigned by deliberate policy, and
  every surface that mentions them says so rather than letting you find out from
  a publisher warning.

</details>

<details>
<summary><strong>Repository layout</strong></summary>

```
app/main/        Electron main process: windows, IPC, storage, git, governance
app/preload/     The single narrow bridge; no generic channel forwarding
app/renderer/    Material Design 3 shell and the nine applications
app/engines/     Document engines: text, sheet, slide, vector, formula, data, pdf, codec
app/governance/  Policy, tamper-evident audit log, classification, retention
app/sync/        Collaboration client: CRDT, presence, offline queue
server/          The self-hosted collaboration stack
docs/            One article per feature, under categorized subfolders
site/            The documentation site
scripts/         Build, package, verify, capture, release
test/            Unit, engine conformance, guards, negative regressions
```

</details>

## How big it is, and how long a person would have taken

Counted by [a committed script](scripts/line-count.mjs), not by hand, so the
figure can be reproduced rather than trusted.

| | Files | Lines | Non-blank |
| --- | ---: | ---: | ---: |
| Application source | 105 | 38,026 | 34,428 |
| Styles and markup | 25 | 8,174 | 7,146 |
| Tests | 44 | 11,118 | 9,666 |
| Build and release scripts | 31 | 10,925 | 9,845 |
| Server | 11 | 2,013 | 1,762 |
| Documentation | 52 | 5,699 | 4,577 |
| Legal | 1 | 21 | 17 |
| Configuration | 10 | 670 | 603 |
| **Project total** | **279** | **76,646** | **68,044** |

Excluded and shown rather than hidden: one dependency lockfile (generated) and
ten binary assets. The grand total of everything tracked is the same 76,646
lines, because the excluded files are either generated or not text.

**Authorship, per surviving line** (`git blame`, not summed additions - churn is
not authorship): **76,598 agent-written, 48 person-written.** That is 99.9% and
0.1%. Stated plainly and without spin in either direction.

**A person writing this by hand: roughly 1.8 to 3.4 years.** That is an
**estimate**, not a measurement - nobody built it by hand, and you should
disagree with the assumption rather than the arithmetic if you disagree at all.

The arithmetic: 68,044 non-blank hand-written lines at a sustained 80 to 150
lines a day - a common range for production code carrying its own tests and
documentation - is 454 to 851 working days, or 1.8 to 3.4 years at 250 working
days a year.

## Verifying it yourself

```powershell
npm run typecheck      # types
npm test               # the suite, including real-git history tests
npm run build          # bundles, with a freshness assertion
npm run verify:layout  # clipping and target size, across 960 combinations
```

Everything below is measured against the **built artifact**, on an off-screen
desktop, through the application's own debugging protocol. Nothing here is
satisfied by reading source.

| Check | Result |
| --- | --- |
| Unit and engine suite | **1,006 tests**, 48 files |
| Driven against the real build | 13 drivers, **367 checks** |
| Layout: clipping, overflow, target size | **0 findings across 960 combinations** |
| Format conformance | **27 real files** read off disk, 44 checks |
| Feature inventory | **71 of 72** contracts built, the one gap named |
| Collaboration, against the deployed container | **10 of 10** over the network |

The history tests run against the **real `git` binary and a real temporary
repository**, and assert through an independent `git` invocation rather than
believing the module's own report of its own success. That module has a small
pure half and a large subprocess half, and testing only the pure half is exactly
how a feature ships completely dead behind a green suite.

## Licence

MIT. See [LICENSE](LICENSE).
