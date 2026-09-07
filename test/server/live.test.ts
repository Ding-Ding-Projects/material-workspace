/**
 * The server, running, over a real socket.
 *
 * WHY THIS FILE EXISTS AT ALL. A module with a pure half and a socket half
 * attracts its tests to the pure half, because that half is easy and
 * satisfying to test. The count climbs, the assertions look sharp, and the
 * part that carries the feature has never once run. This Oak Kay has already
 * shipped a whole feature dead behind 474 green tests for exactly that reason.
 *
 * So the client here is NODE'S OWN `WebSocket`, not the codec in `server/src`.
 * Testing my framing against my framing would prove the two agree, which they
 * will whether or not either is correct. An independent RFC 6455 client is the
 * only thing that proves interoperability, and it is free.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { CollaborationServer, DEFAULT_OPTIONS } from '../../server/src/server';

const SECRET = 'a-session-secret-long-enough-for-the-check';
const PERSON = {
  subject: 'u-1',
  displayName: 'Ada',
  email: 'ada@example.invalid',
  groups: ['editors'],
};

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-collab-'));

const server = new CollaborationServer({
  ...DEFAULT_OPTIONS,
  // Port 0 asks the operating system for a free one. A fixed port makes the
  // suite fail on a machine that happens to be using it, which reads as a
  // defect in the server rather than as a busy port.
  port: 0,
  host: '127.0.0.1',
  vaultRoot: temporary,
  sessionSecret: SECRET,
  version: 'test',
  builtAt: 'test',
});

const port = await server.start();
const base = 'http://127.0.0.1:' + port;
const token = server.issue(PERSON);

after(async () => {
  await server.stop();
  await fs.rm(temporary, { recursive: true, force: true });
});

/** A connected client, with a queue of everything the server has said. */
class Client {
  private readonly socket: WebSocket;
  private readonly inbox: Record<string, unknown>[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      this.inbox.push(JSON.parse(String((event as MessageEvent).data)));
    });
  }

  static async open(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('the socket refused')), {
        once: true,
      });
    });
    return new Client(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Wait for a message of a type.
   *
   * Polls the inbox rather than racing a listener, because the message may
   * already have arrived before the wait started. A listener registered too
   * late waits forever for something that is sitting in the queue.
   */
  async next(type: string, timeout = 4000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = this.inbox.findIndex((message) => message['type'] === type);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as Record<string, unknown>;
      if (Date.now() > deadline) {
        throw new Error(
          'waited ' + timeout + 'ms for a ' + type + '; saw ' +
            JSON.stringify(this.inbox.map((message) => message['type'])),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  seen(): string[] {
    return this.inbox.map((message) => String(message['type']));
  }

  close(): void {
    this.socket.close();
  }
}

function url(withToken = token): string {
  return 'ws://127.0.0.1:' + port + '/sync?token=' + encodeURIComponent(withToken);
}

// -------------------------------------------------------------------- HTTP --

test('health reports honestly and costs nothing', async () => {
  // Deliberately dependency-free: a health check that touches the disk reports
  // unhealthy during a slow write, and an orchestrator then restarts a server
  // that was working perfectly.
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body['status'], 'ok');
  assert.equal(typeof body['rooms'], 'number');
});

test('version reports provenance and a fingerprint, never the secret', async () => {
  const body = (await (await fetch(base + '/version')).json()) as Record<string, string>;
  assert.equal(body['version'], 'test');

  const fingerprint = body['sessionSecret'] ?? '';
  assert.ok(fingerprint.length > 0, 'no fingerprint was reported');
  assert.notEqual(fingerprint, SECRET);
  assert.ok(!SECRET.includes(fingerprint), 'the fingerprint was a substring of the secret');
});

test('an unknown route is a 404 rather than a hang', async () => {
  assert.equal((await fetch(base + '/nope')).status, 404);
});

// ------------------------------------------------------------------- auth --

test('a connection without a valid token is refused at the upgrade', async () => {
  await assert.rejects(Client.open('ws://127.0.0.1:' + port + '/sync?token=forged'));
  await assert.rejects(Client.open('ws://127.0.0.1:' + port + '/sync'));
});

test('the wrong path does not upgrade', async () => {
  await assert.rejects(Client.open('ws://127.0.0.1:' + port + '/elsewhere?token=' + token));
});

// -------------------------------------------------------------- the relay --

test('an operation reaches the other editor and not its own sender', async () => {
  const ada = await Client.open(url());
  const bo = await Client.open(url());

  ada.send({ type: 'join', room: 'relay', replica: 'ada', name: 'Ada', since: null });
  await ada.next('joined');
  bo.send({ type: 'join', room: 'relay', replica: 'bo', name: 'Bo', since: null });
  await bo.next('joined');

  ada.send({ type: 'operations', operations: [{ kind: 'insert', value: 'x' }] });

  const received = await bo.next('operations');
  const operations = received['operations'] as { sequence: number; replica: string }[];
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.replica, 'ada');
  assert.equal(operations[0]?.sequence, 1);

  // Echoing to the sender would make a client apply its own operation twice.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(!ada.seen().includes('operations'), 'the sender was echoed to');

  ada.close();
  bo.close();
});

test('a late joiner is handed the backlog it missed', async () => {
  const first = await Client.open(url());
  first.send({ type: 'join', room: 'backlog', replica: 'one', name: 'One', since: null });
  await first.next('joined');
  first.send({ type: 'operations', operations: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const late = await Client.open(url());
  late.send({ type: 'join', room: 'backlog', replica: 'two', name: 'Two', since: 0 });
  const joined = await late.next('joined');

  assert.equal(joined['head'], 3);
  const backlog = joined['backlog'] as { operation: { n: number } }[];
  assert.deepEqual(
    backlog.map((entry) => entry.operation.n),
    [1, 2, 3],
  );

  first.close();
  late.close();
});

test('presence lists everybody and drops somebody who leaves', async () => {
  const ada = await Client.open(url());
  const bo = await Client.open(url());

  ada.send({ type: 'join', room: 'presence', replica: 'ada', name: 'Ada', since: null });
  await ada.next('joined');
  bo.send({ type: 'join', room: 'presence', replica: 'bo', name: 'Bo', since: null });
  await bo.next('joined');

  // Waited for rather than taken from the head of the queue: Ada's own join
  // already produced a one-member broadcast, so grabbing the first `presence`
  // reads a snapshot from before Bo existed. A test that asserts on whichever
  // message happened to be first is a test that passes or fails on timing.
  for (;;) {
    const update = await ada.next('presence');
    if ((update['members'] as unknown[]).length === 2) break;
  }

  bo.send({ type: 'leave' });
  const alone = await ada.next('presence');
  assert.deepEqual(
    (alone['members'] as { replica: string }[]).map((entry) => entry.replica),
    ['ada'],
  );

  ada.close();
  bo.close();
});

test('a caret moves through presence without touching the document', async () => {
  const ada = await Client.open(url());
  const bo = await Client.open(url());
  ada.send({ type: 'join', room: 'caret', replica: 'ada', name: 'Ada', since: null });
  await ada.next('joined');
  bo.send({ type: 'join', room: 'caret', replica: 'bo', name: 'Bo', since: null });
  await bo.next('joined');
  await ada.next('presence');

  bo.send({ type: 'presence', caret: 12 });
  for (;;) {
    const update = await ada.next('presence');
    const bo_ = (update['members'] as { replica: string; caret: number | null }[]).find(
      (entry) => entry.replica === 'bo',
    );
    if (bo_?.caret === 12) break;
  }

  ada.close();
  bo.close();
});

test('operations before joining are refused, and the connection survives', async () => {
  const client = await Client.open(url());
  client.send({ type: 'operations', operations: [{ n: 1 }] });
  const error = await client.next('error');
  assert.equal(error['fatal'], false);

  // Non-fatal means non-fatal: the client can still go on to join.
  client.send({ type: 'join', room: 'recover', replica: 'r', name: 'R', since: null });
  await client.next('joined');
  client.close();
});

test('a malformed message is reported rather than silently dropped', async () => {
  const client = await Client.open(url());
  client.send({ type: 'nonsense' });
  const error = await client.next('error');
  assert.match(String(error['reason']), /unrecognised/);
  client.close();
});

test('resuming from history the log no longer holds is refused, not silently emptied', async () => {
  const client = await Client.open(url());
  client.send({ type: 'join', room: 'gap', replica: 'r', name: 'R', since: 999 });
  const error = await client.next('error');
  assert.equal(error['fatal'], true);
  assert.match(String(error['reason']), /reload/);
  client.close();
});

test('a ping is answered, which is what keeps an idle session alive', async () => {
  const client = await Client.open(url());
  client.send({ type: 'ping' });
  await client.next('pong');
  client.close();
});

// ----------------------------------------------------------- persistence --

test('a room survives on disk and can be listed', async () => {
  const client = await Client.open(url());
  client.send({ type: 'join', room: 'saved', replica: 'r', name: 'R', since: null });
  await client.next('joined');
  client.send({ type: 'operations', operations: [{ n: 1 }] });

  // Written asynchronously, so the wait is for the file rather than for a
  // fixed delay. Asserted through the filesystem rather than by believing the
  // server's own report of its own success.
  const target = path.join(temporary, 'saved.log.json');
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      const raw = JSON.parse(await fs.readFile(target, 'utf8')) as { operations: unknown[] };
      assert.equal(raw.operations.length, 1);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const listed = (await (await fetch(base + '/api/documents')).json()) as { documents: string[] };
  assert.ok(listed.documents.includes('saved'));
  assert.equal(server.failedSaves(), 0);
  client.close();
});

// --------------------------------------------------------------- policy --

test('a published policy reaches a connected client and an older one is refused', async () => {
  const client = await Client.open(url());
  client.send({ type: 'join', room: 'policy', replica: 'r', name: 'R', since: null });
  await client.next('joined');

  const published = await fetch(base + '/api/policy', {
    method: 'PUT',
    body: JSON.stringify({ version: 5, publishedAt: '2026-09-07T00:00:00Z', settings: { lock: true } }),
  });
  assert.equal(published.status, 200);

  const pushed = await client.next('policy');
  assert.equal((pushed['policy'] as { version: number }).version, 5);

  const older = await fetch(base + '/api/policy', {
    method: 'PUT',
    body: JSON.stringify({ version: 4, publishedAt: '2026-09-06T00:00:00Z', settings: {} }),
  });
  assert.equal(older.status, 409, 'an older policy was accepted');

  client.close();
});

test('a policy body beyond the ceiling is refused', async () => {
  const response = await fetch(base + '/api/policy', {
    method: 'PUT',
    body: 'x'.repeat(400 * 1024),
  });
  assert.ok(response.status === 413 || response.status === 400, 'status was ' + response.status);
});

// ------------------------------------------------------------- disconnect --

test('a dropped socket removes its member without a goodbye', async () => {
  // The case that fills a room with ghosts: no close frame, just a socket that
  // stops. Somebody then waits for a reply from a person who left.
  const ada = await Client.open(url());
  const bo = await Client.open(url());
  ada.send({ type: 'join', room: 'ghosts', replica: 'ada', name: 'Ada', since: null });
  await ada.next('joined');
  bo.send({ type: 'join', room: 'ghosts', replica: 'bo', name: 'Bo', since: null });
  await bo.next('joined');
  await ada.next('presence');

  bo.close();

  for (;;) {
    const update = await ada.next('presence');
    const members = update['members'] as { replica: string }[];
    if (members.length === 1 && members[0]?.replica === 'ada') break;
  }
  ada.close();
});
