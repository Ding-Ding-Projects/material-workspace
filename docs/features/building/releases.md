# Releases and installers

**Status: built and verified.** Every push publishes a release.

## What a release contains

| Asset | What it is |
| --- | --- |
| `MaterialWorkspaceSetup-<version>.exe` | The Squirrel.Windows installer |
| `RELEASES` | The Squirrel update index |
| `material-workspace-<version>-full.nupkg` | The package the installer applies |
| A dim sum photograph | This build's code name, from the public catalog |

## The installer is unsigned, permanently

Code signing is out of scope for this project by deliberate policy. Windows will
show an unknown-publisher warning when you run the installer.

Verify a download against the **SHA-256 published in the release notes** rather
than against a signature. Treat any "signed Material Workspace installer" as not
ours.

The packaging script clears every signing input before building, and refuses to
report success if a produced artifact reports as signed. Being unsigned is the
required state here, not a disappointment.

### A trap worth recording

`signAndEditExecutable: false` reads like the safest possible packaging setting.
It also disables resource editing, so the package ships with the framework's
default icon — mentioned in one line of a long log, with the build still exiting
zero. The only symptom is an application wearing somebody else's logo in the
taskbar.

The packaging script now looks for our own icon's bytes inside the built
executable, and that check was proven to discriminate by running it against the
unmodified framework binary, which correctly comes back negative.

## Code names

Each build is named after a dish from the public dim sum catalog, used once per
project so two builds are never indistinguishable in conversation. The dish's
photograph is attached to the release.

The code name is a label **beside** the version, never a replacement for it.

## Timing and line counts

Every release records when the workflow started, when it completed, and how long
it took — measured from the workflow's own first-job start, read back from the
API rather than from a step's clock.

It also publishes a line-count table produced by a committed script, broken down
by category, with excluded files shown as visible rows rather than silently
dropped, and authorship attributed per surviving line.

## What CI does not do

It runs no tests, no lint, no type checks and no static analysis, and nothing
withholds a release on a code-quality verdict. The release notes say so in as
many words rather than letting a green tick imply a verdict nobody reached.

A run fails only when the build, the packaging, or the publication itself fails.

## Suggested articles

- [Build from source](build-from-source.md)
