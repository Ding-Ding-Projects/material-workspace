# Build from source

**Status: built and verified**, including the fresh-machine path.

## One command

```powershell
.\build.bat --run
```

That assumes **nothing** is installed. No Node, no package manager, no build
tools, no Git. It obtains every dependency itself from each ecosystem's canonical
upstream into a user-scoped location, builds the real artifact, and launches it.

No preparatory step, no manual download, no administrator detour.

| Command | What it does |
| --- | --- |
| `.\build.bat` | Build, then ask whether to launch |
| `.\build.bat --run` | Build, then launch |
| `.\build.bat /s` | Silent; non-zero exit on the first real failure |
| `.\build-installer.bat` | Produce the unsigned installer |
| `.\download-dependencies.bat` | Fetch dependencies without building |

`/s` is the mode automation uses: it never blocks on a keypress and never opens a
window.

## What the bootstrap actually does

It refreshes `PATH` **inside its own process** after an install. A package manager
writes `PATH` for future shells, so the very next command in the same script
still cannot find what was just installed — a failure that reads as "the install
failed" when in fact it succeeded.

It judges success by whether the artifact **exists afterwards**, never by whether
an installer reported success.

### The Electron case, which is why that rule exists

npm's install-script gate, plus a Node runtime that exits before asynchronous
work settles, can leave the `electron` package installed with a completely empty
`dist` directory. Electron's own installer is not a recovery route in that state:
it prints a cache hit, exits 0 in under a second, extracts nothing, and prints no
error at all.

So the bootstrap checks the binary, and when it is missing it recovers: cache
first, then a download from the canonical upstream, with the SHA-256 verified
against the checksums the `electron` package itself ships — either way, because a
cached archive can be truncated and a downloaded one has crossed a network.

Measured: 158,199,548 bytes fetched in 26 seconds, digest matching exactly.

## The freshness assertion

After bundling, the build asserts that its output is newer than its sources.

This is not tidiness. A builder that writes into an existing output directory
leaves the **previous** output in place when it fails, so every check downstream
validates an artifact that no longer corresponds to the tree and reports green
for a build that already died.

It earned its keep on its first run, catching a genuinely stale output — because
on Windows `copyFileSync` goes through `CopyFileW`, which **preserves the source
file's timestamp**, so a copied file can legitimately look older than its
siblings.

## The checks

```powershell
npm run typecheck
npm test
npm run build
```

CI runs none of these and gates nothing on them. That is a deliberate standing
decision: checking happens locally, in the change that needs it, and its result
is reported honestly. A failing test is still a defect to fix; it is simply not a
release gate.

What that costs, stated plainly: a release can ship from a commit whose tests
would have failed. The trade is that artifacts reach people quickly and
unconditionally.

## Suggested articles

- [Releases and installers](releases.md)
- [Autosave and document history](../saving/autosave-and-history.md)
