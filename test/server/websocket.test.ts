/**
 * The framing codec.
 *
 * Tested against byte layouts rather than against itself, including the
 * RFC 6455 worked example, so the implementation is confirmed by an outside
 * source rather than by agreeing with its own encoder.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOSE,
  MessageAssembler,
  OPCODE,
  ProtocolError,
  acceptKey,
  closePayload,
  decode,
  encode,
  handshake,
  isValidKey,
  readClose,
} from '../../server/src/websocket';

/** Mask a payload the way a client must. */
function clientFrame(opcode: number, payload: Buffer, fin = true, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;

  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] as number) ^ (mask[index % 4] as number);
  }
  return Buffer.concat([header, mask, masked]);
}

// ------------------------------------------------------------- handshake --

test('the accept key matches the worked example in RFC 6455', () => {
  // Section 1.3 of the RFC. Confirming against the published value rather than
  // against our own encoder is what makes this a conformance test at all.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a valid upgrade is accepted with the computed key', () => {
  const result = handshake({
    upgrade: 'WebSocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  });
  assert.equal(result.ok, true);
  assert.match(result.response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(result.response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
});

test('a wrong version is refused and advertises the one we speak', () => {
  // Without the advertisement a client has no way to know what to retry with.
  const result = handshake({
    upgrade: 'websocket',
    'sec-websocket-version': '8',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  });
  assert.equal(result.ok, false);
  assert.match(result.response, /426 Upgrade Required/);
  assert.match(result.response, /Sec-WebSocket-Version: 13/);
});

test('a key that is not sixteen base64 bytes is refused', () => {
  assert.equal(isValidKey('dGhlIHNhbXBsZSBub25jZQ=='), true);
  assert.equal(isValidKey('c2hvcnQ='), false, 'six bytes was accepted');
  assert.equal(isValidKey('not base64!'), false);
  assert.equal(isValidKey(''), false);

  const result = handshake({
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'c2hvcnQ=',
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------- frames --

test('a short frame round-trips', () => {
  const payload = Buffer.from('hello');
  const result = decode(clientFrame(OPCODE.text, payload), 1024);
  assert.equal(result.frames.length, 1);
  assert.equal((result.frames[0] as { payload: Buffer }).payload.toString(), 'hello');
  assert.equal(result.error, undefined);
});

test('the three length encodings all round-trip at their boundaries', () => {
  // 125 is the last one-byte length, 126 the first two-byte one, 65535 the
  // last, 65536 the first eight-byte one. Off-by-one here corrupts every
  // message of exactly that size and no others, which is the kind of defect
  // that survives for years.
  for (const size of [0, 1, 125, 126, 127, 65_535, 65_536]) {
    const payload = Buffer.alloc(size, 0x61);
    const result = decode(clientFrame(OPCODE.binary, payload), 1_000_000);
    assert.equal(result.frames.length, 1, 'size ' + size + ' produced no frame');
    assert.equal((result.frames[0] as { payload: Buffer }).payload.length, size);
  }
});

test('a frame split byte by byte is assembled, not corrupted', () => {
  // TCP delivers bytes, not messages. Anything that assumes a read is a
  // frame works on a local link and corrupts messages on a real network.
  // One byte at a time is the harshest version of the same thing.
  const whole = clientFrame(OPCODE.text, Buffer.from('a longer message than one read'));
  let buffer: Buffer = Buffer.alloc(0);
  let assembled: string | null = null;

  for (let index = 0; index < whole.length; index += 1) {
    buffer = Buffer.concat([buffer, whole.subarray(index, index + 1)]);
    const result = decode(buffer, 1024);
    buffer = Buffer.from(result.rest);
    if (result.frames.length > 0) {
      assembled = (result.frames[0] as { payload: Buffer }).payload.toString();
    }
  }

  assert.equal(assembled, 'a longer message than one read');
});

test('three frames arriving in one read are all decoded', () => {
  const buffer = Buffer.concat([
    clientFrame(OPCODE.text, Buffer.from('one')),
    clientFrame(OPCODE.text, Buffer.from('two')),
    clientFrame(OPCODE.text, Buffer.from('three')),
  ]);
  const result = decode(buffer, 1024);
  assert.deepEqual(
    result.frames.map((frame) => frame.payload.toString()),
    ['one', 'two', 'three'],
  );
  assert.equal(result.rest.length, 0);
});

test('an unmasked client frame is a protocol error', () => {
  const result = decode(encode(OPCODE.text, Buffer.from('hi')), 1024);
  assert.equal(result.error?.code, CLOSE.protocolError);
});

test('a payload over the ceiling is refused before it is allocated', () => {
  // The claim is what is refused, not the bytes: a peer claiming four
  // gigabytes must not be able to make this process try to hold one.
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(4_000_000_000), 2);
  const result = decode(Buffer.concat([header, Buffer.alloc(4)]), 1024);
  assert.equal(result.error?.code, CLOSE.tooLarge);
});

test('reserved bits and unknown opcodes are refused', () => {
  const reserved = clientFrame(OPCODE.text, Buffer.from('x'));
  reserved[0] = (reserved[0] as number) | 0x40;
  assert.equal(decode(reserved, 1024).error?.code, CLOSE.protocolError);

  const unknown = clientFrame(0x3, Buffer.from('x'));
  assert.equal(decode(unknown, 1024).error?.code, CLOSE.protocolError);
});

test('a fragmented or oversized control frame is refused', () => {
  // A control frame must be handleable immediately, which is why it may not be
  // fragmented and may not exceed 125 bytes.
  const fragmented = clientFrame(OPCODE.ping, Buffer.from('x'), false);
  assert.equal(decode(fragmented, 1024).error?.code, CLOSE.protocolError);

  const oversized = clientFrame(OPCODE.ping, Buffer.alloc(200));
  assert.equal(decode(oversized, 1024).error?.code, CLOSE.protocolError);
});

// -------------------------------------------------------------- assembly --

test('a fragmented message is reassembled in order', () => {
  const assembler = new MessageAssembler(1024);
  assert.equal(assembler.push({ fin: false, opcode: OPCODE.text, payload: Buffer.from('Hong ') }), null);
  assert.equal(assembler.push({ fin: false, opcode: OPCODE.continuation, payload: Buffer.from('Kong ') }), null);
  const done = assembler.push({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from('workspace') });
  assert.equal(done?.payload.toString(), 'Hong Kong workspace');
  assert.equal(assembler.pending(), 0);
});

test('a message is bounded across every fragment, not per frame', () => {
  // The denial of service a per-frame limit passes cleanly: a million small
  // fragments and FIN never set, until the process is killed.
  const assembler = new MessageAssembler(100);
  assert.throws(
    () => {
      for (let index = 0; index < 50; index += 1) {
        assembler.push({ fin: false, opcode: index === 0 ? OPCODE.text : OPCODE.continuation, payload: Buffer.alloc(10) });
      }
    },
    (error: unknown) => error instanceof ProtocolError && error.code === CLOSE.tooLarge,
  );
});

test('a continuation with nothing to continue is refused', () => {
  const assembler = new MessageAssembler(1024);
  assert.throws(
    () => assembler.push({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from('x') }),
    (error: unknown) => error instanceof ProtocolError && error.code === CLOSE.protocolError,
  );
});

test('a new message starting mid-fragment is refused', () => {
  const assembler = new MessageAssembler(1024);
  assembler.push({ fin: false, opcode: OPCODE.text, payload: Buffer.from('a') });
  assert.throws(
    () => assembler.push({ fin: true, opcode: OPCODE.text, payload: Buffer.from('b') }),
    (error: unknown) => error instanceof ProtocolError,
  );
});

// ----------------------------------------------------------------- close --

test('a close payload carries the code and a truncated reason', () => {
  const long = 'x'.repeat(300);
  const payload = closePayload(CLOSE.policyViolation, long);
  // Truncated so the control frame stays inside its 125-byte ceiling; a close
  // frame that is itself malformed leaves the peer guessing why it was closed.
  assert.ok(payload.length <= 125, 'the close frame exceeded its ceiling');
  assert.equal(readClose(payload).code, CLOSE.policyViolation);
});

test('an empty close payload reads as a normal close', () => {
  assert.equal(readClose(Buffer.alloc(0)).code, CLOSE.normal);
});
