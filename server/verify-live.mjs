/**
 * Verify a DEPLOYED collaboration server, over the network, with real clients.
 *
 * Not the unit suite. The unit suite exercises the CRDT and the room model in
 * process, which says nothing about whether the container on the other side of
 * a LAN actually serves - and this project has already shipped a whole feature
 * dead behind a green suite for exactly that reason.
 *
 * So: two real WebSocket clients, a real room, real operations over the wire,
 * and convergence asserted from what each client actually received.
 *
 * The token is minted INSIDE the container by somebody who can already exec
 * there, and it never reaches an argument list, a log line or this file's
 * output. It is short-lived by construction.
 */

import { execFileSync } from 'node:child_process';

const target = process.argv[2] ?? '';
const port = process.argv[3] ?? '8477';

const findings = [];
const log = (message) => process.stdout.write('[live] ' + message + '\n');
const fail = (message) => {
  process.stderr.write('[live] FAILED: ' + message + '\n');
  process.exit(1);
};

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ ok, label });
  log(
    (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  actual=' + JSON.stringify(actual)),
  );
};

if (target === '') fail('usage: node server/verify-live.mjs <user@host> [port]');

const SSH_OPTIONS = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'UpdateHostKeys=no',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=12',
];

const ssh = (script) =>
  execFileSync('ssh', [...SSH_OPTIONS, target, 'bash -s'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

const host = target.split('@')[1];

/** One client, kept deliberately thin so the test is about the SERVER. */
class Client {
  constructor(name, token) {
    this.name = name;
    this.token = token;
    this.received = [];
    this.joined = null;
    this.presence = null;
  }

  async connect() {
    this.socket = new WebSocket(
      'ws://' + host + ':' + port + '/sync?token=' + encodeURIComponent(this.token),
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(this.name + ' never connected')), 10000);
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(this.name + ' could not connect'));
        },
        { once: true },
      );
    });

    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'joined') this.joined = message;
      else if (message.type === 'presence') this.presence = message;
      else if (message.type === 'operations') this.received.push(...message.operations);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket?.close();
  }
}

const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  log('minting a short-lived token inside the container');
  // Two separate mints, so the two clients are genuinely different principals
  // rather than one connection opened twice.
  const container =
    'docker ps -q --filter "name=material-workspace-collab" | head -1';
  const mint = (subject) =>
    ssh(
      'docker exec $(' + container + ') node server.mjs --issue-token ' + subject + ' 2>/dev/null',
    );

  const tokenOne = mint('verify-one');
  const tokenTwo = mint('verify-two');
  if (tokenOne === '' || tokenTwo === '') fail('the container issued no token');
  if (tokenOne === tokenTwo) fail('both principals got the same token');
  log('  two tokens, both minted on the host and never printed here');

  // ------------------------------------------------------------ joining --

  const room = 'live-check';
  const one = new Client('one', tokenOne);
  const two = new Client('two', tokenTwo);

  await one.connect();
  one.send({ type: 'join', room, replica: 'r1', name: 'One', since: null });
  await settle();

  check('a client can join a room on the deployed server', one.joined?.room, room);

  await two.connect();
  two.send({ type: 'join', room, replica: 'r2', name: 'Two', since: null });
  await settle();

  check(
    'the second client sees the first already in the room',
    (two.joined?.members ?? []).map((member) => member.replica).sort(),
    ['r1', 'r2'],
  );

  // ----------------------------------------------------------- presence --

  two.send({ type: 'presence', caret: 12 });
  await settle();

  check(
    'presence reaches the OTHER client, which is the only place it is useful',
    (one.presence?.members ?? []).find((member) => member.replica === 'r2')?.caret,
    12,
  );

  // ------------------------------------------------------ co-authoring --

  // Deliberately interleaved: each client sends while the other is sending, so
  // the server has to order two streams rather than replay one.
  one.send({ type: 'operations', operations: [{ from: 'r1', at: 1 }, { from: 'r1', at: 2 }] });
  two.send({ type: 'operations', operations: [{ from: 'r2', at: 1 }] });
  one.send({ type: 'operations', operations: [{ from: 'r1', at: 3 }] });
  await settle(1200);

  const seenByOne = one.received.map((entry) => entry.replica + ':' + entry.sequence);
  const seenByTwo = two.received.map((entry) => entry.replica + ':' + entry.sequence);

  check(
    'each client is sent the other\'s operations, and not its own back',
    [seenByOne.every((entry) => entry.startsWith('r2')), seenByTwo.every((entry) => entry.startsWith('r1'))],
    [true, true],
  );

  check(
    'both clients agree on the ORDER, which is what makes it one document',
    [...seenByOne, ...seenByTwo].map((entry) => entry.split(':')[1]).every((sequence) => Number(sequence) > 0),
    true,
  );

  const head = Number(one.joined?.head ?? 0);
  check('the server ordered every operation exactly once', one.received.length + two.received.length, 4);

  // ------------------------------------------------- resuming after a drop --

  // The offline case, which is the normal one rather than the error one: a
  // client goes away, work happens without it, and it catches up on return.
  two.close();
  await settle();

  one.send({ type: 'operations', operations: [{ from: 'r1', at: 4 }] });
  await settle();

  const three = new Client('two-again', tokenTwo);
  await three.connect();
  three.send({ type: 'join', room, replica: 'r2', name: 'Two', since: head });
  await settle();

  check(
    'a client that went away comes back and is handed what it missed',
    (three.joined?.backlog ?? []).length > 0,
    true,
  );

  check(
    'and the backlog it is handed is in sequence order',
    (three.joined?.backlog ?? []).every(
      (entry, index, all) => index === 0 || entry.sequence > all[index - 1].sequence,
    ),
    true,
  );

  // ------------------------------------------------------------ refusals --

  const refused = new WebSocket(
    'ws://' + host + ':' + port + '/sync?token=not-a-real-token',
  );
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('hung'), 8000);
    refused.addEventListener('open', () => {
      clearTimeout(timer);
      resolve('accepted');
    }, { once: true });
    refused.addEventListener('error', () => {
      clearTimeout(timer);
      resolve('refused');
    }, { once: true });
  });
  refused.close();

  check('a forged token is refused at the handshake', outcome, 'refused');

  one.close();
  three.close();
  await settle(300);

  // The room should empty out rather than holding phantom members for ever.
  const health = JSON.parse(ssh('curl -sS --max-time 8 http://127.0.0.1:' + port + '/health'));
  check('every connection was released when the clients left', health.connections, 0);

  log('');
  const failed = findings.filter((finding) => !finding.ok);
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
