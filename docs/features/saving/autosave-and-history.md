# Autosave and document history

**Status: built and verified.** Nine tests run against the real `git` binary and
confirm the result through a separate `git` invocation.

## What it does

Saving is continuous. There is no save button, and there is no moment where your
work exists only in a window that might close.

Every change is recorded into a Git repository that Material Workspace creates
and owns. It is an ordinary repository — you can open it with any Git tool you
like — and it records what changed, when, and which document it belonged to.

## Where it lives

```
%APPDATA%\material-workspace\history
```

Beside the application's own data, and **never inside a folder you own**. A tool
that plants a `.git` directory in your Documents folder is a surprise at best,
and at worst it collides with version control you are already using.

The path is derived from a fixed identity constant, not from the product name.
Renaming the application changes what it calls itself and moves nothing.

## History is append-only

Restoring an earlier version writes a **new commit**. It never rewinds, resets or
rewrites.

That is the property that makes the history panel safe to experiment in: an undo
can itself be undone, and that undo undone in turn. A "restore" that discards the
branch it replaced is the single failure mode that makes a history feature
unsafe, because it means you cannot try something without risking the state you
started from.

Deleting a document records the deletion **before** the file is removed, so the
content remains recoverable from history afterwards. A deletion recorded after
the fact can lose the very thing it was meant to record.

## How the timing works

Two timers, because one is not enough:

| Setting | Default | What it does |
| --- | --- | --- |
| Debounce | 1200 ms | How long typing must pause before a change is recorded |
| Settle ceiling | 2500 ms | The longest a change can wait before it is recorded anyway |

The debounce keeps sliding while keys arrive, so a burst of typing becomes one
entry rather than four hundred. The settle ceiling stops an unbroken hour of
typing from going unrecorded entirely.

Both are adjustable in **Settings → Saving**.

## What is recorded

Each commit carries a trailer naming the action and the document:

```
Autosave My document

Workspace-Action: autosaved
Workspace-Document: 5f2c8e10-...
```

The action filter in the history panel is derived from the actions **actually
present** in your history, never from a hard-coded list. A hard-coded list drifts
and ends up offering filters that can only ever return nothing.

## Failure modes, and what each one looks like

| What happened | What you see |
| --- | --- |
| Git is not installed or not reachable | The status bar names it, and lists every location that was tried |
| The repository cannot be created | History reports unavailable **with the reason**, never as an empty archive |
| A history write fails | Your document is still saved. Only the history entry is missed, and the panel says the repository is unhealthy |

A history failure never fails the edit you were making. That ordering is
deliberate: losing your work to protect a log would be the wrong way round.

### Git not being found is not the same as Git not being installed

The application resolves the `git` executable explicitly rather than trusting
`PATH`. A window started from a Start Menu shortcut, a scheduled task or an
installer's post-install launch can inherit an environment without your shell's
`PATH` — so Git is plainly installed, works in every terminal you open, and the
application still cannot find it.

When resolution fails, the message lists **every path that was tried**, and you
can point at a specific one:

```
set MATERIAL_WORKSPACE_GIT=C:\Program Files\Git\cmd\git.exe
```

## Privacy

- The repository is **local**. Nothing is pushed or synchronised anywhere unless
  you explicitly ask.
- Commits are authored by the application, not by your Git identity, so your name
  and email are not written into it.
- The repository is never included in an ordinary export.

## Verifying it yourself

```powershell
npm test
```

The suite drives the real `git` binary against a real temporary repository and
asserts through an **independent** `git` invocation, never by believing the
module's own report of its own success. It covers repository creation, recording
a change, recording nothing when nothing changed, restore-adds-a-commit, action
parsing, the derived filter, path-escape refusal, and health reporting.

You can also look directly:

```powershell
git -C "$env:APPDATA\material-workspace\history" log --oneline
```

## Suggested articles

- [Document history panel](history-panel.md) — browsing, filtering and restoring
- [Building from source](../building/build-from-source.md) — how the checks are run
- [Language modes](../language/language-modes.md) — how these messages are worded
