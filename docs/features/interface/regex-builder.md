# The regular-expression builder

**Status: built and verified.** Eighteen checks driven against the real built
window, plus twenty-nine unit tests over its analysis core.

## Where it is

Beside **every** search field in this product. Not in a menu, not on a separate
page — anchored to the field you are already typing in, opened by the `.*`
button at the end of that field.

Each field owns its own builder. Several search bars on one surface never share
hidden state, because one shared builder silently applying to whichever field was
last touched is exactly the confusion this design avoids.

## Plain text is the default

Typing `a.b` into a search field matches the literal text `a.b`. Regular
expressions are an explicit opt-in, through the **Regex** switch or by building a
pattern.

The field and the builder stay in step both ways: typing in the field updates the
builder, and building a pattern writes it back into the field.

## What it tells you

### What the pattern means, construct by construct

Every token is explained in words, not restated. `{4}` reads "Repeat the previous
item exactly 4 times. Greedy: takes as MANY as it can, giving back only if the
rest fails." — the greedy-versus-lazy distinction is stated because it is the one
people get wrong.

The analysis is a real scanner, not a regular expression applied to a regular
expression. Patterns nest, escape, and contain the very characters a matcher
would use as anchors, so a pattern-based parser reliably reaches past the
construct it was written for and annotates something in a different one.

### What the engine can actually do

The capability matrix is **detected at run time**, not hard-coded. A hard-coded
list is a claim about a JavaScript version, and this application runs on whatever
Chromium the installed build carries. Offering a construct the engine lacks
produces a pattern that throws when you try it.

Constructs this engine genuinely does not have — atomic groups, possessive
quantifiers, recursion, conditionals — stay **visible** with an explanation and a
workaround where one exists. Hiding them makes the builder look simpler and
leaves you wondering why a pattern you know works elsewhere cannot be built.

### Whether the pattern is dangerous

A regular expression is a program, and some patterns take exponential time on
input that looks ordinary. `(a+)+$` against forty `a` characters followed by a
`b` will hang a tab.

Dangerous shapes are flagged **before** anything runs:

- a repeated group that itself repeats — the classic catastrophic shape
- a repeated group containing alternation whose branches may overlap
- several unbounded wildcards in one pattern
- very large bounded repetitions

These are **heuristics and are labelled as heuristics**. A warning is not proof
of a problem, and no warning is not proof of safety. Saying otherwise would be a
false guarantee, which removes the caution it replaces.

An ordinary safe pattern raises nothing. A scanner that warns about everything is
as useless as one that warns about nothing, and it trains people to ignore it.

## How it stays safe while running your pattern

Evaluation happens in a **worker that the application can terminate**.

This is not belt-and-braces. A catastrophic pattern blocks inside a single
`exec()` call, and JavaScript cannot interrupt that: a deadline checked between
matches never runs, because control never comes back between matches. Measured in
this project's own test suite before the worker existed, `(a+)+$` against 31
characters ran for **94 seconds** against a stated 750 ms bound. The bound was not
exceeded, it was unreachable.

Terminating a worker from the outside is the only mechanism that works. Proven
both ways: the adversarial case is killed at 752 ms, and an ordinary pattern
still completes in 14 ms — because a bound that terminates everything would pass
the first test while making the feature useless.

### The published bounds

| Bound | Value |
| --- | --- |
| Pattern length | 4,000 characters |
| Sample size | 262,144 characters |
| Matches | 10,000 |
| Time before the run is stopped | 750 ms |

When a bound stops evaluation early, the result **says so**. Partial results
presented as complete are worse than none.

## Zero-width matches

A global pattern that matches the empty string does not advance on its own, so
the naive loop spins forever on the same position — which looks exactly like
catastrophic backtracking and is a completely different bug with a different fix.
The evaluator advances explicitly, and `a*` against `bbb` terminates.

## Privacy

Everything is local. The pattern and the sample text are never transmitted, never
logged, never stored, and never leave the machine. There is no network call
anywhere in this feature.

## Verifying it yourself

```powershell
npm test                      # 29 tests over the analysis core
node scripts/drive-ui.mjs     # drives the real window, with the app running
```

The unit tests pin specific expected findings and, crucially, pin the **absence**
of a finding on safe input. The UI drive proves the overlay genuinely paints an
opaque background and genuinely scrolls its own overflow — facts a stylesheet
cannot tell you, because a stylesheet cannot say which rule won.

## Suggested articles

- [Command palette](command-palette.md) — which has its own search, and its own builder
- [Tabs and navigation](tabs.md)
- [Autosave and document history](../saving/autosave-and-history.md)
