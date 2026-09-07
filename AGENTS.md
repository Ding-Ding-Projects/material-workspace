# Agent working conventions

A sanitized mirror of the shared agent instructions this project is developed
under. Machine-specific detail — paths, usernames, hostnames, addresses, hosts,
credentials — is deliberately absent, and so is the maintainers' private working
vocabulary. Instruction changes are made in the canonical instructions repository
first and mirrored here; editing this file does not propagate anywhere.

## Scope

Every rule below applies to **every user-facing surface individually** — each of
the nine applications, the settings surfaces, every dialog and panel, and the
documentation site. "It is only the docs site", "it is only a small panel", and
"the other application already does that" are not exemptions. When a rule
genuinely cannot apply to a surface, name the rule and the reason in that
surface's documentation rather than leaving a silent gap that reads as an
oversight to the next person and as a decision to nobody.

## Honesty

- **Never claim a capture, a test, a build or a release that did not happen.** A
  check that has not run is unrun, not passed. A run still going is still going.
- **Report the exact figures**: commit identifiers, file paths, test counts,
  error text, verification state.
- **A failure is reported as a failure**, in the same breath as whatever did
  work. Partial success is described as partial.
- **Correct a wrong claim where it was made**, rather than quietly moving on.

## Verification

- **Measure the built artifact, not the configuration.** A green packaging log
  proves a file was copied, never that anything can find it. A unit test that
  injects its dependency proves the screen and nothing about the wiring.
- **A guard nobody has watched fail proves nothing.** Break the invariant, watch
  red, restore, watch green.
- **A rule-shaped guard passes trivially on a surface that has none of the
  thing.** Pair every such rule with a hand-written inventory of what must
  exist, so a feature that disappeared entirely is still detected.
- **Anchor assertions to a line, never a bare substring.** A commented-out call
  still contains its own text; a rename still contains the old name as a prefix.
- **Assert through an independent channel.** For anything involving a subprocess
  or a remote resource, confirm the outcome by asking that system directly
  rather than believing the module's own report of its own success.

## Delivering

- **Never ship a decorative control.** Anything that looks operable must perform
  its labelled action, expose an accessible equivalent, and persist its state.
  A surface that is not built yet says so in words.
- **Follow a token to a reader.** A custom property nothing consumes is a
  control that silently does nothing, and no capture reveals it.
- **Accessibility is a completion blocker**, not polish: keyboard reachability,
  visible focus, correct roles, names and states, contrast, reduced motion.
- **No clipping**, at any supported width, at 100/125/150/200% display scale, in
  any language mode. Bilingual mode carries the longest strings and is where
  clipping appears first.
- **Guided input.** Where a value can be enumerated, picked or browsed, it is.
  Every path field gets a native browse control. Every disabled control names
  the exact condition that is unmet.

## Language and tone

- Three language modes — English, playful Hong Kong Cantonese, and both — and two
  independent funny-level sliders, one per language, each 1 to 5 and each
  shipping at 5.
- **The funny level changes voice, never facts.** At any level a message still
  names what happened, what is affected, and what the options are. Humour wraps
  the facts; it never replaces, softens or omits them.
- This applies to every category with no exemption, including errors, warnings
  and destructive confirmations, because the user is told plainly what the
  setting affects before they opt in.
- Humour is aimed at the work, never at a person.

## Money and privacy

- **Nothing in this application is for sale.** Accessibility, the language modes,
  the funny levels, School mode, and export of the user's own data can never sit
  behind a payment.
- **No nagging**: no donation prompts, rating requests, or upgrade banners.
- **No network calls** except to a collaboration server the user configures.
- **Code signing is permanently out of scope.** Installers are unsigned and every
  surface that mentions them says so.
- **Secrets never enter** the repository, a commit, a log, a command argument, an
  export, a capture, or any public record.

## Repository work

- Pull before starting. Preserve unrelated work. Never force-push without
  explicit authorization.
- Commit and push per task rather than batching; prove a push landed by asking
  the remote rather than assuming.
- Keep `README.md`, `ROADMAP.md`, `HANDOFF.md` and the feature documentation
  accurate **in the same task** that changes behaviour. Stale documentation is
  worse than none, because it is confidently wrong and the reader cannot tell.
- `ROADMAP.md` is a real checklist. Tick an item only when it is finished and
  verified. Never delete an item to make the list look complete; strike it
  through with the reason.

## Recorded traps

Findings from real defects in this repository, kept so nobody pays for them
twice.

- **`copyFileSync` preserves the source timestamp on Windows**, so a copied build
  output can look older than its sources and a freshness check will correctly
  call a good build stale. Stamp emitted files with the time they were emitted.
- **`import.meta` is empty in a CommonJS bundle.** The bundler warns; the runtime
  failure is a path resolved from nothing, which surfaces as a window that never
  loads rather than as an error naming the cause.
- **A GUI process may not inherit the shell's PATH.** Resolve required external
  executables explicitly and report every location tried, or a tool that is
  plainly installed reports as missing.
- **`git status --porcelain --cached` is not a command** and exits 129. Use
  `git diff --cached --name-only`.
- **npm's install-script gate can leave a package present with an empty binary
  directory**, and the vendor's own installer may exit 0 having extracted
  nothing. Judge by whether the binary exists afterwards.
- **Control characters in source are fragile.** A separator written as a literal
  unprintable becomes the empty string if any tool strips it, and an empty
  separator makes every parse return one field with no error.
- **`JSON.parse` keeps the last of a duplicated key**, so duplicates must be
  detected on the raw text before parsing or they are unknowable.
