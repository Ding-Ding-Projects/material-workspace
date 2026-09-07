/**
 * Rooms, identity, policy and the wire protocol.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAPPING,
  Sessions,
  principalFromAssertion,
  principalFromScim,
  type Principal,
} from '../../server/src/identity';
import { PolicyStore, accept, isWellFormed } from '../../server/src/policy';
import { MAX_OPERATIONS_PER_MESSAGE, parseClientMessage } from '../../server/src/protocol';
import { DEFAULT_LIMITS, Room, Rooms, isValidRoomId } from '../../server/src/rooms';

function member(connection: string, replica = connection) {
  return { connection, replica, principal: 'p-' + connection, name: replica, seenAt: 0 };
}

// ----------------------------------------------------------------- rooms --

test('an operation is relayed to everybody except its sender', () => {
  const room = new Room('doc', DEFAULT_LIMITS);
  room.add(member('a'));
  room.add(member('b'));
  room.add(member('c'));
  assert.deepEqual(
    room.others('a').map((entry) => entry.connection),
    ['b', 'c'],
  );
});

test('sequences are gapless and start at one', () => {
  const room = new Room('doc', DEFAULT_LIMITS);
  assert.equal(room.head(), 0, 'an untouched room claimed a head');
  const first = room.append('a', { kind: 'insert' });
  const second = room.append('b', { kind: 'insert' });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(room.head(), 2);
});

test('catching up returns everything after a sequence', () => {
  const room = new Room('doc', DEFAULT_LIMITS);
  for (const value of ['a', 'b', 'c', 'd']) room.append('r', value);
  assert.deepEqual(
    (room.since(2) ?? []).map((entry) => entry.operation),
    ['c', 'd'],
  );
});

test('already up to date is an empty array, and too far back is null', () => {
  // THE DISTINCTION IS THE WHOLE POINT. Collapsing the two is how a client
  // silently misses edits: it asks for everything since 5, is handed nothing
  // because 5 was evicted, and concludes it is current while the document has
  // moved on without it.
  const room = new Room('doc', { ...DEFAULT_LIMITS, maxLog: 3 });
  for (const value of ['a', 'b', 'c']) room.append('r', value);

  assert.deepEqual(room.since(3), [], 'up to date should be an empty array');

  room.append('r', 'd');
  room.append('r', 'e');
  assert.equal(room.earliest(), 3, 'the log did not evict as expected');
  assert.equal(room.since(1), null, 'a request reaching past the log was not refused');
  assert.deepEqual(
    (room.since(3) ?? []).map((entry) => entry.operation),
    ['d', 'e'],
  );
});

test('the log is bounded, so a long session cannot grow without limit', () => {
  const room = new Room('doc', { ...DEFAULT_LIMITS, maxLog: 10 });
  for (let index = 0; index < 100; index += 1) room.append('r', index);
  assert.equal((room.since(90) ?? []).length, 10);
  assert.equal(room.head(), 100, 'eviction moved the head');
});

test('presence expires rather than needing a goodbye', () => {
  // A disconnect is frequently not observed: a lid closes, a network drops.
  const room = new Room('doc', { ...DEFAULT_LIMITS, presenceTimeout: 1000 });
  room.add({ ...member('a'), seenAt: 0 });
  room.add({ ...member('b'), seenAt: 900 });
  assert.deepEqual(
    room.sweep(1500).map((entry) => entry.connection),
    ['a'],
  );
  assert.equal(room.size(), 1);
});

test('a room refuses more people than it can carry', () => {
  const rooms = new Rooms({ ...DEFAULT_LIMITS, maxMembers: 2 });
  assert.equal(rooms.join('doc', member('a'), null).ok, true);
  assert.equal(rooms.join('doc', member('b'), null).ok, true);
  const third = rooms.join('doc', member('c'), null);
  assert.equal(third.ok, false);
});

test('a refused join does not leak an empty room', () => {
  const rooms = new Rooms({ ...DEFAULT_LIMITS, maxMembers: 0 });
  rooms.join('doc', member('a'), null);
  assert.equal(rooms.count(), 0, 'an empty room was left behind');
});

test('an empty room is forgotten so memory does not creep', () => {
  const rooms = new Rooms();
  rooms.join('doc', member('a'), null);
  assert.equal(rooms.count(), 1);
  rooms.leave('doc', 'a');
  assert.equal(rooms.count(), 0);
});

test('a room id that could escape a directory is refused', () => {
  // These are used as storage keys, so they are validated rather than trusted.
  assert.equal(isValidRoomId('quarterly-report'), true);
  assert.equal(isValidRoomId('a.b_c-1'), true);
  for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '/absolute', '', '.hidden', 'a..b']) {
    assert.equal(isValidRoomId(bad), false, 'accepted ' + JSON.stringify(bad));
  }
  assert.equal(isValidRoomId('x'.repeat(200)), false);
});

// -------------------------------------------------------------- sessions --

const SECRET = 'a-secret-long-enough-to-be-taken-seriously';
const PERSON: Principal = {
  subject: 'u-1',
  displayName: 'Ada',
  email: 'ada@example.invalid',
  groups: ['editors'],
};

test('a token this server minted verifies, and a tampered one does not', () => {
  const sessions = new Sessions(SECRET);
  const token = sessions.issue(PERSON, 1000, 60_000);

  const good = sessions.verify(token, 2000);
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.token.principal.subject, 'u-1');

  // One character changed in the body, signature left alone.
  const dot = token.lastIndexOf('.');
  const tampered = 'X' + token.slice(1, dot) + token.slice(dot);
  assert.equal(sessions.verify(tampered, 2000).ok, false);
});

test('a token signed with a different secret is refused', () => {
  const mine = new Sessions(SECRET);
  const theirs = new Sessions('a-completely-different-secret-of-length');
  assert.equal(mine.verify(theirs.issue(PERSON, 0, 60_000), 1000).ok, false);
});

test('an expired token is refused', () => {
  const sessions = new Sessions(SECRET);
  const token = sessions.issue(PERSON, 0, 1000);
  assert.equal(sessions.verify(token, 999).ok, true);
  assert.equal(sessions.verify(token, 1001).ok, false);
});

test('a short session secret is refused rather than padded', () => {
  // A short secret silently accepted is a deployment that believes it is
  // protected and is not.
  assert.throws(() => new Sessions('too short'));
});

test('the secret fingerprint is stable and reveals nothing', () => {
  const one = new Sessions(SECRET);
  const two = new Sessions(SECRET);
  const other = new Sessions('a-completely-different-secret-of-length');

  assert.equal(one.describeSecret(), two.describeSecret(), 'two nodes disagreed');
  assert.notEqual(one.describeSecret(), other.describeSecret());
  assert.ok(!one.describeSecret().includes('secret'));
  assert.ok(!SECRET.includes(one.describeSecret()));
});

// -------------------------------------------------------------- identity --

test('an assertion is mapped onto a principal', () => {
  const result = principalFromAssertion({
    [DEFAULT_MAPPING.subject]: ['u-42'],
    [DEFAULT_MAPPING.displayName]: ['Cheung Siu Ming'],
    [DEFAULT_MAPPING.email]: ['cheung@example.invalid'],
    [DEFAULT_MAPPING.groups]: ['editors', 'finance'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.principal.subject, 'u-42');
  assert.deepEqual(result.ok && result.principal.groups, ['editors', 'finance']);
});

test('an assertion with no stable subject is refused, not fallen back to email', () => {
  // An email is reassignable, so a leaver's address given to a new starter
  // would hand them the leaver's documents.
  const result = principalFromAssertion({
    [DEFAULT_MAPPING.email]: ['someone@example.invalid'],
  });
  assert.equal(result.ok, false);
});

test('a deprovisioned SCIM user is refused at the mapping', () => {
  // Offboarding is the single thing a directory integration exists for. A
  // pipeline where active:false is merely a field somebody might check later
  // is a pipeline that keeps a leaver's access.
  const refused = principalFromScim({ id: 'u-9', userName: 'gone', active: false });
  assert.equal(refused.ok, false);

  const kept = principalFromScim({
    id: 'u-9',
    userName: 'here',
    active: true,
    emails: [
      { value: 'secondary@example.invalid' },
      { value: 'primary@example.invalid', primary: true },
    ],
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.ok && kept.principal.email, 'primary@example.invalid');
});

// ---------------------------------------------------------------- policy --

const POLICY = { version: 2, publishedAt: '2026-09-07T00:00:00Z', settings: { locked: true } };

test('a newer policy is applied and an older one is ignored', () => {
  // A stale reply arriving late would otherwise quietly re-enable something an
  // administrator had just turned off, with nothing reporting it.
  assert.equal(accept(null, POLICY).applied, true);
  assert.equal(accept(POLICY, { ...POLICY, version: 3 }).applied, true);

  const backwards = accept(POLICY, { ...POLICY, version: 1 });
  assert.equal(backwards.applied, false);
  assert.match(backwards.applied === false ? backwards.reason : '', /older/);
});

test('the same version with different content is refused, not silently obeyed', () => {
  const same = accept(POLICY, { ...POLICY, settings: { locked: false } });
  assert.equal(same.applied, false);
});

test('a malformed policy is refused rather than partly applied', () => {
  assert.equal(isWellFormed({ version: 0, publishedAt: 'x', settings: {} }), false);
  assert.equal(isWellFormed({ version: 1.5, publishedAt: 'x', settings: {} }), false);
  assert.equal(isWellFormed({ version: 1, publishedAt: '', settings: {} }), false);
  assert.equal(isWellFormed({ version: 1, publishedAt: 'x', settings: { bad: { a: 1 } } }), false);
  assert.equal(isWellFormed({ version: 1, publishedAt: 'x', settings: { ok: ['a'] } }), true);
});

test('refusals are recorded and bounded', () => {
  const store = new PolicyStore();
  store.publish(POLICY, 0);
  for (let index = 0; index < 150; index += 1) store.publish({ ...POLICY, version: 1 }, index);
  assert.equal(store.get()?.version, 2, 'the policy in force changed');
  assert.equal(store.rejected().length, 100, 'the refusal log is unbounded');
});

// -------------------------------------------------------------- protocol --

test('a join is parsed, and one missing a field is refused', () => {
  const good = parseClientMessage(
    JSON.stringify({ type: 'join', room: 'doc', replica: 'r1', name: 'Ada', since: null }),
  );
  assert.equal(good.ok, true);

  for (const bad of [
    { type: 'join', replica: 'r1', name: 'Ada', since: null },
    { type: 'join', room: 'doc', name: 'Ada', since: null },
    { type: 'join', room: 'doc', replica: 'r1', name: 'Ada', since: -1 },
    { type: 'join', room: 'doc', replica: 'r1', name: 'Ada', since: 1.5 },
  ]) {
    assert.equal(parseClientMessage(JSON.stringify(bad)).ok, false, JSON.stringify(bad));
  }
});

test('an oversized operation batch is refused', () => {
  // The frame ceiling does not cover this: a great many tiny operations fit
  // comfortably inside it while still making the server relay unboundedly.
  const operations = Array.from({ length: MAX_OPERATIONS_PER_MESSAGE + 1 }, () => ({ k: 1 }));
  assert.equal(parseClientMessage(JSON.stringify({ type: 'operations', operations })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'operations', operations: [] })).ok, false);
});

test('anything unrecognised is refused rather than ignored', () => {
  // A silently dropped message is the worst of the three options: the sender
  // believes it arrived and nothing records the disagreement.
  for (const bad of ['not json', '[]', '"a string"', '{"type":"whatever"}', 'null']) {
    assert.equal(parseClientMessage(bad).ok, false, bad);
  }
});
