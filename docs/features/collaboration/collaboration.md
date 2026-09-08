# Real-time co-authoring

**Status: built, verified, and deployed.** 22 CRDT tests, 43 server tests
(17 of them against a real server over a real socket), and 18 further checks
against the running container on a private host.

Two people edit the same paragraph at the same time, offline, and both edits
survive with the same result on every machine — without a server deciding a
winner and without either edit being silently dropped.

## The design, and what it costs

The merge is a **replicated growable array**: every character carries an
identity, an insertion is positioned relative to an existing identity, and a
deletion is a tombstone. Two replicas that have seen the same operations, in
any order, hold the same text.

The alternatives were considered and rejected for reasons worth stating:

- **Operational transform** needs a central server to order operations and a
  transformation function for every pair of operation types. Getting one pair
  wrong corrupts documents under specific timing, which is the worst possible
  failure to debug.
- **A last-writer-wins register** over the whole document is trivial and throws
  away one person's work every time two people type at once.

The cost is real and is not hidden: **tombstones are never collected.** A
heavily edited document carries every deleted character forever. That is fine
for a session and wrong for a document kept for years. Collecting them needs a
causal-stability check across every replica, which needs the server, and it is
not built.

## An orphan waits rather than being guessed at

An insert whose anchor has not arrived yet is **held**, keyed by the anchor it
is waiting for, and lands the moment that anchor arrives.

The first implementation placed it at the start of the document instead. That
looked entirely harmless — the character was visible, nothing was lost, and
three hand-written convergence scenarios passed. It was wrong, because a
provisional placement is never revisited, so a replica that received the
operations in a different order settled on different text.

It was caught by testing convergence as a **property over all 720 orderings**
of six operations rather than as three scenarios somebody imagined. All three
imagined ones were in the agreeing majority.

## The server understands nothing about documents

It holds an ordered log of opaque operations and hands each one to everybody
else in the room. It cannot show a document's text, cannot search it, and
cannot validate an edit.

That is deliberate. Pulling the merge up to the server would mean every client
had to trust the server's version of it, which is exactly the coupling a CRDT
exists to remove.

### Up to date and too far behind are different answers

A client asking for everything since sequence 5 gets an **empty list** when it
is current, and a **refusal telling it to reload** when 5 has been evicted from
the bounded log. Collapsing the two is how a client silently misses edits: it
is handed nothing, concludes it is current, and the document moves on without
it.

Asking to resume from a sequence **ahead** of anything the server issued is
also refused. A client claiming more history than exists has state this room
does not, and telling it "you are current" would leave it believing its text
matched an empty room. That one was found by the live suite; the arithmetic
reads perfectly well until somebody actually asks.

### Presence expires rather than needing a goodbye

A disconnect is frequently not observed: a lid closes, a network drops, a
process is killed. A list that only removes people who said goodbye fills with
ghosts, and a ghost is worse than useless because somebody waits for a reply
from a person who left an hour ago.

## Offline is the normal case, not the error case

The suite is fully usable with the server unreachable. Edits queue locally and
reconcile on reconnect; a failed send returns to the **front** of the queue,
because operations are causally ordered and an insert anchored to a character
in the failed batch must not be sent before it.

A server that is down degrades collaboration and nothing else.

## The wire

Node's own `WebSocket` is used as the client in the test suite rather than this
repository's codec. Testing the framing against itself would prove the two agree,
which they will whether or not either is correct; an independent RFC 6455
implementation is the only thing that proves interoperability.

The framing is written here rather than taken from a package, because the suite
installs nothing alongside itself and that has to hold for the server too. What
is deliberately **not** implemented is `permessage-deflate` compression, so the
handshake never accepts an extension and a client offering one falls back to
uncompressed frames rather than being handed a connection this code cannot
read.

Every limit is bounded before allocation: a frame ceiling, a whole-message
ceiling across every fragment, a per-message operation count, a room member
count, and a bounded log. A peer claiming a four-gigabyte payload is refused
before this process tries to hold one.

## Identity

- **Session tokens** are minted and verified here, HMAC-SHA256, compared in
  constant time. The secret is read from the environment once and has no route
  out of the process; `/version` reports a non-reversible fingerprint so two
  nodes can be confirmed to share configuration without either printing it.
- **SAML assertions** are mapped onto a principal from attributes that have
  **already been verified elsewhere**. This does not parse or verify a signed
  SAML response: that needs XML canonicalisation and XML signature
  verification, and a half-implementation of either looks like verification and
  is not. A deployment needs a proxy that terminates SAML.
- **SCIM** deprovisioning is enforced at the mapping. `active: false` is
  refused there rather than being a field somebody downstream might check,
  because offboarding is the one thing a directory integration exists for.

An assertion with no stable subject is refused rather than falling back to the
email address — an email is reassignable, so a leaver's address given to a new
starter would hand them the leaver's documents.

## Policy never moves backwards

A client applies a policy only when its version is **higher** than the one in
force. A stale reply arriving late would otherwise quietly re-enable something
an administrator had just turned off, with nothing reporting it.

The same version with different content is refused too, and the refusal is
recorded. An administrator who edited without bumping the version needs to be
told, rather than silently obeyed on whichever node happened to poll last.

## Verifying it yourself

```powershell
npm test                     # 443 tests; 22 CRDT, 43 server, 17 over a real socket
cd server; node build.mjs    # bundles to one file with no runtime dependencies
```

Against a running deployment, see
[running the collaboration server](deployment.md).

## Not built yet

Tombstone collection, a real SAML terminator, TLS termination in the server
itself (it runs behind a proxy), per-document authorization beyond room
membership, horizontal scaling across more than one node, and reconnect backoff
tuned against a real link.

## Suggested articles

- [Classification, scanning and retention](../governance/governance.md)
- [Autosave and document history](../saving/autosave-and-history.md)
