# Deploying the collaboration server

```
node server/deploy.mjs <user@host> [port]
node server/verify-live.mjs <user@host> [port]
```

The first builds and starts the stack on a container host. The second proves it
works from outside, with two real clients over the network.

## Where it is running

Deployed to **`der`** (ARM64, Debian 13, Docker 29.7.1) on port **8477**.

Not to the host the plan named. `super` was chosen for this stack because it was
the lightly loaded general-purpose host when the inventory was written, and it
was **unreachable** when the deployment ran - the SSH connection timed out.

That is exactly what the live preflight exists for. A recorded inventory is a
routing hint about what was true once, never permission to act on it now, and a
deployment script that trusts it deploys nothing on the day the host is down.

## What the script checks before it sends anything

- **The host is who it says.** Architecture, memory, disk and Docker version are
  read live, and a host with under 512 MB available is refused rather than
  squeezed.
- **The port is free, or already ours.** A port somebody else publishes belongs
  to their workload and the deployment stops. A port this stack already
  publishes is a redeploy and proceeds - refusing that outright would block
  every second deployment, and the fix somebody reaches for then is to delete
  the check.
- **Nothing else is touched.** No global prune, no stopping a container it did
  not start. The host carries unrelated workloads that other people depend on.

## The secret

Generated **on the host**, straight into `~/material-workspace-collab/.env` with
`umask 077`, and never returned to the deploying machine. The deploy script
therefore cannot leak it, because it never learns it.

An existing secret is kept rather than replaced. Rotating it on every deployment
would invalidate every token in circulation and present as everybody being
randomly signed out.

`/version` reports a short **fingerprint** of the secret so two nodes can be
confirmed to share configuration. The value itself has no route out of the
process.

## The limits, as actually applied

This is the part worth reading, because the compose file and reality disagree
on this host and the file is the thing people read.

| Declared | Applied on `der` |
| --- | --- |
| 1.5 CPUs | **1.5 CPUs** |
| 768 MB memory | **not enforced** |
| Read-only root filesystem | **yes** |
| `no-new-privileges` | **yes** |
| All capabilities dropped | **yes** |

The kernel on this host has no memory cgroup controller -
`/sys/fs/cgroup/cgroup.controllers` lists `cpuset cpu io pids` and Docker warns
`No memory limit support` at start-up. Compose declares the cap, the daemon
discards it, and `HostConfig.Memory` on the running container is `0`.

So the deploy script **inspects what the container really got and prints it**,
rather than leaving anybody to read the compose file and reason from a bound
that is not there. On a kernel with the controller the cap applies; check the
line the script prints, not the file.

Nothing here makes the stack unsafe to run beside other workloads: it is
read-only, drops every capability, cannot gain privileges, and is capped on CPU.
What is missing is the memory ceiling, and that is stated rather than assumed.

## Verifying it, from outside

`verify-live.mjs` is not the unit suite. The suite exercises the CRDT and the
room model in process, which says nothing about whether the container on the
other side of a LAN actually serves - and this project has already shipped a
whole feature dead behind a green suite for precisely that reason.

It mints two short-lived tokens **inside the container**, opens two real
WebSocket connections over the network, and checks:

| | |
| --- | --- |
| A client can join a room | The join is answered by the deployed server |
| The second client sees the first | Membership is shared, not per-connection |
| Presence reaches the other client | Which is the only place presence is useful |
| Each client receives the other's operations, and not its own back | |
| Both agree on the order | Which is what makes it one document rather than two |
| Every operation is ordered exactly once | Interleaved from both clients |
| A client that went away is handed what it missed | The offline case, which is normal |
| The backlog arrives in sequence order | |
| A forged token is refused at the handshake | |
| Every connection is released when clients leave | No phantom members |

**10 of 10 passing** against the live container.

### Minting a token

There is no HTTP route that issues a token, and there will not be one. Until an
identity provider is wired in, an operator mints one inside the container:

```
docker exec <container> node server.mjs --issue-token <subject>
```

That is reachable only by somebody who can already run a process in the
container, which is somebody who can already read the secret from its
environment. It adds no access that person did not have. Tokens minted this way
last ten minutes.

## Offline is the normal case

The desktop suite is fully usable with this server stopped. Proved by stopping
it and re-running everything:

| With the container stopped | Result |
| --- | --- |
| The shell | 56 of 56 |
| Collaboration surface | 13 of 13 |
| Writer | 19 of 19 |
| Sheets | 43 of 43 |
| Database | 25 of 25 |
| The whole unit suite | 870 tests |

A server that is down degrades collaboration and nothing else. Starting it again
and re-running the live verification returns 10 of 10, so an outage costs
nothing but the time it lasted.

## Rolling back

The image is built on the host from the sources sent, and tagged
`material-workspace-collab:local`. To go back to a previous commit, check that
commit out locally and run the deploy script again - it reports the version it
started, and refuses if the running version is not the one it sent.

The document vault lives in the `collab-data` volume and is not touched by a
redeployment.

## Related

- [Collaboration](README.md)
