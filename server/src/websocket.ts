/**
 * RFC 6455 WebSocket, written here rather than taken from a package.
 *
 * The reason is the one that governs the rest of this project: the suite
 * installs nothing alongside itself, and that has to hold for the server too,
 * or "self-contained" is a claim about the desktop half only. A framing codec
 * is a few hundred lines and is exhaustively testable, which is a better trade
 * than a dependency whose failure modes nobody here has read.
 *
 * What is deliberately NOT implemented, said plainly rather than left as a gap:
 * `permessage-deflate` compression and the extension negotiation that carries
 * it. The handshake therefore never accepts an extension, so a client offering
 * one falls back to uncompressed frames rather than being handed a connection
 * this code cannot read.
 */

import crypto from 'node:crypto';

/** The fixed GUID from RFC 6455 section 1.3. Not a secret; it is in the RFC. */
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/** Close codes this server sends. The numbers are RFC 6455 section 7.4.1. */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  policyViolation: 1008,
  tooLarge: 1009,
  internal: 1011,
} as const;

export interface Frame {
  readonly fin: boolean;
  readonly opcode: Opcode;
  readonly payload: Buffer;
}

/**
 * The `Sec-WebSocket-Accept` value for a client's key.
 *
 * SHA-1 is used because the RFC says so. It is not a security control here:
 * the value proves the peer read the handshake, not that it is trusted. Saying
 * that out loud, because "SHA-1" in a diff attracts a well-meaning correction
 * that would break every client.
 */
export function acceptKey(key: string): string {
  return crypto
    .createHash('sha1')
    .update(key + ACCEPT_GUID)
    .digest('base64');
}

export interface HandshakeResult {
  readonly ok: boolean;
  /** The complete response to write, headers and terminator included. */
  readonly response: string;
  readonly reason?: string;
}

/**
 * Validate an upgrade request and produce the response to write.
 *
 * Refuses rather than tolerating: a wrong version, a missing key, or a key
 * that is not 16 bytes of base64. A tolerant handshake produces a connection
 * that half works, which is harder to diagnose than one that is refused.
 */
export function handshake(
  headers: Record<string, string | string[] | undefined>,
): HandshakeResult {
  const get = (name: string): string => {
    const value = headers[name];
    if (Array.isArray(value)) return value[0] ?? '';
    return value ?? '';
  };

  if (get('upgrade').toLowerCase() !== 'websocket') {
    return {
      ok: false,
      response: badRequest('expected an Upgrade: websocket header'),
      reason: 'upgrade',
    };
  }

  if (get('sec-websocket-version') !== '13') {
    return {
      ok: false,
      // The RFC requires advertising the version we do speak, or a client has
      // no way to know what to retry with.
      response:
        'HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n',
      reason: 'version',
    };
  }

  const key = get('sec-websocket-key');
  if (!isValidKey(key)) {
    return {
      ok: false,
      response: badRequest('Sec-WebSocket-Key must be 16 base64 bytes'),
      reason: 'key',
    };
  }

  return {
    ok: true,
    response:
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      acceptKey(key) +
      '\r\n\r\n',
  };
}

function badRequest(reason: string): string {
  const body = reason + '\n';
  return (
    'HTTP/1.1 400 Bad Request\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Length: ' +
    Buffer.byteLength(body) +
    '\r\nConnection: close\r\n\r\n' +
    body
  );
}

export function isValidKey(key: string): boolean {
  if (key.length === 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return false;
  try {
    return Buffer.from(key, 'base64').length === 16;
  } catch {
    return false;
  }
}

/** Build a frame to send. Server frames are never masked, per the RFC. */
export function encode(opcode: Opcode, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

export interface DecodeResult {
  /** Frames fully read out of the buffer. */
  readonly frames: Frame[];
  /** What is left over, waiting for more bytes. */
  readonly rest: Buffer;
  /** Set when the peer broke the protocol. The connection must close. */
  readonly error?: { readonly code: number; readonly reason: string };
}

/**
 * Read whole frames out of a stream buffer.
 *
 * TCP delivers bytes, not messages: one frame commonly arrives in three reads,
 * and three frames commonly arrive in one. Anything that assumes a read is a
 * frame works perfectly on a fast local link and corrupts messages the moment
 * it meets a real network, which is the sort of defect that only shows up in
 * production. So it is handled here rather than hoped about.
 */
export function decode(buffer: Buffer, maxPayload: number): DecodeResult {
  const frames: Frame[] = [];
  let offset = 0;

  const fail = (code: number, reason: string): DecodeResult => ({
    frames,
    rest: buffer.subarray(offset),
    error: { code, reason },
  });

  for (;;) {
    if (buffer.length - offset < 2) break;

    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;

    const fin = (first & 0x80) !== 0;
    const reserved = first & 0x70;
    const opcode = (first & 0x0f) as Opcode;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (reserved !== 0) {
      // Reserved bits are only meaningful with a negotiated extension, and
      // this server negotiates none. Set means the peer believes we agreed
      // something, so the frames after it are not ones we can read.
      return fail(CLOSE.protocolError, 'reserved bits set');
    }

    if (!isKnownOpcode(opcode)) return fail(CLOSE.protocolError, 'unknown opcode');

    // A control frame carries at most 125 bytes and can never be fragmented.
    // Both rules exist so a control frame can always be handled immediately,
    // and a peer breaking them is a peer we cannot stay in step with.
    const control =
      opcode === OPCODE.close || opcode === OPCODE.ping || opcode === OPCODE.pong;
    if (control && (length > 125 || !fin)) {
      return fail(CLOSE.protocolError, 'malformed control frame');
    }

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      cursor += 8;
      if (big > BigInt(maxPayload)) return fail(CLOSE.tooLarge, 'payload too large');
      length = Number(big);
    }

    // Refused BEFORE allocating, which is the whole point: a peer claiming a
    // four-gigabyte payload must not be able to make this process try to hold
    // one.
    if (length > maxPayload) return fail(CLOSE.tooLarge, 'payload too large');

    // Every client frame must be masked. An unmasked one is either a broken
    // client or a proxy rewriting traffic, and the RFC says to fail.
    if (!masked) return fail(CLOSE.protocolError, 'client frame was not masked');

    if (buffer.length - cursor < 4 + length) break;

    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = (buffer[cursor + index] as number) ^ (mask[index % 4] as number);
    }
    cursor += length;

    frames.push({ fin, opcode, payload });
    offset = cursor;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function isKnownOpcode(opcode: number): opcode is Opcode {
  return (
    opcode === OPCODE.continuation ||
    opcode === OPCODE.text ||
    opcode === OPCODE.binary ||
    opcode === OPCODE.close ||
    opcode === OPCODE.ping ||
    opcode === OPCODE.pong
  );
}

export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Reassemble fragmented messages.
 *
 * A large message arrives as one frame with FIN clear followed by continuation
 * frames. Held separately from the decoder because the decoder must stay a
 * pure function of bytes: that is the part which is exhaustively testable.
 */
export class MessageAssembler {
  private opcode: Opcode | null = null;
  private parts: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxMessage: number) {}

  /**
   * Feed one data frame. Returns a complete message, or null while collecting.
   * Throws a ProtocolError when the peer breaks the fragmentation rules.
   */
  push(frame: Frame): { opcode: Opcode; payload: Buffer } | null {
    if (frame.opcode === OPCODE.continuation) {
      if (this.opcode === null) {
        throw new ProtocolError(
          CLOSE.protocolError,
          'continuation frame with nothing to continue',
        );
      }
    } else {
      if (this.opcode !== null) {
        throw new ProtocolError(
          CLOSE.protocolError,
          'a new message started before the last one finished',
        );
      }
      this.opcode = frame.opcode;
    }

    this.size += frame.payload.length;
    if (this.size > this.maxMessage) {
      // Bounded across the WHOLE message, not per frame. Without this a peer
      // sends a million small fragments and never sets FIN, and the process
      // grows until it is killed. Every per-frame limit passes that cleanly.
      throw new ProtocolError(CLOSE.tooLarge, 'message too large');
    }
    this.parts.push(frame.payload);

    if (!frame.fin) return null;

    const opcode = this.opcode;
    const payload = Buffer.concat(this.parts);
    this.opcode = null;
    this.parts = [];
    this.size = 0;
    return { opcode, payload };
  }

  /** Bytes held for an unfinished message. For diagnostics and for tests. */
  pending(): number {
    return this.size;
  }
}

/** A close frame's payload: a two-byte code then an optional UTF-8 reason. */
export function closePayload(code: number, reason = ''): Buffer {
  const text = Buffer.from(reason, 'utf8');
  // Truncated so the control frame stays within its 125-byte ceiling. A close
  // frame that is itself malformed leaves the peer guessing why it was closed.
  const trimmed = text.subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + trimmed.length);
  payload.writeUInt16BE(code, 0);
  trimmed.copy(payload, 2);
  return payload;
}

export function readClose(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: CLOSE.normal, reason: '' };
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString('utf8'),
  };
}
