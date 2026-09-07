# Contributing

## Before anything else

```powershell
.\build.bat --run
```

If that does not work from a clean checkout, that is the first defect to report.
It is the command every new machine runs, so a broken one is worse than none.

## The checks

```powershell
npm run typecheck
npm test
npm run build
```

CI does not run tests or lint, and does not gate releases on them. That is
deliberate. Checking happens locally, in the change that needs it, and its result
is reported honestly. A failing test is still a defect to fix; it is simply not a
release gate.

## Things this project is strict about

**A guard nobody has watched fail proves nothing.** After writing a test that
protects an invariant, break the invariant on purpose, watch the test go red,
restore it, watch it go green. Say in the pull request that you did. This is not
ceremony: two guards in this repository were written, looked correct, and would
have passed on code with the property removed.

**Anchor assertions to a line, not to a substring.** Asserting a bare string
means a commented-out call still satisfies the check, because the substring is
right there behind the slashes. A rename that breaks the code is exactly the edit
a substring assertion cannot see.

**Assert against the built artifact, not the configuration.** A green packaging
log proves a file was copied, never that anything can find it. A unit test that
injects a dependency proves the screen and nothing about the wiring. Three real
defects in this repository were found by launching the built application and
looking at it, after the source read as correct.

**Never ship a decorative control.** An element that looks operable must do its
labelled action, expose an accessible equivalent, and persist its state. A
feature that is not built yet says so in words rather than opening an empty
window.

**Follow a token to a reader.** A custom property that nothing consumes is a
control that silently does nothing, and no screenshot reveals it. If you add a
setting, add the rule that reads it in the same change.

**One message key per fact.** Reusing a key another surface already owns renders
the other surface's copy, and no test catches it — mounted in isolation there is
no catalogue, so the fallback renders and everything passes.

**The funny level changes voice, never facts.** A message at any level still
names what happened, what is affected, and what the options are. If a change
makes a message funnier and less clear, it is a regression. A warning nobody can
act on is a broken warning, not a funny one.

**A comment that asserts a safety property is a claim.** Verify it or delete it.
A comment inventing a guarantee is worse than no comment, because it removes the
check that would have caught the defect — specifically for the careful reader who
took it at its word.

## Commit messages

Say what changed and why, in unambiguous words. A message that is entertaining
but leaves the reader unsure what changed is a broken commit message, not a good
one. Roast the code, never a person.
