# Material Workspace

An office suite for Windows that brought its own engines. Nine applications, its
own document model, its own layout and calculation engines, its own file readers
and writers — and nothing else to install alongside it.

> [!IMPORTANT]
> **Status: early. Read this before you download anything.**
>
> The application shell, the settings model, the document store and the autosave
> history are real and working. **None of the nine applications is built yet.**
> The front screen says so for each one, in words, rather than opening an empty
> window and hoping you do not notice.
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

The front screen, captured from the real built application on a hidden desktop.
Every claim on it is resolved at run time — the version and build time come from
provenance frozen into the artifact, and the per-application state is read from
what is actually implemented rather than from a wish list.

![The Material Workspace front screen: a dark Material Design 3 window with a
left-docked tab strip, a build card showing version 0.1.0 with its exact build
timestamp and timezone, an unsigned-artifact note, and a grid of the nine
applications each labelled "Not built yet".](docs/images/front-screen.png)

<details>
<summary><strong>The nine applications</strong></summary>

| Application | What it will be | State |
| --- | --- | --- |
| Writer | Layout, pagination, styles, footnotes, change tracking | Not built yet |
| Sheets | Dependency-graph recalculation and a real function library | Not built yet |
| Slides | Layouts, transitions, speaker notes, presenter view | Not built yet |
| Draw | Paths, boolean operations, gradients, connectors | Not built yet |
| Formula | Mathematical typesetting, MathML in and out | Not built yet |
| Database | A relational store with a query engine and bound forms | Not built yet |
| PDF | Read, annotate, redact by removing bytes, sign, verify | Not built yet |
| Notes | Structured notes linked to the documents they describe | Not built yet |
| Forms | Design a form, fill it, validate what comes back | Not built yet |

Each application carries the full feature contract independently. None of them
delegates a capability to a sibling.

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

## Verifying it yourself

```powershell
npm run typecheck     # types
npm test              # the suite, including real-git history tests
npm run build         # bundles, with a freshness assertion
```

The history tests run against the **real `git` binary and a real temporary
repository**, and assert through an independent `git` invocation rather than
believing the module's own report of its own success. That module has a small
pure half and a large subprocess half, and testing only the pure half is exactly
how a feature ships completely dead behind a green suite.

## Licence

MIT. See [LICENSE](LICENSE).
