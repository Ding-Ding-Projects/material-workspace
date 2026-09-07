# Running the collaboration server

**Status: deployed and verified on a private container host.** 18 checks
against the running container, plus a restart that proved the vault survives.

The host is not named here. This is a public Oak Kay, and an address, a
hostname or an SSH target in it is an invitation rather than documentation.
What is recorded is everything a reader needs to run their own.

## What you need

A container host with Docker and Compose. Nothing else: the image is a Node
runtime and one bundled file, with no runtime dependencies and no database,
cache or broker to operate.

## Running it

```bash
cd server

# The secret is generated ON THE HOST, straight into a 0600 file. It must
# never pass through a command argument, a shell history, a log line, or a
# commit. Regenerating it logs everybody out, so an existing one is left alone.
umask 077
{ printf 'SESSION_SECRET='; openssl rand -base64 48 | tr -d '\n'; printf '\n'; } > .env
chmod 600 .env

docker compose up -d --build
```

`SESSION_SECRET` is the one required setting; the server **refuses to start**
without it rather than inventing one. A server that invents its own secret
starts happily and signs tokens no other node can verify, which presents to
users as "everybody is randomly logged out" and to an operator as nothing at
all.

Optional: `COLLAB_PORT` (published port), `BUILD_VERSION` and `BUILD_TIME`
(provenance reported by `/version`, which shows `unavailable` rather than
inventing a value when they are absent).

## Choosing a host is a live check, not a lookup

The host recorded in a plan is a routing hint. Before deploying, confirm on the
host itself: its architecture, free memory and disk, Docker's health, what it
is already running, and which ports are already published.

That is not ceremony. On this deployment the recorded target had gone offline
entirely, and the fallback that looked obvious was already carrying twelve
containers on four gigabytes with swap in use, with the intended port taken by
something else. Both facts were invisible from the plan and took one command
each to establish.

## It is bounded so it cannot crowd its neighbours

The compose file caps the container at 1.5 CPU and 768 MiB, drops every
capability, runs read-only with a small tmpfs, and forbids privilege
escalation. Logs are capped, because a long-running container that fills a
host's disk takes every unrelated workload down with it.

Confirm the limits actually applied rather than assuming the file was read:

```bash
docker inspect -f 'memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} readonly={{.HostConfig.ReadonlyRootfs}}' <container>
```

## The health check speaks to the real route

`pgrep node` reports a process that is alive and has stopped serving as
healthy, which is the exact state a liveness check exists to catch. So the
check fetches `/health`.

`/health` deliberately touches nothing — no disk, no vault. A health check that
reads the disk reports unhealthy during a slow write, and an orchestrator then
restarts a server that was working perfectly.

## Verifying a deployment

`scripts/verify-deployment.mjs` proves co-authoring against the **running
container**, not against a local test server:

```bash
cat scripts/verify-deployment.mjs \
  | ssh <host> "docker exec -i <container> sh -c 'cat > /tmp/verify.mjs && node /tmp/verify.mjs'"
```

It runs inside the container on purpose. It needs a session token, and a token
is a bearer credential: minting one anywhere else means carrying it across a
network and through somebody's terminal scrollback for no benefit. Run there,
the secret is already in that process's environment, the token lives for a
minute, and only the verdict travels.

It also does not import the server's own modules. It re-implements the token
format from the documented scheme and speaks the protocol as a client would,
so a change breaking either fails here instead of agreeing with itself.

Note that `docker cp` into this container is **refused** — the read-only rootfs
is doing its job. Piping through the container's own writable tmpfs is the way
in, and the refusal is a good sign rather than a problem to configure away.

### What the 18 checks cover

Health and provenance; that the secret is never returned, only a fingerprint;
that a forged token is refused at the upgrade; two clients joining one
document; an operation relayed with its sequence, replica and payload intact;
that the sender is **not** echoed to; presence listing both editors; a caret
moving; a late joiner receiving the backlog; a resume from history the server
never issued being refused; an unrecognised message being reported rather than
dropped; the room reaching the vault; and a policy being published, pushed, and
an older one refused.

## Restarting

```bash
docker compose restart
```

The vault is a named volume, so the operation logs survive. Verified by listing
documents before and after and comparing.

## Not built yet

TLS termination (run it behind a proxy), a SAML terminator, horizontal scaling
across more than one node — which would need the room registry to move out of
process — and tombstone collection.

## Suggested articles

- [Real-time co-authoring](collaboration.md)
- [The HTTP API](../../api/README.md)
