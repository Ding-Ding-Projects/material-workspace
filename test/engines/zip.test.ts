/**
 * ZIP conformance.
 *
 * The reader is tested against a REAL deflated archive produced by Node's own
 * zlib, not only against archives this module wrote. A codec tested only
 * against its own output proves the two halves agree with each other and
 * nothing about whether either agrees with the format.
 */

import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';

import { ZipError, crc32, readZip, writeZip } from '../../app/engines/codec/zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

test('an archive this module writes reads back exactly', async () => {
  const archive = writeZip([
    { name: 'hello.txt', data: bytes('Hello, 香港') },
    { name: 'nested/deep/file.xml', data: bytes('<a>1</a>') },
    { name: 'empty.txt', data: new Uint8Array(0) },
  ]);
  const read = await readZip(archive);
  assert.equal(read.size, 3);
  assert.equal(decoder.decode(read.get('hello.txt')), 'Hello, 香港');
  assert.equal(decoder.decode(read.get('nested/deep/file.xml')), '<a>1</a>');
  assert.equal(read.get('empty.txt')?.length, 0);
});

test('CRC-32 matches the known vector', () => {
  // The standard check value for "123456789". A wrong table produces a
  // plausible number, so a self-consistent test would not catch it.
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

/**
 * Build a deflated archive by hand, the way a real writer does.
 *
 * This is the important test in the file: it proves the reader handles the
 * method every real office document actually uses.
 */
function deflatedArchive(name: string, content: Uint8Array): Uint8Array {
  const compressed = new Uint8Array(deflateRawSync(content));
  const nameBytes = encoder.encode(name);
  const crc = crc32(content);

  const local = new Uint8Array(30 + nameBytes.length + compressed.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, 0x0800, true);
  localView.setUint16(8, 8, true); // deflate
  localView.setUint32(14, crc, true);
  localView.setUint32(18, compressed.length, true);
  localView.setUint32(22, content.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(compressed, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, 0x0800, true);
  centralView.setUint16(10, 8, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, compressed.length, true);
  centralView.setUint32(24, content.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const output = new Uint8Array(local.length + central.length + end.length);
  output.set(local, 0);
  output.set(central, local.length);
  output.set(end, local.length + central.length);
  return output;
}

test('a DEFLATED entry is inflated, which is what every real office file needs', async () => {
  const content = bytes('<?xml version="1.0"?><root>' + 'x'.repeat(5000) + '</root>');
  const archive = deflatedArchive('xl/worksheets/sheet1.xml', content);
  // Confirm the fixture is genuinely compressed, or this test proves nothing.
  assert.ok(archive.length < content.length, 'the fixture did not actually compress');

  const read = await readZip(archive);
  assert.equal(decoder.decode(read.get('xl/worksheets/sheet1.xml')), decoder.decode(content));
});

test('a declared size that does not match the inflated size is refused', async () => {
  const content = bytes('the real content');
  const archive = deflatedArchive('a.txt', content);
  // Corrupt the central directory's uncompressed size. A reader that trusts
  // the stream and ignores this would return truncated data as though it were
  // whole.
  const view = new DataView(archive.buffer);
  const centralStart = archive.length - 22 - (46 + 5);
  view.setUint32(centralStart + 24, 999, true);
  await assert.rejects(() => readZip(archive), /inflated to/);
});

test('the end record is found backwards, so a false signature in data is ignored', async () => {
  // Content containing the end-of-central-directory signature. Scanning
  // forwards finds this and reads garbage; scanning backwards does not.
  const decoy = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0]);
  const archive = writeZip([{ name: 'decoy.bin', data: decoy }]);
  const read = await readZip(archive);
  assert.deepEqual([...(read.get('decoy.bin') ?? [])], [...decoy]);
});

test('an entry name that escapes its directory is refused', async () => {
  const archive = writeZip([{ name: '../escape.txt', data: bytes('no') }]);
  await assert.rejects(() => readZip(archive), ZipError);
});

test('a backslash in an entry name is refused', async () => {
  const archive = writeZip([{ name: 'a\\b.txt', data: bytes('no') }]);
  await assert.rejects(() => readZip(archive), ZipError);
});

test('bounds are enforced', async () => {
  const archive = writeZip([
    { name: 'a.txt', data: bytes('a') },
    { name: 'b.txt', data: bytes('b') },
  ]);
  await assert.rejects(() => readZip(archive, { maxEntries: 1 }), /over the limit/);
  await assert.rejects(() => readZip(archive, { maxTotalBytes: 1 }), /total byte limit/);
});

test('a file that is not a zip is refused clearly', async () => {
  await assert.rejects(() => readZip(bytes('this is plainly not a zip')), /not a zip archive/);
  await assert.rejects(() => readZip(new Uint8Array(4)), /too short/);
});

test('truncated entry data is refused rather than returned short', async () => {
  const archive = writeZip([{ name: 'a.txt', data: bytes('0123456789') }]);
  const truncated = archive.slice(0, archive.length - 40);
  await assert.rejects(() => readZip(truncated));
});

test('a large archive round-trips without corruption', async () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({
    name: 'entry-' + index + '.txt',
    data: bytes('content for entry ' + index + ' ' + 'y'.repeat(index)),
  }));
  const read = await readZip(writeZip(entries));
  assert.equal(read.size, 200);
  for (const entry of entries) {
    assert.equal(decoder.decode(read.get(entry.name)), decoder.decode(entry.data));
  }
});
