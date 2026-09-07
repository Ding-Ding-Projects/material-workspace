# Collaboration

Real-time co-authoring, presence, and the self-hosted server that relays them.

| Article | Status |
| --- | --- |
| [Real-time co-authoring](collaboration.md) | Built, verified and deployed |
| [Running the collaboration server](deployment.md) | Deployed and verified on a private host |
| [The HTTP API](../../api/README.md) | Postman collection, exercised against the running server |

## The rule they share

**The server understands nothing about documents.** It relays an ordered log of
opaque operations and remembers them for whoever joins late.

That is what keeps the merge on the client, where every replica can verify it,
rather than in one place everybody has to trust. It also means the server
cannot show, search, or validate a document, and those absences are a
consequence of the design rather than work left undone.

## Not built yet

Tombstone collection, a real SAML terminator, TLS in the server itself, and
per-document authorization beyond room membership.
