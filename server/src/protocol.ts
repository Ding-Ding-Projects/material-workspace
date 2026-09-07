/**
 * The wire protocol between the suite and the collaboration server.
 *
 * Every message from a client is validated here before anything acts on it.
 * That is not ceremony: the client is across a network, so its messages are
 * untrusted input in exactly the sense a request body is, whatever the desktop
 * half happens to send today.
 *
 * The shapes are deliberately small. Everything document-specific rides inside
 * an opaque `operation` field, because the server does not understand
 * documents and must not start to.
 */

export type ClientMessage =
  | {
      readonly type: 'join';
      readonly room: string;
      readonly replica: string;
      readonly name: string;
      /** Resume after this sequence, or null for a fresh join. */
      readonly since: number | null;
    }
  | { readonly type: 'leave' }
  | { readonly type: 'operations'; readonly operations: readonly unknown[] }
  | { readonly type: 'presence'; readonly caret: number | null }
  | { readonly type: 'ping' };

export type ServerMessage =
  | {
      readonly type: 'joined';
      readonly room: string;
      readonly head: number;
      readonly backlog: readonly { sequence: number; replica: string; operation: unknown }[];
      readonly members: readonly { replica: string; name: string }[];
    }
  | {
      readonly type: 'operations';
      readonly operations: readonly { sequence: number; replica: string; operation: unknown }[];
    }
  | { readonly type: 'presence'; readonly members: readonly { replica: string; name: string; caret: number | null }[] }
  | { readonly type: 'policy'; readonly policy: unknown }
  | { readonly type: 'pong' }
  | { readonly type: 'error'; readonly reason: string; readonly fatal: boolean };

export type ParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly reason: string };

/** How many operations one message may carry. */
export const MAX_OPERATIONS_PER_MESSAGE = 512;

/**
 * Parse and validate one client message.
 *
 * Refuses anything it does not recognise rather than ignoring it. A silently
 * dropped message is the worst of the three options: the sender believes it
 * arrived, the receiver never saw it, and nothing anywhere records the
 * disagreement.
 */
export function parseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'that was not JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'a message must be an object' };
  }

  const message = parsed as Record<string, unknown>;
  const type = message['type'];

  switch (type) {
    case 'join': {
      const room = message['room'];
      const replica = message['replica'];
      const name = message['name'];
      const since = message['since'];

      if (typeof room !== 'string' || room === '') return { ok: false, reason: 'join needs a room' };
      if (typeof replica !== 'string' || replica === '') {
        return { ok: false, reason: 'join needs a replica id' };
      }
      if (replica.length > 64) return { ok: false, reason: 'that replica id is too long' };
      if (typeof name !== 'string') return { ok: false, reason: 'join needs a name' };
      if (name.length > 120) return { ok: false, reason: 'that name is too long' };
      if (since !== null && (typeof since !== 'number' || !Number.isInteger(since) || since < 0)) {
        return { ok: false, reason: 'since must be a whole number or null' };
      }

      return { ok: true, message: { type: 'join', room, replica, name, since: since as number | null } };
    }

    case 'leave':
      return { ok: true, message: { type: 'leave' } };

    case 'operations': {
      const operations = message['operations'];
      if (!Array.isArray(operations)) return { ok: false, reason: 'operations must be an array' };
      if (operations.length === 0) return { ok: false, reason: 'an empty batch says nothing' };
      if (operations.length > MAX_OPERATIONS_PER_MESSAGE) {
        // Bounded so one message cannot make the server relay unboundedly to
        // everybody else in the room. The byte ceiling in the frame decoder
        // does not cover this: a great many tiny operations fit inside it.
        return { ok: false, reason: 'too many operations in one message' };
      }
      return { ok: true, message: { type: 'operations', operations } };
    }

    case 'presence': {
      const caret = message['caret'];
      if (caret !== null && (typeof caret !== 'number' || !Number.isFinite(caret))) {
        return { ok: false, reason: 'caret must be a number or null' };
      }
      return { ok: true, message: { type: 'presence', caret: caret as number | null } };
    }

    case 'ping':
      return { ok: true, message: { type: 'ping' } };

    default:
      return { ok: false, reason: 'unrecognised message type' };
  }
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
