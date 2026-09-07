/**
 * The collaboration server.
 *
 * A plain `node:http` server with the WebSocket upgrade handled by this Oak
 * Kay's own codec. Nothing is installed alongside it: `node:http`,
 * `node:crypto` and `node:fs` are the whole dependency list, which is what
 * makes the container image a runtime and this directory and nothing else.
 *
 * OFFLINE IS THE NORMAL CASE. The desktop suite is fully usable with this
 * server unreachable; edits queue on the client and reconcile on reconnect.
 * A server that is down degrades collaboration and nothing else. That is a
 * property of the client, but it is stated here because it is the reason this
 * server is allowed to be simple.
 */

import http from 'node:http';
import type { Duplex } from 'node:stream';

import { Sessions, type Principal } from './identity';
import { PolicyStore, type PolicyDocument } from './policy';
import { encodeServerMessage, parseClientMessage, type ServerMessage } from './protocol';
import { DEFAULT_LIMITS, Rooms, type RoomLimits } from './rooms';
import { Vault } from './store';
import {
  CLOSE,
  MessageAssembler,
  OPCODE,
  ProtocolError,
  closePayload,
  decode,
  encode,
  handshake,
} from './websocket';

export interface ServerOptions {
  readonly port: number;
  readonly host: string;
  readonly vaultRoot: string;
  readonly sessionSecret: string;
  /** Refuse a frame larger than this. */
  readonly maxPayload: number;
  /** Refuse a reassembled message larger than this. */
  readonly maxMessage: number;
  readonly limits: RoomLimits;
  /** Build provenance, reported by /version. Never invented. */
  readonly version: string;
  readonly builtAt: string;
}

export const DEFAULT_OPTIONS: Omit<ServerOptions, 'sessionSecret' | 'version' | 'builtAt'> = {
  port: 8787,
  host: '0.0.0.0',
  vaultRoot: '/data/documents',
  maxPayload: 4 * 1024 * 1024,
  maxMessage: 8 * 1024 * 1024,
  limits: DEFAULT_LIMITS,
};

interface Connection {
  readonly id: string;
  readonly socket: Duplex;
  readonly assembler: MessageAssembler;
  buffer: Buffer;
  room: string | null;
  replica: string;
  caret: number | null;
  principal: Principal | null;
  open: boolean;
}

let connectionCounter = 0;

export class CollaborationServer {
  readonly rooms: Rooms;
  readonly policies = new PolicyStore();
  private readonly vault: Vault;
  private readonly sessions: Sessions;
  private readonly connections = new Map<string, Connection>();
  private readonly http: http.Server;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly options: ServerOptions) {
    this.rooms = new Rooms(options.limits);
    this.vault = new Vault(options.vaultRoot);
    this.sessions = new Sessions(options.sessionSecret);
    this.http = http.createServer((request, response) => {
      this.route(request, response);
    });
    this.http.on('upgrade', (request, socket, head) => {
      this.upgrade(request, socket as Duplex, head);
    });
  }

  async start(): Promise<number> {
    await this.vault.prepare();
    await new Promise<void>((resolve) => {
      this.http.listen(this.options.port, this.options.host, resolve);
    });

    // Presence expires rather than needing a goodbye, so somebody has to be
    // looking. Unref'd so the interval never keeps the process alive by itself.
    this.sweeper = setInterval(() => {
      for (const dropped of this.rooms.sweep(Date.now())) {
        this.broadcastPresence(dropped.room);
      }
    }, 10_000);
    this.sweeper.unref();

    const address = this.http.address();
    return typeof address === 'object' && address !== null ? address.port : this.options.port;
  }

  async stop(): Promise<void> {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    for (const connection of [...this.connections.values()]) {
      this.close(connection, CLOSE.goingAway, 'the server is shutting down');
    }
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
    });
  }

  // ------------------------------------------------------------------ HTTP --

  private route(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      // Deliberately cheap and dependency-free. A health check that touches
      // the disk reports unhealthy during a slow write, and an orchestrator
      // then restarts a server that was working.
      this.json(response, 200, {
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        rooms: this.rooms.count(),
        editors: this.rooms.population(),
        connections: this.connections.size,
      });
      return;
    }

    if (url.pathname === '/version') {
      this.json(response, 200, {
        version: this.options.version,
        builtAt: this.options.builtAt,
        // A fingerprint, never the secret, so two nodes can be confirmed to
        // share configuration without either printing it.
        sessionSecret: this.sessions.describeSecret(),
      });
      return;
    }

    if (url.pathname === '/api/policy' && request.method === 'GET') {
      this.json(response, 200, { policy: this.policies.get() });
      return;
    }

    if (url.pathname === '/api/policy' && request.method === 'PUT') {
      void this.publishPolicy(request, response);
      return;
    }

    if (url.pathname === '/api/documents' && request.method === 'GET') {
      void this.vault.list().then(
        (documents) => this.json(response, 200, { documents }),
        () => this.json(response, 500, { error: 'the vault could not be listed' }),
      );
      return;
    }

    this.json(response, 404, { error: 'no such route' });
  }

  private async publishPolicy(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(request, 256 * 1024);
    if (body === null) {
      // Answered, not reset. Destroying the request mid-body makes the client
      // see ECONNRESET, which is indistinguishable from the network breaking -
      // so an administrator with an oversized policy is told nothing useful.
      // `Connection: close` lets Node discard the rest of the body and hang up
      // AFTER the reply has gone out.
      this.json(response, 413, { error: 'that policy is too large' }, { connection: 'close' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.json(response, 400, { error: 'that was not JSON' });
      return;
    }

    const decision = this.policies.publish(parsed as PolicyDocument, Date.now());
    if (!decision.applied) {
      this.json(response, 409, { error: decision.reason });
      return;
    }

    for (const connection of this.connections.values()) {
      this.send(connection, { type: 'policy', policy: decision.policy });
    }
    this.json(response, 200, { applied: true, version: decision.policy.version });
  }

  private json(
    response: http.ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      // Nothing here is cacheable and a cached health check is worse than none.
      'cache-control': 'no-store',
      ...extra,
    });
    response.end(payload);
  }

  // ------------------------------------------------------------- websocket --

  private upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/sync') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const result = handshake(request.headers as Record<string, string | string[] | undefined>);
    if (!result.ok) {
      socket.end(result.response);
      return;
    }

    // The token rides in the query string because a browser's WebSocket
    // constructor cannot set headers. It is a bearer token, so it is verified
    // here and its VALUE never reaches a log line or an error message.
    const token = url.searchParams.get('token') ?? '';
    const verified = this.sessions.verify(token, Date.now());
    if (!verified.ok) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }

    socket.write(result.response);
    // Nagle batches small writes, which is precisely wrong for a stream of
    // single keystrokes: it trades the one thing collaboration is judged on
    // for bandwidth nobody is short of. The cast is because the upgrade
    // handler is typed as a Duplex while the object is always a net.Socket.
    (socket as unknown as { setNoDelay(on: boolean): void }).setNoDelay(true);

    connectionCounter += 1;
    const connection: Connection = {
      id: 'c' + connectionCounter,
      socket,
      assembler: new MessageAssembler(this.options.maxMessage),
      buffer: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      room: null,
      replica: '',
      caret: null,
      principal: verified.token.principal,
      open: true,
    };
    this.connections.set(connection.id, connection);

    socket.on('data', (chunk: Buffer) => this.receive(connection, chunk));
    socket.on('error', () => this.drop(connection));
    socket.on('close', () => this.drop(connection));

    if (connection.buffer.length > 0) this.receive(connection, Buffer.alloc(0));
  }

  private receive(connection: Connection, chunk: Buffer): void {
    if (!connection.open) return;
    connection.buffer = Buffer.concat([connection.buffer, chunk]);

    const result = decode(connection.buffer, this.options.maxPayload);
    connection.buffer = result.rest;

    for (const frame of result.frames) {
      if (frame.opcode === OPCODE.close) {
        this.close(connection, CLOSE.normal, '');
        return;
      }
      if (frame.opcode === OPCODE.ping) {
        this.write(connection, encode(OPCODE.pong, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODE.pong) continue;

      let message: { opcode: number; payload: Buffer } | null;
      try {
        message = connection.assembler.push(frame);
      } catch (error) {
        const failure = error as ProtocolError;
        this.close(connection, failure.code ?? CLOSE.protocolError, failure.message);
        return;
      }
      if (message === null) continue;

      if (message.opcode !== OPCODE.text) {
        // Binary is refused rather than half-supported. The protocol is JSON,
        // and accepting bytes nobody parses is a silent black hole.
        this.close(connection, CLOSE.unsupported, 'this protocol is text');
        return;
      }
      this.handle(connection, message.payload.toString('utf8'));
    }

    if (result.error !== undefined) {
      this.close(connection, result.error.code, result.error.reason);
    }
  }

  private handle(connection: Connection, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      // Reported, not ignored. A silently dropped message leaves the sender
      // believing it arrived and nothing anywhere recording the disagreement.
      this.send(connection, { type: 'error', reason: parsed.reason, fatal: false });
      return;
    }

    const now = Date.now();
    const message = parsed.message;

    if (connection.room !== null) this.rooms.peek(connection.room)?.touch(connection.id, now);

    switch (message.type) {
      case 'join': {
        if (connection.room !== null) this.rooms.leave(connection.room, connection.id);

        const joined = this.rooms.join(
          message.room,
          {
            connection: connection.id,
            replica: message.replica,
            principal: connection.principal?.subject ?? 'anonymous',
            name: message.name,
            seenAt: now,
          },
          message.since,
        );

        if (!joined.ok) {
          connection.room = null;
          this.send(connection, { type: 'error', reason: joined.reason, fatal: true });
          return;
        }

        connection.room = message.room;
        connection.replica = message.replica;

        this.send(connection, {
          type: 'joined',
          room: message.room,
          head: joined.room.head(),
          backlog: joined.backlog.map((entry) => ({
            sequence: entry.sequence,
            replica: entry.replica,
            operation: entry.operation,
          })),
          members: joined.room
            .everyone()
            .map((member) => ({ replica: member.replica, name: member.name })),
        });

        const policy = this.policies.get();
        if (policy !== null) this.send(connection, { type: 'policy', policy });
        this.broadcastPresence(message.room);
        return;
      }

      case 'leave': {
        if (connection.room === null) return;
        const room = connection.room;
        this.rooms.leave(room, connection.id);
        connection.room = null;
        this.broadcastPresence(room);
        return;
      }

      case 'operations': {
        if (connection.room === null) {
          this.send(connection, { type: 'error', reason: 'join a document first', fatal: false });
          return;
        }
        const room = this.rooms.peek(connection.room);
        if (room === null) return;

        const appended = message.operations.map((operation) =>
          room.append(connection.replica, operation),
        );
        const payload: ServerMessage = {
          type: 'operations',
          operations: appended.map((entry) => ({
            sequence: entry.sequence,
            replica: entry.replica,
            operation: entry.operation,
          })),
        };

        // Relayed to everybody ELSE. Echoing to the sender would make a client
        // apply its own operation twice; the CRDT survives that, but the
        // bandwidth and the caret arithmetic do not deserve it.
        for (const member of room.others(connection.id)) {
          const other = this.connections.get(member.connection);
          if (other !== undefined) this.send(other, payload);
        }

        void this.persist(connection.room, room.since(0) ?? []);
        return;
      }

      case 'presence': {
        connection.caret = message.caret;
        if (connection.room !== null) this.broadcastPresence(connection.room);
        return;
      }

      case 'ping':
        this.send(connection, { type: 'pong' });
        return;
    }
  }

  private persisting = new Set<string>();

  /**
   * Save a room's log, at most one write per room in flight.
   *
   * Without the guard, a fast typist produces one whole-file write per
   * keystroke and the writes overtake each other, so the file on disk ends up
   * holding whichever finished last rather than the newest.
   */
  private async persist(
    room: string,
    operations: readonly { sequence: number; replica: string; operation: unknown }[],
  ): Promise<void> {
    if (this.persisting.has(room)) return;
    this.persisting.add(room);
    try {
      await this.vault.save(room, operations);
    } catch {
      // Reported through the health surface rather than crashing the process:
      // a full disk must degrade collaboration, not take everybody's session
      // down with it.
      this.saveFailures += 1;
    } finally {
      this.persisting.delete(room);
    }
  }

  private saveFailures = 0;

  failedSaves(): number {
    return this.saveFailures;
  }

  private broadcastPresence(roomId: string): void {
    const room = this.rooms.peek(roomId);
    if (room === null) return;

    const members = room.everyone().map((member) => {
      const connection = this.connections.get(member.connection);
      return {
        replica: member.replica,
        name: member.name,
        caret: connection?.caret ?? null,
      };
    });

    for (const member of room.everyone()) {
      const connection = this.connections.get(member.connection);
      if (connection !== undefined) this.send(connection, { type: 'presence', members });
    }
  }

  private send(connection: Connection, message: ServerMessage): void {
    this.write(connection, encode(OPCODE.text, Buffer.from(encodeServerMessage(message), 'utf8')));
  }

  private write(connection: Connection, bytes: Buffer): void {
    if (!connection.open) return;
    try {
      connection.socket.write(bytes);
    } catch {
      this.drop(connection);
    }
  }

  private close(connection: Connection, code: number, reason: string): void {
    if (!connection.open) return;
    try {
      connection.socket.write(encode(OPCODE.close, closePayload(code, reason)));
    } catch {
      // The socket has already gone. Nothing to report; the drop below is the
      // whole cleanup either way.
    }
    connection.socket.end();
    this.drop(connection);
  }

  private drop(connection: Connection): void {
    if (!connection.open) return;
    connection.open = false;
    this.connections.delete(connection.id);
    if (connection.room !== null) {
      const room = connection.room;
      this.rooms.leave(room, connection.id);
      connection.room = null;
      this.broadcastPresence(room);
    }
  }

  /** Mint a session token. Used by the entry point and by the suite. */
  issue(principal: Principal, lifetime = 12 * 60 * 60 * 1000): string {
    return this.sessions.issue(principal, Date.now(), lifetime);
  }
}

/** Read a request body with a hard ceiling, returning null when it is exceeded. */
async function readBody(request: http.IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // PAUSED, not destroyed. Destroying here kills the socket before a
        // reply can be written, so the sender sees a connection reset instead
        // of being told what was wrong. The caller answers 413 with
        // `Connection: close`, and Node discards the unread remainder.
        request.pause();
        resolve(null);
        return;
      }
      parts.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    request.on('error', () => resolve(null));
  });
}
