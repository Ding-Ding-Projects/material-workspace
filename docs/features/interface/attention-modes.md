# Attention modes

**Status: built and verified.** Each mode is checked by measuring the running
interface before and after, because a setting with no reader is a decorative
control and no screenshot reveals it.

## Five modes, independently toggleable

There is deliberately **no master switch**. Attention difficulties do not arrive
as a single setting: somebody may want the interface quieter without wanting time
nudges, or want time nudges precisely because they are hyperfocusing. Forcing
them into one bundle means most people turn the whole thing off to escape the one
part that does not suit.

**Every one is off by default.** These are accommodations, not opinions about how
anybody should work, and a mode that switches itself on has decided something
about the user it has no standing to decide.

Find them in **Settings → Focus and attention**, or from the command palette.

| Mode | What it does |
| --- | --- |
| Focus | Brings the current thing forward, pushes the rest back |
| Low stimulation | Fewer moving things, quieter colour, fewer notifications |
| Time awareness | Shows elapsed time where the work is |
| One thing at a time | A single visible next action, chosen by you |
| Momentum | A gentle prompt when something has sat untouched |

## Focus

Dims and de-emphasises everything except what you are working in. Hovering or
focusing anything brings it straight back.

**It never hides anything you cannot get back in one obvious action.** An
interface that disappears work is a worse problem than a busy one, so nothing is
removed, nothing loses focusability, and nothing becomes invisible to assistive
technology.

## Low stimulation

Reduces motion, quietens colour, and cuts notifications down to the ones that
genuinely need a person — warnings and errors are never suppressed.

It **composes with** the platform's own reduced-motion preference and never
overrides it. Somebody who has already asked the operating system for less motion
has asked once and must not have to ask again.

Colour is quietened by reducing saturation, **not contrast**. A quieter interface
must not become a less readable one.

## Time awareness

Time blindness is one of the most consistently reported difficulties, and almost
no software helps with it. This shows how long the session has been open, in the
status bar **where the work is** — not buried in a settings page where it answers
the question only for somebody who already thought to ask.

It states a number. That is the whole feature. It does not nag, it does not
count streaks, it does not rank your days, and it never congratulates you.

## One thing at a time

A single visible next action, **chosen by you rather than inferred**. A guessed
next step is worse than none, because it is confidently wrong.

Its value is that it survives a context switch, so it persists like any other
state.

## Momentum

When nothing has changed for ten minutes, a dismissible prompt states the fact:
"Nothing has changed here for 12 minutes." It says what is true and never what
you should feel about it.

Saying **"Not for the next 30 minutes"** is respected for thirty minutes — a
stated period, not the thirty seconds that a dismiss usually buys you.

## Tone

Copy across all five is plain, factual and free of judgement. No streaks, no
scores, no gamified guilt, no congratulation, no scolding.

**None of it is medical.** These are interface accommodations. There is no
diagnosis, no assessment, no advice, and no implication that using or not using
them says anything about you.

The modes are named for what they **do**, so you can use them without disclosing
anything about yourself to a colleague reading over your shoulder.

## Verifying it yourself

Each mode is checked against the running window by comparing a real computed
value before and after the toggle — the status bar's opacity for Focus, the
body's filter for Low stimulation, the presence of a real readout for Time
awareness — and by confirming that turning one off leaves the others exactly as
they were.

## Suggested articles

- [Notifications](notifications.md)
- [Command palette](command-palette.md)
