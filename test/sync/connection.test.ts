/**
 * The connection, with the socket faked.
 *
 * Faked deliberately, and the reason is worth stating because the opposite
 * choice is the usual one: the interesting behaviour here is what happens when
 * the socket is NOT there. A test that stands a real server up can prove the
 * happy path and can barely reach the drop, the retry, the queue surviving the
 * gap, or the backoff arithmetic — which is precisely the code that decides
 * whether "offline is the normal case" is true or merely written down.
 *
 * The live half is covered separately, against the real server over a real
 * socket, in test/server/live.test.ts.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Connection, backoffFor, type Socket } from '../../app/sync/connection';

/** A socket whose every event is fired by hand. */
class FakeSocket implements Socket {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Set to make send() throw, as a socket dying mid-write does. */
  broken = false;

  send(data: string): void {
    if (this.broken) throw new Error('the socket is gone');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  messages(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.messages().filter((message) => message['type'] === type);
  }

  deliver(message: unknown): void {
    this.onmessage?.(JSON.stringify(message));
  }
}

/** A harness with time under the test's control rather than the clock's. */
function harness(overrides: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number }[] = [];

  const connection = new Connection(
    {
      room: 'doc',
      replica: 'me',
      name: 'Me',
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimer: (run, ms) => {
        timers.push({ run, ms });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
      ...overrides,
    },
    {
      onState: (state, detail) => states.push(state + ':' + detail),
      onPeers: (list) => {
        peers = [...list];
      },
      onRefusal: (reason, fatal) => refusals.push({ reason, fatal }),
      onRemote: (operations) => remote.push(...operations),
    },
  );

  const states: string[] = [];
  const refusals: { reason: string; fatal: boolean }[] = [];
  const remote: unknown[] = [];
  let peers: { replica: string; name: string }[] = [];

  const latest = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket;
  const join = (head = 0, backlog: unknown[] = [], members: unknown[] = []): void => {
    latest().onopen?.();
    latest().deliver({ type: 'joined', room: 'doc', head, backlog, members });
  };

  return {
    connection,
    sockets,
    timers,
    states,
    refusals,
    remote,
    latest,
    join,
    peersNow: () => peers,
  };
}

// -------------------------------------------------------------- backoff --

test('backoff doubles, is capped, and is jittered', () => {
  // Capped, because unbounded doubling means a laptop that closed its lid for
  // an afternoon wakes and waits four more hours before trying.
  assert.equal(backoffFor(1, 30_000, 1), 1000);
  assert.equal(backoffFor(2, 30_000, 1), 2000);
  assert.equal(backoffFor(3, 30_000, 1), 4000);
  assert.equal(backoffFor(10, 30_000, 1), 30_000, 'the cap was not applied');
  assert.equal(backoffFor(99, 30_000, 1), 30_000);

  // Full jitter. Without it, every client disconnected by one server restart
  // comes back at the same instant and knocks it over again.
  assert.equal(backoffFor(3, 30_000, 0), 0);
  assert.equal(backoffFor(3, 30_000, 0.5), 2000);
});

// --------------------------------------------------------------- offline --

test('typing works with no connection at all, and queues', () => {
  // The whole offline story: the document is the truth and the socket is an
  // optimisation for sharing it.
  const { connection } = harness();
  connection.insert(0, 'offline work');

  assert.equal(connection.document.text(), 'offline work');
  assert.equal(connection.queued(), 12);
  assert.equal(connection.currentState(), 'offline');
});

test('everything typed while offline goes out on connecting, in order', () => {
  const rig = harness();
  rig.connection.insert(0, 'abc');
  rig.connection.connect();
  rig.join();

  const batches = rig.latest().ofType('operations');
  assert.equal(batches.length, 1, 'the queue was not flushed on join');
  const operations = batches[0]?.['operations'] as { value: string }[];
  assert.deepEqual(
    operations.map((operation) => operation.value),
    ['a', 'b', 'c'],
  );
  assert.equal(rig.connection.queued(), 0);
});

test('a drop returns the in-flight batch to the queue rather than losing it', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join();

  rig.latest().broken = true;
  rig.connection.insert(0, 'xy');
  // The write failed, so nothing may be considered sent.
  assert.equal(rig.connection.queued(), 2, 'a failed write was treated as sent');

  rig.latest().onclose?.();
  assert.equal(rig.connection.queued(), 2, 'the queue was lost on the drop');
  assert.equal(rig.connection.document.text(), 'xy', 'the local document lost work');
});

test('a reconnect resumes from the last sequence seen rather than reloading', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join(7);

  rig.latest().onclose?.();
  assert.equal(rig.timers.length, 1, 'no reconnect was scheduled');
  (rig.timers[0] as { run: () => void }).run();
  rig.latest().onopen?.();

  const join = rig.latest().ofType('join')[0];
  assert.equal(join?.['since'], 7, 'the reconnect asked to reload instead of resuming');
});

test('the first connection asks for a fresh join, not a resume from zero', () => {
  // `since: 0` and `since: null` mean different things to the server, and
  // sending 0 for a brand-new document asks it to prove a history that is
  // correctly empty.
  const rig = harness();
  rig.connection.connect();
  rig.latest().onopen?.();
  assert.equal(rig.latest().ofType('join')[0]?.['since'], null);
});

test('backoff grows across repeated failures and resets on a success', () => {
  const rig = harness({ maxBackoff: 30_000 });
  rig.connection.connect();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    rig.latest().onclose?.();
    const timer = rig.timers[rig.timers.length - 1] as { run: () => void; ms: number };
    assert.ok(timer.ms <= 1000 * 2 ** (attempt - 1), 'attempt ' + attempt + ' exceeded its cap');
    timer.run();
  }

  rig.join();
  assert.equal(rig.connection.currentState(), 'live');

  // Reset: the next drop must start from one second again, not from eight.
  rig.latest().onclose?.();
  const after = rig.timers[rig.timers.length - 1] as { ms: number };
  assert.ok(after.ms <= 1000, 'the attempt counter did not reset after a success');
});

test('an error event does not double-count the attempt', () => {
  // A socket that errors also closes. Tearing down twice halves the backoff.
  const rig = harness();
  rig.connection.connect();
  rig.latest().onerror?.();
  assert.equal(rig.timers.length, 0, 'onerror scheduled its own reconnect');
});

test('a transport that throws on construction retries rather than crashing', () => {
  const timers: { run: () => void }[] = [];
  const connection = new Connection({
    room: 'doc',
    replica: 'me',
    name: 'Me',
    open: () => {
      throw new Error('no network');
    },
    setTimer: (run) => {
      timers.push({ run });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  connection.connect();
  assert.equal(connection.currentState(), 'reconnecting');
  assert.equal(timers.length, 1);
});

// ----------------------------------------------------------------- remote --

test('a backlog is applied to the document on joining', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join(2, [
    {
      sequence: 1,
      operation: { kind: 'insert', id: { replica: 'a', counter: 1 }, after: null, value: 'H' },
    },
    {
      sequence: 2,
      operation: {
        kind: 'insert',
        id: { replica: 'a', counter: 2 },
        after: { replica: 'a', counter: 1 },
        value: 'i',
      },
    },
  ]);
  assert.equal(rig.connection.document.text(), 'Hi');
});

test('a replayed operation is applied once', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join();

  const entry = {
    sequence: 1,
    operation: { kind: 'insert', id: { replica: 'a', counter: 1 }, after: null, value: 'x' },
  };
  rig.latest().deliver({ type: 'operations', operations: [entry] });
  rig.latest().deliver({ type: 'operations', operations: [entry] });

  assert.equal(rig.connection.document.text(), 'x');
  assert.equal(rig.remote.length, 1, 'the duplicate was reported as a change');
});

test('presence excludes yourself', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join();
  rig.latest().deliver({
    type: 'presence',
    members: [
      { replica: 'me', name: 'Me', caret: 1 },
      { replica: 'you', name: 'You', caret: 4 },
    ],
  });
  assert.deepEqual(
    rig.peersNow().map((peer) => peer.replica),
    ['you'],
  );
});

test('a caret is only reported when there is somewhere to report it', () => {
  const rig = harness();
  rig.connection.reportCaret(3);
  rig.connection.connect();
  // Not yet live: still joining.
  rig.latest().onopen?.();
  rig.connection.reportCaret(3);
  assert.equal(rig.latest().ofType('presence').length, 0);

  rig.latest().deliver({ type: 'joined', room: 'doc', head: 0, backlog: [], members: [] });
  rig.connection.reportCaret(3);
  assert.equal(rig.latest().ofType('presence').length, 1);
});

// -------------------------------------------------------------- refusals --

test('a non-fatal refusal is reported and the session continues', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join();
  rig.latest().deliver({ type: 'error', reason: 'join a document first', fatal: false });

  assert.equal(rig.refusals.length, 1);
  assert.equal(rig.connection.currentState(), 'live', 'a non-fatal refusal ended the session');
});

test('a fatal refusal stops retrying instead of asking forever', () => {
  // Usually "your history is unusable, reload". Reconnecting would ask the
  // same impossible question every few seconds for as long as the app is open.
  const rig = harness();
  rig.connection.connect();
  rig.latest().onopen?.();
  rig.latest().deliver({ type: 'error', reason: 'reload the document', fatal: true });

  assert.equal(rig.connection.currentState(), 'refused');
  rig.latest().onclose?.();
  assert.equal(rig.timers.length, 0, 'it kept retrying after a fatal refusal');
});

test('unreadable data from the server does not end the session', () => {
  // A server defect must not cost somebody their editor: the local document is
  // unaffected and still fully editable.
  const rig = harness();
  rig.connection.connect();
  rig.join();
  rig.latest().onmessage?.('not json at all');

  assert.equal(rig.refusals.length, 1);
  assert.equal(rig.connection.currentState(), 'live');
});

test('disconnecting says goodbye, stops, and stays stopped', () => {
  const rig = harness();
  rig.connection.connect();
  rig.join();
  rig.connection.disconnect();

  assert.equal(rig.latest().ofType('leave').length, 1, 'no goodbye was sent');
  assert.equal(rig.latest().closed, true);
  assert.equal(rig.connection.currentState(), 'offline');
  assert.deepEqual(rig.peersNow(), []);

  rig.connection.connect();
  assert.equal(rig.sockets.length, 1, 'it reconnected after being told to stop');
});
