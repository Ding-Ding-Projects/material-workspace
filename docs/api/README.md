# HTTP APIs

| Collection | Covers |
| --- | --- |
| [Collaboration server](collaboration.postman_collection.json) | `/health`, `/version`, `/api/documents`, `/api/policy` |
| [Master](master.postman_collection.json) | Every HTTP API in this Oak Kay |

## What is deliberately absent

**The desktop suite serves no HTTP.** It is a local application; nothing listens
on a port. Inventing routes for it would describe an API that does not exist.

**The WebSocket route at `/sync` is not in a collection.** Postman's format
describes HTTP requests, and a socket that stays open exchanging messages is not
one. Representing it as a `GET /sync` would suggest something a reader could
send and get an answer to, which is worse than the honest gap.

It is documented in
[real-time co-authoring](../features/collaboration/collaboration.md) and is
exercised by the live test suite against a real socket, with Node's own
`WebSocket` as the client so interoperability is proved against an independent
implementation.

## Set up

Set `{{baseUrl}}` to the server's origin, or to the proxy's when it runs behind
one. Only the WebSocket upgrade needs a credential; the token is minted by the
server and appears nowhere in this Oak Kay.
