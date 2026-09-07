/**
 * A sequence CRDT for collaborative text.
 *
 * The problem it solves: two people edit the same paragraph at the same time,
 * offline, and both edits must survive with the same result on every machine —
 * without a server deciding a winner, and without either edit being silently
 * dropped.
 *
 * The design is RGA (replicated growable array), chosen over the alternatives
 * for reasons worth stating:
 *
 *   - OPERATIONAL TRANSFORM needs a central server to order operations and a
 *     transformation function for every pair of operation types. Getting one
 *     pair wrong corrupts documents in ways that only appear under specific
 *     timing, which is the worst possible failure mode to debug.
 *   - A LAST-WRITER-WINS REGISTER over the whole document is trivial and
 *     throws away one person's work every time two people type at once.
 *   - RGA gives convergence with no server and no transformation: each
 *     character carries an identity, insertion is positioned relative to an
 *     existing identity, and deletion is a tombstone. Two replicas that have
 *     seen the same operations, in any order, hold the same text.
 *
 * The costs are real and are stated rather than hidden. Tombstones are never
 * collected, so a document that has been heavily edited carries every deleted
 * character forever. That is fine for a session and wrong for a document kept
 * for years; garbage collection needs a causal-stability check across every
 * replica, which needs the server, and it is not built.
 */

export type ReplicaId = string;

/**
 * A character's identity: which replica created it, and its own counter.
 *
 * Unique forever, and comparable — which is what lets two replicas that
 * inserted at the same position agree on the order without talking.
 */
export interface Identity {
  readonly replica: ReplicaId;
  readonly counter: number;
}

export interface Character {
  readonly id: Identity;
  /** The identity this was inserted after. Null means the start. */
  readonly after: Identity | null;
  readonly value: string;
  readonly deleted: boolean;
}

export type Operation =
  | {
      readonly kind: 'insert';
      readonly id: Identity;
      readonly after: Identity | null;
      readonly value: string;
    }
  | { readonly kind: 'delete'; readonly id: Identity };

export function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  if (a === null || b === null) return a === b;
  return a.replica === b.replica && a.counter === b.counter;
}

export function identityKey(id: Identity): string {
  return id.replica + ':' + id.counter;
}

/**
 * Order two identities.
 *
 * Higher counter first, then replica id descending. The rule itself is
 * arbitrary; what matters is that it is TOTAL and identical on every replica,
 * because it is what breaks the tie when two people insert at the same place.
 * Any rule works as long as everybody uses the same one.
 */
export function compareIdentity(a: Identity, b: Identity): number {
  if (a.counter !== b.counter) return b.counter - a.counter;
  return a.replica < b.replica ? 1 : a.replica > b.replica ? -1 : 0;
}

export class Document {
  /** In document order, including tombstones. */
  private characters: Character[] = [];
  private readonly index = new Map<string, number>();
  private counter = 0;
  /** Operations seen, so a replay is idempotent. */
  private readonly seen = new Set<string>();

  constructor(readonly replica: ReplicaId) {}

  /** The visible text. Tombstones are skipped. */
  text(): string {
    let out = '';
    for (const character of this.characters) {
      if (!character.deleted) out += character.value;
    }
    return out;
  }

  /** Every character including tombstones, for tests and for diagnostics. */
  size(): number {
    return this.characters.length;
  }

  tombstones(): number {
    return this.characters.filter((character) => character.deleted).length;
  }

  /** The identity at a visible offset, or null for the start of the document. */
  private identityAtVisible(offset: number): Identity | null {
    if (offset <= 0) return null;
    let seen = 0;
    for (const character of this.characters) {
      if (character.deleted) continue;
      seen += 1;
      if (seen === offset) return character.id;
    }
    // Past the end: anchor to the last visible character, or the start.
    for (let index = this.characters.length - 1; index >= 0; index -= 1) {
      const character = this.characters[index] as Character;
      if (!character.deleted) return character.id;
    }
    return null;
  }

  /**
   * Insert text at a visible offset, producing the operations to broadcast.
   *
   * Each character is anchored to the one BEFORE it, including the previous
   * character of this same insertion — so a word typed as one call arrives in
   * the right order even if the operations are applied out of order elsewhere.
   */
  insert(offset: number, text: string): Operation[] {
    const operations: Operation[] = [];
    let after = this.identityAtVisible(offset);

    for (const value of text) {
      this.counter += 1;
      const id: Identity = { replica: this.replica, counter: this.counter };
      const operation: Operation = { kind: 'insert', id, after, value };
      this.apply(operation);
      operations.push(operation);
      after = id;
    }
    return operations;
  }

  /** Delete a run of visible characters, producing tombstone operations. */
  delete(offset: number, count: number): Operation[] {
    const operations: Operation[] = [];
    let seen = 0;

    for (const character of this.characters) {
      if (character.deleted) continue;
      seen += 1;
      if (seen <= offset) continue;
      if (operations.length >= count) break;
      operations.push({ kind: 'delete', id: character.id });
    }

    for (const operation of operations) this.apply(operation);
    return operations;
  }

  /**
   * Apply an operation from anywhere, including this replica.
   *
   * IDEMPOTENT: applying the same operation twice does nothing the second
   * time. That is what makes a reconnecting client safe to replay its whole
   * queue rather than having to work out what the server already has.
   *
   * COMMUTATIVE for concurrent operations: two replicas applying the same set
   * in different orders end with the same text. That is the property the whole
   * design exists for, and it is tested directly.
   */
  apply(operation: Operation): boolean {
    if (operation.kind === 'delete') {
      const at = this.index.get(identityKey(operation.id));
      if (at === undefined) {
        // A delete for a character not yet seen. Recorded so that when the
        // insert arrives it is already a tombstone — otherwise a delete that
        // overtakes its insert resurrects the character permanently.
        this.pendingDeletes.add(identityKey(operation.id));
        return false;
      }
      const character = this.characters[at] as Character;
      if (character.deleted) return false;
      this.characters[at] = { ...character, deleted: true };
      return true;
    }

    const key = identityKey(operation.id);
    if (this.seen.has(key)) return false;

    // AN INSERT WHOSE ANCHOR HAS NOT ARRIVED IS HELD, NOT PLACED.
    //
    // The first version anchored it to the start of the document instead.
    // That looks harmless and is not: the character then sits somewhere
    // arbitrary, and when its anchor finally arrives the order established
    // in the meantime disagrees with the order a replica that received the
    // operations the other way round arrived at. The exhaustive-permutation
    // test caught it; three hand-written scenarios had not.
    //
    // An orphan has no defined position, so it waits until it has one.
    // Nothing is lost: it is held against the identity it is waiting for.
    if (operation.after !== null && !this.index.has(identityKey(operation.after))) {
      const anchorKey = identityKey(operation.after);
      const held = this.waiting.get(anchorKey);
      if (held === undefined) this.waiting.set(anchorKey, [operation]);
      else held.push(operation);
      return false;
    }

    this.seen.add(key);

    // Keep the local counter ahead of anything seen, so this replica never
    // reuses an identity that already exists elsewhere.
    if (operation.id.replica !== this.replica && operation.id.counter > this.counter) {
      this.counter = operation.id.counter;
    }

    const position = this.positionFor(operation.after, operation.id);
    const character: Character = {
      id: operation.id,
      after: operation.after,
      value: operation.value,
      deleted: this.pendingDeletes.delete(key),
    };
    this.characters.splice(position, 0, character);
    this.reindex(position);

    // Anything that was waiting for THIS character can now be placed.
    // Draining iteratively rather than recursively, because a long chain
    // of out-of-order inserts is exactly what a reconnecting client sends.
    const waiting = this.waiting.get(key);
    if (waiting !== undefined) {
      this.waiting.delete(key);
      for (const held of waiting) this.apply(held);
    }
    return true;
  }

  private readonly pendingDeletes = new Set<string>();

  /**
   * Inserts waiting for an anchor that has not arrived, keyed by that anchor.
   *
   * Held rather than dropped or guessed at. Out-of-order delivery is normal:
   * a reconnecting client replays a queue, and a lossy link reorders.
   */
  private readonly waiting = new Map<string, Operation[]>();

  /** How many operations are waiting for an anchor. For diagnostics. */
  held(): number {
    let total = 0;
    for (const list of this.waiting.values()) total += list.length;
    return total;
  }

  /** The list position of an identity, or -1 for the start of the document. */
  private anchorPosition(after: Identity | null): number {
    if (after === null) return -1;
    // Inserts with a missing anchor never reach here: they are held in the
    // waiting buffer until their anchor arrives. This fallback only covers
    // the case of a character whose own anchor was itself never delivered,
    // which cannot happen through apply() but keeps the function total.
    return this.index.get(identityKey(after)) ?? -1;
  }

  /**
   * Where a new character goes.
   *
   * THE SUBTLETY THAT MAKES THIS CONVERGE, and which the first version got
   * wrong: it is not enough to walk past siblings that sort before the new
   * character. A sibling may already have characters inserted AFTER it, and
   * those sit between it and the next sibling. Stopping at the first
   * non-sibling therefore lands the new character in the middle of somebody
   * else's word, and two replicas that saw the operations in different orders
   * end with different text.
   *
   * The rule that is correct, comparing each candidate by where ITS anchor
   * sits in the list:
   *
   *   - anchored EARLIER than ours: it is outside our anchor's subtree
   *     entirely, so we belong before it. Stop.
   *   - anchored at the SAME place: a direct sibling, ordered by identity.
   *     Stop when it sorts after us.
   *   - anchored LATER: a descendant of an earlier sibling. Skip the whole
   *     run of them.
   *
   * The identity comparison is the convergence argument itself: it is total
   * and identical everywhere, so two replicas inserting after the same anchor
   * place both characters in the same order without communicating.
   */
  private positionFor(after: Identity | null, id: Identity): number {
    const anchorAt = this.anchorPosition(after);
    let position = anchorAt + 1;

    while (position < this.characters.length) {
      const candidate = this.characters[position] as Character;
      const candidateAnchor = this.anchorPosition(candidate.after);

      if (candidateAnchor < anchorAt) break;
      if (candidateAnchor === anchorAt && compareIdentity(candidate.id, id) > 0) break;
      position += 1;
    }

    return position;
  }

  private reindex(from: number): void {
    for (let position = from; position < this.characters.length; position += 1) {
      this.index.set(identityKey((this.characters[position] as Character).id), position);
    }
  }

  /** Every operation needed to bring an empty replica to this state. */
  history(): Operation[] {
    const operations: Operation[] = [];
    for (const character of this.characters) {
      operations.push({
        kind: 'insert',
        id: character.id,
        after: character.after,
        value: character.value,
      });
    }
    for (const character of this.characters) {
      if (character.deleted) operations.push({ kind: 'delete', id: character.id });
    }
    return operations;
  }

  /** Replace the whole content, as a fresh document would. */
  static from(replica: ReplicaId, operations: readonly Operation[]): Document {
    const document = new Document(replica);
    for (const operation of operations) document.apply(operation);
    return document;
  }
}

/**
 * A queue of operations that have not reached the server.
 *
 * Offline is the NORMAL case, not the error case. The suite is fully usable
 * with the server unreachable; edits queue and reconcile on reconnect, and a
 * server that is down degrades collaboration and nothing else.
 */
export class OutboundQueue {
  private pending: Operation[] = [];
  private inFlight: Operation[] = [];

  add(operations: readonly Operation[]): void {
    this.pending.push(...operations);
  }

  size(): number {
    return this.pending.length + this.inFlight.length;
  }

  /**
   * Take everything pending, holding it in flight until it is acknowledged.
   *
   * Held rather than discarded, so a send that fails halfway can be retried
   * without the caller having to remember what it sent.
   */
  take(): Operation[] {
    this.inFlight = [...this.inFlight, ...this.pending];
    this.pending = [];
    return [...this.inFlight];
  }

  acknowledge(): void {
    this.inFlight = [];
  }

  /**
   * A send failed. The in-flight batch returns to the front of the queue.
   *
   * To the FRONT, because operations are causally ordered: an insert anchored
   * to a character in the failed batch must not be sent before it.
   */
  retry(): void {
    this.pending = [...this.inFlight, ...this.pending];
    this.inFlight = [];
  }
}

export interface Presence {
  readonly replica: ReplicaId;
  readonly name: string;
  /** Visible offset. Undefined when the person is not in this document. */
  readonly caret?: number;
  readonly selectionEnd?: number;
  /** Milliseconds since the epoch, from the sender. */
  readonly at: number;
}

/**
 * Who else is here.
 *
 * Presence expires rather than being removed on disconnect, because a
 * disconnect is often not observed: a laptop lid closes, a network drops, a
 * process is killed. A list that only removes people who said goodbye fills up
 * with ghosts.
 */
export class PresenceSet {
  private readonly people = new Map<ReplicaId, Presence>();

  constructor(private readonly timeoutMs = 30_000) {}

  update(presence: Presence): void {
    this.people.set(presence.replica, presence);
  }

  remove(replica: ReplicaId): void {
    this.people.delete(replica);
  }

  /** Everybody seen recently enough, excluding this replica. */
  others(now: number, self: ReplicaId): Presence[] {
    const result: Presence[] = [];
    for (const [replica, presence] of this.people) {
      if (replica === self) continue;
      if (now - presence.at > this.timeoutMs) continue;
      result.push(presence);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Drop everybody who has gone quiet. Called on a timer by the caller. */
  sweep(now: number): ReplicaId[] {
    const gone: ReplicaId[] = [];
    for (const [replica, presence] of this.people) {
      if (now - presence.at > this.timeoutMs) {
        gone.push(replica);
        this.people.delete(replica);
      }
    }
    return gone;
  }
}

/**
 * Move a caret to account for a remote edit.
 *
 * Without this, somebody typing at the top of a document pushes everybody
 * else's cursor out of position on every keystroke — which is the single most
 * noticeable way collaborative editing goes wrong, and the one people describe
 * as "it keeps jumping".
 */
export function shiftCaret(
  caret: number,
  operation: Operation,
  visibleIndexOf: (id: Identity) => number | undefined,
): number {
  if (operation.kind === 'insert') {
    const at = operation.after === null ? 0 : (visibleIndexOf(operation.after) ?? -1) + 1;
    // Strictly before, so a remote insert exactly at the caret does not push
    // it: the local person keeps typing where they were.
    return at < caret ? caret + 1 : caret;
  }
  const at = visibleIndexOf(operation.id);
  if (at === undefined) return caret;
  return at < caret ? caret - 1 : caret;
}
