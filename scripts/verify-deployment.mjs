#!/usr/bin/env node
/**
 * Prove co-authoring works against the REAL deployed container.
 *
 * This runs INSIDE the container, by design. It needs a session token, and a
 * session token is a bearer credential: minting one anywhere else would mean
 * carrying it across a network and through somebody's terminal scrollback for
 * no benefit. Run here, the secret is already in this process's environment,
 * the token exists for a few seconds, and only the verdict travels.
 *
 * Deliberately does not import the server's own modules. It re-implements the
 * token format from the documented scheme and speaks the protocol as a client
 * would, so a change that broke either would fail here rather than agreeing
 * with itself.
 *
 *   docker cp scripts/verify-deployment.mjs <container>:/tmp/verify.mjs
 *   docker exec <container> node /tmp/verify.mjs
 */

import crypto from 'node:crypto';
import process from 'node:process';

const SECRET = process.env['SESSION_SECRET'] ?? '';
const PORT = process.env['PORT'] ?? '8787';
const BASE = 'http://127.0.0.1:' + PORT;

if (SECRET === '') {
  process.stderr.write('[verify] SESSION_SECRET is not in this environment\n');
  process.exit(1);
}

/** The token format, re-implemented from the scheme rather than imported. */
function mint(subject, name) {
  const body = JSON.stringify({
    principal: { subject, displayName: name, email: '', groups: [] },
    expiresAt: Date.now() + 60_000,
  });
  const encoded = Buffer.from(body, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return encoded + '.' + signature;
}

const results = [];
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    results.push('  ok    ' + label);
  } else {
    failed += 1;
    results.push('  FAIL  ' + label + (detail === '' ? '' : ' -- ' + detail));
  }
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.inbox = [];
    socket.addEventListener('message', (event) => {
      this.inbox.push(JSON.parse(String(event.data)));
    });
  }

  static open(subject, name) {
    const url =
      'ws://127.0.0.1:' + PORT + '/sync?token=' + encodeURIComponent(mint(subject, name));
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(new Client(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('refused')), { once: true });
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  // Polls rather than racing a listener: the message may already have arrived
  // before the wait started, and a late listener waits forever for something
  // sitting in the queue.
  async next(type, predicate = () => true, timeout = 8000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = this.inbox.findIndex(
        (message) => message.type === type && predicate(message),
      );
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (Date.now() > deadline) {
        throw new Error(
          'waited ' + timeout + 'ms for ' + type + '; saw ' +
            JSON.stringify(this.inbox.map((m) => m.type)),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close() {
    this.socket.close();
  }
}

const room = 'verify-' + process.pid;

try {
  // ---------------------------------------------------------------- HTTP --
  const health = await (await fetch(BASE + '/health')).json();
  check('health reports ok', health.status === 'ok', JSON.stringify(health));

  const version = await (await fetch(BASE + '/version')).json();
  check('version reports real provenance', version.version !== 'unavailable', version.version);
  check(
    'the session secret is never returned, only a fingerprint',
    version.sessionSecret !== SECRET && !SECRET.includes(version.sessionSecret),
  );

  // ---------------------------------------------------------------- auth --
  let refused = false;
  try {
    await Client.open.call(null, 'x', 'x');
  } catch {
    refused = true;
  }
  // The real check: a forged token must not connect.
  const forged = new WebSocket('ws://127.0.0.1:' + PORT + '/sync?token=forged');
  const forgedRefused = await new Promise((resolve) => {
    forged.addEventListener('open', () => resolve(false), { once: true });
    forged.addEventListener('error', () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 4000);
  });
  check('a forged token is refused at the upgrade', forgedRefused);
  void refused;

  // --------------------------------------------------------------- relay --
  const ada = await Client.open('u-ada', 'Ada');
  const bo = await Client.open('u-bo', 'Bo');

  ada.send({ type: 'join', room, replica: 'ada', name: 'Ada', since: null });
  await ada.next('joined');
  bo.send({ type: 'join', room, replica: 'bo', name: 'Bo', since: null });
  await bo.next('joined');
  check('two clients joined the same document', true);

  ada.send({
    type: 'operations',
    operations: [{ kind: 'insert', id: { replica: 'ada', counter: 1 }, after: null, value: 'H' }],
  });
  const relayed = await bo.next('operations');
  check(
    'an operation reached the other editor with a sequence',
    relayed.operations.length === 1 && relayed.operations[0].sequence === 1,
    JSON.stringify(relayed),
  );
  check(
    'the operation kept its replica and payload intact',
    relayed.operations[0].replica === 'ada' && relayed.operations[0].operation.value === 'H',
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'the sender was not echoed to',
    !ada.inbox.some((message) => message.type === 'operations'),
  );

  // ------------------------------------------------------------ presence --
  const presence = await ada.next('presence', (message) => message.members.length === 2);
  check(
    'presence lists both editors',
    presence.members.map((m) => m.replica).sort().join(',') === 'ada,bo',
  );

  bo.send({ type: 'presence', caret: 7 });
  const caret = await ada.next(
    'presence',
    (message) => message.members.some((m) => m.replica === 'bo' && m.caret === 7),
  );
  check('a caret moved through presence', caret !== undefined);

  // ------------------------------------------------------------- backlog --
  const late = await Client.open('u-cheung', 'Cheung');
  late.send({ type: 'join', room, replica: 'cheung', name: 'Cheung', since: 0 });
  const joined = await late.next('joined');
  check(
    'a late joiner received the backlog it missed',
    joined.backlog.length === 1 && joined.backlog[0].operation.value === 'H',
    JSON.stringify(joined.backlog),
  );
  check('the room head is reported', joined.head === 1, String(joined.head));

  // ---------------------------------------------------- refusals, live --
  const ahead = await Client.open('u-ahead', 'Ahead');
  ahead.send({ type: 'join', room, replica: 'ahead', name: 'Ahead', since: 9999 });
  const error = await ahead.next('error');
  check(
    'resuming from history the server never issued is refused',
    error.fatal === true && /reload/.test(error.reason),
    error.reason,
  );

  ahead.send({ type: 'nonsense' });
  const reported = await ahead.next('error');
  check('an unrecognised message is reported, not dropped', /unrecognised/.test(reported.reason));

  // -------------------------------------------------------- persistence --
  const documents = await (await fetch(BASE + '/api/documents')).json();
  check(
    'the room was written to the vault',
    documents.documents.includes(room),
    JSON.stringify(documents.documents),
  );

  // ------------------------------------------------------------- policy --
  const published = await fetch(BASE + '/api/policy', {
    method: 'PUT',
    body: JSON.stringify({
      version: Math.floor(Date.now() / 1000),
      publishedAt: new Date().toISOString(),
      settings: { verified: true },
    }),
  });
  check('a policy was published', published.status === 200, String(published.status));
  const pushed = await ada.next('policy');
  check('the policy reached a connected client', pushed.policy.settings.verified === true);

  const older = await fetch(BASE + '/api/policy', {
    method: 'PUT',
    body: JSON.stringify({ version: 1, publishedAt: '2020-01-01T00:00:00Z', settings: {} }),
  });
  check('an older policy is refused', older.status === 409, String(older.status));

  for (const client of [ada, bo, late, ahead]) client.close();
} catch (error) {
  failed += 1;
  results.push('  FAIL  the run threw -- ' + String(error && error.message ? error.message : error));
}

process.stdout.write(results.join('\n') + '\n');
process.stdout.write(
  '[verify] ' + (results.length - failed) + '/' + results.length + ' checks passed\n',
);
process.exit(failed === 0 ? 0 : 1);
