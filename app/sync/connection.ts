/**
 * The client side of collaboration: staying connected, and coping when not.
 *
 * OFFLINE IS THE NORMAL CASE. This is the part of the design that decides
 * whether that sentence is true or merely written down. A connection object
 * that assumes the socket is there, and treats its absence as an error path
 * bolted on afterwards, produces an application that stops working when the
 * network hiccups. So the shape here is the other way round: the queue and the
 * document are the truth, the socket is an optimisation for sharing them, and
 * every path through this file works with `socket === null`.
 *
 * The transport is injected rather than constructed. Not for test convenience
 * — for honesty: a connection that builds its own socket can only be tested by
 * standing a server up, so the reconnect logic ends up tested by nothing and
 * the backoff arithmetic is whatever somebody typed. Here it is a function
 * returning a socket-shaped thing, and the real one is `new WebSocket(url)`.
 */

import { Document, OutboundQueue, type Operation } from './crdt';

export type ConnectionState =
  | 'offline'
  | 'connecting'
  | 'joining'
  | 'live'
  | 'reconnecting'
  | 'refused';

/** The bit of a WebSocket this uses. Narrow so a fake is honest, not partial. */
export interface Socket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface Peer {
  readonly replica: string;
  readonly name: string;
  readonly caret: number | null;
}

export interface ConnectionEvents {
  /** State changed. The UI reports exactly this rather than guessing. */
  onState?: (state: ConnectionState, detail: string) => void;
  /** Remote operations arrived and have been applied to the document. */
  onRemote?: (operations: readonly Operation[]) => void;
  onPeers?: (peers: readonly Peer[]) => void;
  onPolicy?: (policy: unknown) => void;
  /** The server refused something. Never swallowed. */
  onRefusal?: (reason: string, fatal: boolean) => void;
}

export interface ConnectionOptions {
  readonly room: string;
  readonly replica: string;
  readonly name: string;
  readonly open: () => Socket;
  /** Injected so backoff is testable without waiting real seconds. */
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
  readonly maxBackoff?: number;
}

/**
 * Backoff for reconnection: 1s, 2s, 4s, 8s… capped.
 *
 * Capped because an unbounded doubling means a laptop that closed its lid for
 * an afternoon wakes up and waits four more hours before trying. Jittered
 * because without it, every client disconnected by one server restart comes
 * back at the same instant and knocks it over again.
 */
export function backoffFor(attempt: number, cap: number, random: number): number {
  const base = Math.min(cap, 1000 * 2 ** Math.max(0, attempt - 1));
  // Full jitter: uniformly anywhere in [0, base]. Reconnect storms come from
  // everybody agreeing on the delay, and half-jitter still leaves half of it
  // agreed.
  return Math.round(base * random);
}

export class Connection {
  readonly document: Document;
  readonly queue = new OutboundQueue();

  private socket: Socket | null = null;
  private state: ConnectionState = 'offline';
  private attempt = 0;
  private timer: unknown = null;
  private peers: Peer[] = [];
  /** The last sequence this replica has seen, for resuming after a drop. */
  private head = 0;
  private stopped = false;

  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly maxBackoff: number;

  constructor(
    private readonly options: ConnectionOptions,
    private readonly events: ConnectionEvents = {},
  ) {
    this.document = new Document(options.replica);
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.maxBackoff = options.maxBackoff ?? 30_000;
  }

  currentState(): ConnectionState {
    return this.state;
  }

  currentPeers(): readonly Peer[] {
    return this.peers;
  }

  /** How much is waiting to be sent. What an offline indicator shows. */
  queued(): number {
    return this.queue.size();
  }

  connect(): void {
    if (this.stopped) return;
    if (this.socket !== null) return;

    this.moveTo('connecting', 'opening a connection');
    let socket: Socket;
    try {
      socket = this.options.open();
    } catch {
      // A transport that throws on construction is the same case as one that
      // closes immediately: retry, do not crash the editor.
      this.scheduleReconnect('the connection could not be opened');
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.moveTo('joining', 'joining the document');
      this.write({
        type: 'join',
        room: this.options.room,
        replica: this.options.replica,
        name: this.options.name,
        // Resumes rather than reloading when the server still has the history.
        since: this.head === 0 ? null : this.head,
      });
    };

    socket.onmessage = (data: string) => this.receive(data);
    socket.onerror = () => {
      // Deliberately does nothing but note it. A socket that errors also
      // closes, and doing the teardown twice double-counts the attempt and
      // halves the backoff.
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.stopped) {
        this.moveTo('offline', 'disconnected');
        return;
      }
      // Anything in flight was never acknowledged, so it goes back to the
      // FRONT of the queue rather than being lost or reordered.
      this.queue.retry();
      this.scheduleReconnect('the connection dropped');
    };
  }

  /** Stop, and stay stopped. Reconnection does not resume by itself. */
  disconnect(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      this.write0(socket, { type: 'leave' });
      socket.close();
    }
    this.peers = [];
    this.events.onPeers?.([]);
    this.moveTo('offline', 'disconnected');
  }

  /**
   * Type locally. Always succeeds, connected or not.
   *
   * This is the whole offline story in one method: the document changes, the
   * operations queue, and whether a socket happens to exist decides only how
   * soon somebody else sees them.
   */
  insert(offset: number, text: string): Operation[] {
    const operations = this.document.insert(offset, text);
    this.enqueue(operations);
    return operations;
  }

  delete(offset: number, count: number): Operation[] {
    const operations = this.document.delete(offset, count);
    this.enqueue(operations);
    return operations;
  }

  /** Tell the others where the caret is. Dropped silently when offline. */
  reportCaret(caret: number | null): void {
    if (this.state !== 'live') return;
    this.write({ type: 'presence', caret });
  }

  private enqueue(operations: readonly Operation[]): void {
    if (operations.length === 0) return;
    this.queue.add(operations);
    this.flush();
  }

  /** Send whatever is queued, if there is anywhere to send it. */
  flush(): void {
    if (this.state !== 'live' || this.socket === null) return;
    const batch = this.queue.take();
    if (batch.length === 0) return;

    if (!this.write({ type: 'operations', operations: batch })) {
      this.queue.retry();
      return;
    }
    // Acknowledged on a successful write rather than on a reply. The server
    // sends no acknowledgement, and inventing one would be a protocol nobody
    // implements; a write that fails throws, and a socket that dies calls
    // retry() through onclose.
    this.queue.acknowledge();
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Malformed from the server is a server defect, not a reason to drop the
      // session: the local document is unaffected and still fully editable.
      this.events.onRefusal?.('the server sent something unreadable', false);
      return;
    }

    switch (message['type']) {
      case 'joined': {
        this.head = Number(message['head'] ?? 0);
        const backlog = (message['backlog'] ?? []) as {
          sequence: number;
          operation: Operation;
        }[];
        this.applyRemote(backlog);
        this.peers = ((message['members'] ?? []) as { replica: string; name: string }[]).map(
          (member) => ({ replica: member.replica, name: member.name, caret: null }),
        );
        this.events.onPeers?.(this.peers);
        this.moveTo('live', 'connected');
        // Anything typed while offline goes out now, in order.
        this.flush();
        return;
      }

      case 'operations':
        this.applyRemote(
          (message['operations'] ?? []) as { sequence: number; operation: Operation }[],
        );
        return;

      case 'presence':
        this.peers = ((message['members'] ?? []) as Peer[]).filter(
          (peer) => peer.replica !== this.options.replica,
        );
        this.events.onPeers?.(this.peers);
        return;

      case 'policy':
        this.events.onPolicy?.(message['policy']);
        return;

      case 'error': {
        const reason = String(message['reason'] ?? 'refused');
        const fatal = message['fatal'] === true;
        this.events.onRefusal?.(reason, fatal);
        if (fatal) {
          // A fatal refusal is usually "your history is unusable, reload". The
          // right answer is to stop retrying: reconnecting would ask the same
          // impossible question every few seconds forever.
          this.stopped = true;
          this.socket?.close();
          this.socket = null;
          this.moveTo('refused', reason);
        }
        return;
      }

      default:
        return;
    }
  }

  private applyRemote(entries: readonly { sequence: number; operation: Operation }[]): void {
    if (entries.length === 0) return;
    const applied: Operation[] = [];
    for (const entry of entries) {
      if (entry.sequence > this.head) this.head = entry.sequence;
      if (this.document.apply(entry.operation)) applied.push(entry.operation);
    }
    // Reported even when `applied` is shorter than `entries`: an operation the
    // CRDT held for a missing anchor is not an error, and the caret arithmetic
    // upstream only cares about what actually landed.
    if (applied.length > 0) this.events.onRemote?.(applied);
  }

  private write(message: unknown): boolean {
    const socket = this.socket;
    if (socket === null) return false;
    return this.write0(socket, message);
  }

  private write0(socket: Socket, message: unknown): boolean {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = backoffFor(this.attempt, this.maxBackoff, Math.random());
    this.moveTo('reconnecting', detail + '; retrying in ' + Math.round(delay / 100) / 10 + 's');
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private moveTo(state: ConnectionState, detail: string): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onState?.(state, detail);
  }
}
