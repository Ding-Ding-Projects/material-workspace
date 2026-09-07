/**
 * CRDT conformance.
 *
 * The convergence tests are the point, and they are written as PROPERTIES over
 * every permutation rather than as a handful of scenarios somebody thought of.
 * A CRDT that converges on the three orderings a person imagined and diverges
 * on the fourth is not a CRDT — and the divergence appears in production, on
 * somebody's document, under timing nobody can reproduce.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Document,
  type Identity,
  type Operation,
  OutboundQueue,
  PresenceSet,
  compareIdentity,
  shiftCaret,
} from '../../app/sync/crdt';

/** Every ordering of a list. Used to prove commutativity exhaustively. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([items[index] as T, ...tail]);
    }
  }
  return result;
}

// ------------------------------------------------------------------ basics --

test('typing produces the text that was typed', () => {
  const document = new Document('a');
  document.insert(0, 'hello');
  assert.equal(document.text(), 'hello');
});

test('inserting in the middle lands in the middle', () => {
  const document = new Document('a');
  document.insert(0, 'held');
  document.insert(2, 'l');
  assert.equal(document.text(), 'helld');
});

test('deleting removes from the visible text but keeps a tombstone', () => {
  const document = new Document('a');
  document.insert(0, 'hello');
  document.delete(1, 3);
  assert.equal(document.text(), 'ho');
  // The cost of the design, stated rather than hidden: nothing is collected.
  assert.equal(document.size(), 5);
  assert.equal(document.tombstones(), 3);
});

// ------------------------------------------------------------ convergence --

test('two replicas typing at the same position converge, whatever the order', () => {
  // The case a last-writer-wins register throws away one person's work on.
  const alice = new Document('alice');
  const bob = new Document('bob');

  const base = alice.insert(0, 'hi');
  for (const operation of base) bob.apply(operation);

  const fromAlice = alice.insert(2, ' there');
  const fromBob = bob.insert(2, ' friend');

  for (const operation of fromBob) alice.apply(operation);
  for (const operation of fromAlice) bob.apply(operation);

  assert.equal(alice.text(), bob.text());
  // Neither edit was dropped.
  assert.ok(alice.text().includes('there'));
  assert.ok(alice.text().includes('friend'));
});

test('every permutation of a set of operations gives the same text', () => {
  // Written as a property over ALL orderings. A CRDT that converges on the
  // three a person imagined and diverges on the fourth is not a CRDT, and the
  // divergence appears under timing nobody can reproduce.
  const alice = new Document('alice');
  const bob = new Document('bob');
  const cheung = new Document('cheung');

  const operations: Operation[] = [
    ...alice.insert(0, 'AB'),
    ...bob.insert(0, 'CD'),
    ...cheung.insert(0, 'EF'),
  ];

  const answers = new Set<string>();
  for (const ordering of permutations(operations)) {
    const replica = new Document('observer');
    for (const operation of ordering) replica.apply(operation);
    answers.add(replica.text());
  }

  assert.equal(
    answers.size,
    1,
    'orderings produced ' + answers.size + ' different texts: ' + [...answers].join(' | '),
  );
});

test('applying the same operation twice does nothing the second time', () => {
  // What makes a reconnecting client safe to replay its whole queue rather
  // than having to work out what the server already has.
  const document = new Document('a');
  const operations = document.insert(0, 'abc');

  const other = new Document('b');
  for (const operation of operations) other.apply(operation);
  for (const operation of operations) other.apply(operation);

  assert.equal(other.text(), 'abc');
  assert.equal(other.size(), 3);
});

test('a delete that overtakes its insert still deletes', () => {
  // Otherwise a character resurrects permanently, which is the worst kind of
  // divergence: silent, and only on one replica.
  const source = new Document('a');
  const inserts = source.insert(0, 'x');
  const deletes = source.delete(0, 1);

  const other = new Document('b');
  for (const operation of deletes) other.apply(operation);
  for (const operation of inserts) other.apply(operation);

  assert.equal(other.text(), '');
  assert.equal(source.text(), other.text());
});

test('an insert whose anchor has not arrived is held, then placed', () => {
  // An orphan has NO DEFINED POSITION, so it waits rather than being guessed
  // at. The first implementation anchored it to the start of the document,
  // which looked harmless: the character was visible, nothing was lost, and
  // three hand-written convergence tests passed. The exhaustive permutation
  // property above caught it - a provisional placement is never revisited, so
  // a replica that received the anchor first ended up with different text.
  const source = new Document('a');
  const first = source.insert(0, 'a');
  const second = source.insert(1, 'b');

  const other = new Document('b');
  for (const operation of second) other.apply(operation);

  // Held, not shown, and not lost.
  assert.equal(other.text(), '');
  assert.equal(other.held(), 1);

  for (const operation of first) other.apply(operation);

  assert.equal(other.text(), 'ab');
  assert.equal(other.held(), 0);
});

test('a whole chain arriving backwards is held and then unwinds in order', () => {
  // What a reconnecting client actually sends when its queue replays out of
  // order. Each held operation must release the next as it lands, or a long
  // chain unwinds one operation per round trip forever.
  const source = new Document('a');
  const operations = source.insert(0, 'abcdefgh');

  const other = new Document('b');
  for (const operation of [...operations].reverse()) other.apply(operation);

  assert.equal(other.text(), 'abcdefgh');
  assert.equal(other.held(), 0);
});

test('a held operation is not marked seen, so its real arrival still lands', () => {
  // The bug this guards: marking an operation seen while holding it makes the
  // idempotence check swallow it when the anchor arrives and the buffer
  // replays it. The character would be lost silently, on one replica only.
  const source = new Document('a');
  const first = source.insert(0, 'a');
  const second = source.insert(1, 'b');

  const other = new Document('b');
  for (const operation of second) other.apply(operation);
  // Delivered twice while held, as a lossy link would.
  for (const operation of second) other.apply(operation);
  for (const operation of first) other.apply(operation);

  assert.equal(other.text(), 'ab');
  assert.equal(other.size(), 2, 'the held operation landed twice');
});

test('a document can be rebuilt from its history', () => {
  const source = new Document('a');
  source.insert(0, 'hello world');
  source.delete(5, 6);

  const rebuilt = Document.from('b', source.history());
  assert.equal(rebuilt.text(), source.text());
  assert.equal(rebuilt.tombstones(), source.tombstones());
});

test('three replicas editing concurrently converge', () => {
  const replicas = ['a', 'b', 'c'].map((id) => new Document(id));
  const shared: Operation[] = [];

  const broadcast = (operations: Operation[]): void => {
    shared.push(...operations);
  };

  broadcast((replicas[0] as Document).insert(0, 'one '));
  // Everybody catches up before diverging, so they share a base.
  for (const replica of replicas) {
    for (const operation of shared) replica.apply(operation);
  }

  const rounds = [
    (replicas[0] as Document).insert(4, 'two '),
    (replicas[1] as Document).insert(4, 'three '),
    (replicas[2] as Document).insert(0, 'zero '),
  ];

  for (const replica of replicas) {
    for (const round of rounds) {
      for (const operation of round) replica.apply(operation);
    }
  }

  const texts = new Set(replicas.map((replica) => replica.text()));
  assert.equal(texts.size, 1, 'replicas diverged: ' + [...texts].join(' | '));
});

test('the tie-break is total, so no two identities compare equal', () => {
  const a: Identity = { replica: 'a', counter: 1 };
  const b: Identity = { replica: 'b', counter: 1 };
  const c: Identity = { replica: 'a', counter: 2 };

  assert.notEqual(compareIdentity(a, b), 0);
  assert.notEqual(compareIdentity(a, c), 0);
  // And it is antisymmetric, or two replicas would order the same pair
  // differently.
  assert.equal(Math.sign(compareIdentity(a, b)), -Math.sign(compareIdentity(b, a)));
});

// -------------------------------------------------------------- the queue --

test('the queue holds operations in flight until they are acknowledged', () => {
  const queue = new OutboundQueue();
  queue.add([{ kind: 'delete', id: { replica: 'a', counter: 1 } }]);
  assert.equal(queue.size(), 1);

  const batch = queue.take();
  assert.equal(batch.length, 1);
  // Still counted: a send that fails halfway must be retryable without the
  // caller remembering what it sent.
  assert.equal(queue.size(), 1);

  queue.acknowledge();
  assert.equal(queue.size(), 0);
});

test('a failed send returns to the FRONT of the queue', () => {
  // Operations are causally ordered: an insert anchored to a character in the
  // failed batch must not be sent before it.
  const queue = new OutboundQueue();
  const first: Operation = { kind: 'delete', id: { replica: 'a', counter: 1 } };
  const second: Operation = { kind: 'delete', id: { replica: 'a', counter: 2 } };

  queue.add([first]);
  queue.take();
  queue.add([second]);
  queue.retry();

  assert.deepEqual(queue.take(), [first, second]);
});

test('a long offline stretch queues everything', () => {
  const document = new Document('a');
  const queue = new OutboundQueue();
  for (let index = 0; index < 200; index += 1) {
    queue.add(document.insert(document.text().length, 'x'));
  }
  assert.equal(queue.size(), 200);
  assert.equal(document.text().length, 200);
});

// ------------------------------------------------------------- presence --

test('presence expires rather than needing a goodbye', () => {
  // A disconnect is often not observed: a lid closes, a network drops, a
  // process is killed. A list that only removes people who said goodbye fills
  // up with ghosts.
  const people = new PresenceSet(1000);
  people.update({ replica: 'a', name: 'Ada', at: 0 });
  people.update({ replica: 'b', name: 'Bob', at: 900 });

  assert.equal(people.others(950, 'self').length, 2);
  // Ada has gone quiet for longer than the timeout.
  assert.deepEqual(people.others(1500, 'self').map((p) => p.name), ['Bob']);
});

test('sweeping reports who was dropped', () => {
  const people = new PresenceSet(1000);
  people.update({ replica: 'a', name: 'Ada', at: 0 });
  people.update({ replica: 'b', name: 'Bob', at: 2000 });
  assert.deepEqual(people.sweep(2100), ['a']);
});

test('presence never lists you to yourself', () => {
  const people = new PresenceSet(1000);
  people.update({ replica: 'me', name: 'Me', at: 0 });
  assert.deepEqual(people.others(0, 'me'), []);
});

// ---------------------------------------------------------------- caret --

test('a remote insert before the caret moves it, and one at it does not', () => {
  // Without this, somebody typing at the top pushes everybody else's cursor on
  // every keystroke — the failure people describe as "it keeps jumping".
  const visible = (id: Identity): number | undefined =>
    id.counter === 1 ? 0 : id.counter === 9 ? 8 : undefined;

  const before: Operation = {
    kind: 'insert',
    id: { replica: 'other', counter: 2 },
    after: { replica: 'other', counter: 1 },
    value: 'x',
  };
  assert.equal(shiftCaret(5, before, visible), 6);

  const after: Operation = {
    kind: 'insert',
    id: { replica: 'other', counter: 10 },
    after: { replica: 'other', counter: 9 },
    value: 'x',
  };
  assert.equal(shiftCaret(5, after, visible), 5);
});

test('a remote delete before the caret pulls it back', () => {
  const visible = (id: Identity): number | undefined => (id.counter === 1 ? 0 : undefined);
  const operation: Operation = { kind: 'delete', id: { replica: 'other', counter: 1 } };
  assert.equal(shiftCaret(5, operation, visible), 4);
});

test('an operation on a character this replica cannot see leaves the caret alone', () => {
  const operation: Operation = { kind: 'delete', id: { replica: 'other', counter: 99 } };
  assert.equal(shiftCaret(5, operation, () => undefined), 5);
});
