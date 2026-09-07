# Classification, scanning and retention

**Status: built and verified.** 30 engine tests plus 18 checks driven against
the real built window.

Three questions somebody asks about a document at the same moment: how
sensitive is it, does it contain anything it should not, and how long do we
keep it. So they share one surface.

## Classification

### A label only ever goes up without authority

Anybody may mark a document **more** sensitive, with no reason required —
erring towards more protection is never the dangerous direction.

Lowering needs **both** the authority and a written justification, and having
one without the other is refused with the specific thing that is missing rather
than a generic denial. The justification is recorded, because it is what
somebody reviewing the decision later actually reads.

A system where a label can drift downwards silently is a system where the label
means nothing.

### Unknown is not public

An unlabelled document sits **above** public in the ordering. "Nobody has
assessed this" and "this may be shared with anybody" are different facts, and
treating the first as the second is how a gap in process becomes a disclosure.

The surface styles it as a warning rather than as neutral, and says so in
words.

### A derived document inherits the highest label of its sources

Pasting from a restricted document into an unlabelled one and keeping the
unlabelled label is the single most common way classified material escapes. So
inheritance takes the **maximum**, and records which labels it came from.

### An export beyond a destination's limit is refused, not warned

A warning that can be clicked past is a warning that will be — and the person
clicking past it is usually in a hurry for exactly the reason that makes it a
bad idea.

Warnings are reserved for things that are allowed but worth saying: sending
internal material outside the organisation, or exporting a document nobody has
assessed.

## Sensitive-content scanning

### It finds patterns, not secrets

Said on the surface, above the findings, not buried in documentation. It cannot
tell a real card number from a test one, or a private key from a paragraph
about private keys. It is a prompt to look, not a verdict.

A scanner that oversells itself is worse than none, because people trust it and
then stop looking.

### Checksums, because a scanner that cries wolf gets switched off

- **Card numbers** are Luhn-checked. Without it, any sixteen digits match — a
  phone number, an order reference, a row of measurements.
- **Hong Kong identity cards** have their check digit verified, using the
  published algorithm. The example it is tested against, `A123456(3)`, is the
  one published with that algorithm, so the test confirms the implementation
  against an outside source rather than against itself.
- **API tokens** are matched only with a recognisable prefix. A bare long
  string is deliberately **not** matched, because base64 data, hashes and
  identifiers all look the same and matching them makes the scanner useless.

### Findings never disclose what they found

The preview is the first two and last two characters with the middle replaced —
enough to recognise which occurrence is meant, not enough to reconstruct it.

The whole point is that the matched text is sensitive. Writing it into a log,
a report or a screenshot moves the secret somewhere with weaker protection than
the document it came from. The full match never leaves the scan.

### Every finding that can be a false positive says so

Beside the finding, not in a footnote. "Verified with the Luhn check, which a
deliberate test number also passes." "A document that merely quotes this header
would also match."

## Retention

### Nothing is deleted automatically

A policy marks what is **due**; a person acts. Automatic deletion driven by a
date is how organisations destroy the one document they later needed, and it is
unrecoverable by definition.

Every due record says so explicitly: *"Nothing has been done automatically."*

### A legal hold outranks every policy

Checked **first**, before anything else, so a held record is never reported as
due even for a moment. The hold is given as the reason, with who placed it and
why — which saves somebody an afternoon wondering why the policy is not
working.

Held records are excluded from the list of things to decide **entirely**,
rather than sorted to the bottom. They are not actionable, and putting them in
a list of things to do is how somebody deletes one.

### The clock starts at an event, not at creation

"Seven years after the contract ends" and "seven years after the file was made"
are different dates, and using the wrong one destroys records early.

A record whose clock has not started is **not due** — treating a missing start
date as "now" would make an open contract instantly expired.

### Month arithmetic clamps rather than rolls

31 January plus one month is 28 February, not 3 March. JavaScript's own date
arithmetic rolls over, which for a retention date means destroying a record a
month early or keeping it a month late, **every time**. There are tests for
the leap year too.

## Verifying it yourself

```powershell
npm test                            # 361 tests, 30 of them governance
node scripts/drive-governance.mjs   # 18 checks against the real window
```

The scan runs in the renderer, on this machine. It makes no network request and
writes nothing anywhere.

## Not built yet

Policy distribution from a server, per-user authority beyond a single flag,
signature generation and verification, and applying a label to a real document
rather than to the panel's own example. The audit log exists and is
hash-chained; nothing on this surface writes to it yet.

## Suggested articles

- [Autosave and document history](../saving/autosave-and-history.md)
- [File formats](../files/formats.md)
