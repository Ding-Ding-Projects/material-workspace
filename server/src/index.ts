/**
 * Entry point. Reads configuration from the environment and starts the server.
 *
 * Every secret arrives through the environment and is read once, here. It is
 * never written to a file, never placed in an argument, never logged, and
 * never returned by an endpoint. `/version` reports a fingerprint of the
 * session secret so two nodes can be confirmed to share configuration; the
 * value itself has no route out of the process.
 */

import process from 'node:process';

import { CollaborationServer, DEFAULT_OPTIONS } from './server';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    // Refused at start-up rather than defaulted. A server that invents its own
    // session secret starts happily and signs tokens nobody else can verify,
    // which presents as "everybody is randomly logged out".
    process.stderr.write('[server] ' + name + ' is not set; refusing to start\n');
    process.exit(1);
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    process.stderr.write('[server] ' + name + ' is not a positive number; refusing to start\n');
    process.exit(1);
  }
  return value;
}

/**
 * Mint one session token, for an operator who already holds the secret.
 *
 * `node server.mjs --issue-token <subject>` prints a token and exits. This is
 * not a route and never will be: it is reachable only by somebody who can
 * already run a process inside the container, which is somebody who can
 * already read the secret from the environment. It adds no access that person
 * did not have.
 *
 * It exists because there is otherwise NO WAY to obtain a token until an
 * identity provider is wired in - which makes the running server impossible to
 * verify from outside, and an unverifiable deployment is one nobody can trust.
 */
const issueAt = process.argv.indexOf('--issue-token');
if (issueAt >= 0) {
  const subject = process.argv[issueAt + 1];
  if (subject === undefined || subject === '') {
    process.stderr.write('[server] --issue-token needs a subject\n');
    process.exit(1);
  }

  const minter = new CollaborationServer({
    ...DEFAULT_OPTIONS,
    sessionSecret: required('SESSION_SECRET'),
    // Never started, so provenance is never read - but the type asks for it,
    // and inventing a version here would put a false one somewhere eventually.
    version: 'unavailable',
    builtAt: 'unavailable',
  });
  // Short-lived on purpose. A token minted by hand for a check should not still
  // work tomorrow, and nothing about this path needs it to.
  process.stdout.write(
    minter.issue(
      { subject, displayName: subject, email: '', groups: [] },
      10 * 60 * 1000,
    ) + '\n',
  );
  process.exit(0);
}

const server = new CollaborationServer({
  ...DEFAULT_OPTIONS,
  port: number('PORT', DEFAULT_OPTIONS.port),
  host: process.env['HOST'] ?? DEFAULT_OPTIONS.host,
  vaultRoot: process.env['VAULT_ROOT'] ?? DEFAULT_OPTIONS.vaultRoot,
  sessionSecret: required('SESSION_SECRET'),
  // Provenance, bound to the artifact rather than to launch time. Missing
  // provenance reports an honest unavailable state; it never invents one.
  version: process.env['BUILD_VERSION'] ?? 'unavailable',
  builtAt: process.env['BUILD_TIME'] ?? 'unavailable',
});

const port = await server.start();
process.stdout.write('[server] listening on port ' + port + '\n');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('[server] ' + signal + ' received; closing connections\n');
    void server.stop().then(() => process.exit(0));
  });
}
