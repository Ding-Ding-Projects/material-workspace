/**
 * Rooms: who is in a document, what has happened to it, and who to tell next.
 *
 * The server deliberately does NOT understand the documents it relays. It
 * holds an ordered log of opaque operations and hands each one to everybody
 * else in the room. Convergence is the CRDT's job, on the client, and pulling
 * that logic up here would mean every client had to trust the server's version
 * of the merge — which is exactly the coupling a CRDT exists to remove.
 *
 * What follows from that, and is worth stating because it reads as a gap:
 * the server cannot show a document's text, cannot search it, and cannot
 * validate an edit. It is a fan-out with a memory.
 */

export interface Member {
  readonly connection: string;
  readonly replica: string;
  readonly principal: string;
  readonly name: string;
  /** Millisecond clock reading of the last thing heard from them. */
  seenAt: number;
}

export interface LoggedOperation {
  /** Position in the room's log. Monotonic, gapless, starts at 1. */
  readonly sequence: number;
  readonly replica: string;
  /** Opaque to the server. A CRDT operation as the client encoded it. */
  readonly operation: unknown;
}

export interface RoomLimits {
  /** Refuse a room beyond this many people. */
  readonly maxMembers: number;
  /** How many operations a room remembers for catching a late joiner up. */
  readonly maxLog: number;
  /** How long a member may be silent before presence drops them. */
  readonly presenceTimeout: number;
}

export const DEFAULT_LIMITS: RoomLimits = {
  maxMembers: 50,
  maxLog: 20_000,
  presenceTimeout: 45_000,
};

export type JoinResult =
  | { readonly ok: true; readonly room: Room; readonly backlog: LoggedOperation[] }
  | { readonly ok: false; readonly reason: string };

export class Room {
  private readonly members = new Map<string, Member>();
  private readonly log: LoggedOperation[] = [];
  /**
   * The sequence number of `log[0]`. Not always 1: the log is bounded, so an
   * old operation is eventually dropped. Kept explicitly because a client that
   * asks to resume from before this point must be told to reload rather than
   * handed a gap it cannot detect.
   */
  private firstSequence = 1;
  private nextSequence = 1;

  constructor(
    readonly id: string,
    private readonly limits: RoomLimits,
  ) {}

  size(): number {
    return this.members.size;
  }

  /** The highest sequence issued. Zero for a room nothing has happened in. */
  head(): number {
    return this.nextSequence - 1;
  }

  /** The oldest sequence still available to replay. */
  earliest(): number {
    return this.firstSequence;
  }

  add(member: Member): boolean {
    if (this.members.size >= this.limits.maxMembers && !this.members.has(member.connection)) {
      return false;
    }
    this.members.set(member.connection, member);
    return true;
  }

  remove(connection: string): Member | null {
    const member = this.members.get(connection);
    if (member === undefined) return null;
    this.members.delete(connection);
    return member;
  }

  get(connection: string): Member | null {
    return this.members.get(connection) ?? null;
  }

  /** Everybody except the given connection. Whom an operation is relayed to. */
  others(connection: string): Member[] {
    const out: Member[] = [];
    for (const member of this.members.values()) {
      if (member.connection !== connection) out.push(member);
    }
    return out;
  }

  /** Everybody, for a presence snapshot. */
  everyone(): Member[] {
    return [...this.members.values()];
  }

  touch(connection: string, at: number): void {
    const member = this.members.get(connection);
    if (member !== undefined) member.seenAt = at;
  }

  /**
   * Drop members who have gone quiet, returning who was dropped.
   *
   * A disconnect is frequently not observed: a lid closes, a network drops, a
   * process is killed. A room that only removes people who said goodbye fills
   * with ghosts, and the ghosts are worse than useless because somebody waits
   * for a reply from a person who left an hour ago.
   */
  sweep(now: number): Member[] {
    const dropped: Member[] = [];
    for (const member of [...this.members.values()]) {
      if (now - member.seenAt > this.limits.presenceTimeout) {
        this.members.delete(member.connection);
        dropped.push(member);
      }
    }
    return dropped;
  }

  /** Append an operation and return it with its assigned sequence. */
  append(replica: string, operation: unknown): LoggedOperation {
    const entry: LoggedOperation = { sequence: this.nextSequence, replica, operation };
    this.nextSequence += 1;
    this.log.push(entry);

    if (this.log.length > this.limits.maxLog) {
      const removed = this.log.length - this.limits.maxLog;
      this.log.splice(0, removed);
      this.firstSequence += removed;
    }
    return entry;
  }

  /**
   * Operations after a sequence number, for catching somebody up.
   *
   * Returns null when the request reaches back past what the log still holds.
   * Null means "reload the document", and it is deliberately distinguishable
   * from an empty array, which means "you are already up to date". Collapsing
   * the two is how a client silently misses edits: it asks for everything
   * since 5, is handed nothing because 5 was evicted, and concludes it is
   * current while the document has moved on without it.
   */
  since(sequence: number): LoggedOperation[] | null {
    if (sequence < 0) return null;

    // AHEAD OF THE SERVER IS NOT UP TO DATE. A client asking to resume from a
    // sequence higher than anything issued has state this room does not: a
    // different document's history, or a server that lost its log. Telling it
    // "you are current" would leave it believing its text matched while the
    // room held nothing at all. Caught by the live suite; the arithmetic
    // reads perfectly well until somebody actually asks.
    if (sequence > this.head()) return null;

    if (sequence === this.head()) return [];
    if (sequence + 1 < this.firstSequence) return null;
    const start = sequence + 1 - this.firstSequence;
    return this.log.slice(start);
  }
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly limits: RoomLimits = DEFAULT_LIMITS) {}

  count(): number {
    return this.rooms.size;
  }

  /** Total people across every room. For the health endpoint. */
  population(): number {
    let total = 0;
    for (const room of this.rooms.values()) total += room.size();
    return total;
  }

  peek(id: string): Room | null {
    return this.rooms.get(id) ?? null;
  }

  join(id: string, member: Member, since: number | null): JoinResult {
    if (!isValidRoomId(id)) return { ok: false, reason: 'that is not a usable document id' };

    let room = this.rooms.get(id);
    if (room === undefined) {
      room = new Room(id, this.limits);
      this.rooms.set(id, room);
    }

    if (!room.add(member)) {
      // An empty room created a moment ago for a join that is now refused
      // would leak one room per refusal.
      if (room.size() === 0) this.rooms.delete(id);
      return { ok: false, reason: 'this document already has as many editors as it can carry' };
    }

    const backlog = since === null ? [] : room.since(since);
    if (backlog === null) {
      return {
        ok: false,
        reason: 'the history you asked to resume from is no longer held; reload the document',
      };
    }

    return { ok: true, room, backlog };
  }

  /** Remove somebody, and forget an empty room so memory does not creep. */
  leave(id: string, connection: string): Member | null {
    const room = this.rooms.get(id);
    if (room === undefined) return null;
    const member = room.remove(connection);
    if (room.size() === 0) this.rooms.delete(id);
    return member;
  }

  /** Sweep every room, returning who was dropped and from where. */
  sweep(now: number): { room: string; member: Member }[] {
    const dropped: { room: string; member: Member }[] = [];
    for (const [id, room] of [...this.rooms.entries()]) {
      for (const member of room.sweep(now)) dropped.push({ room: id, member });
      if (room.size() === 0) this.rooms.delete(id);
    }
    return dropped;
  }
}

/**
 * Room ids come from clients and are used as storage keys, so they are
 * validated rather than trusted. The rejected shapes are the ones that escape
 * a directory: a separator, a parent reference, an absolute path, a null byte.
 */
export function isValidRoomId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}
