/**
 * PDF stream filters.
 *
 * The gap these close is the worst shape a gap takes: the reader skipped every
 * compressed stream, returned an empty page, and reported success. Nearly every
 * PDF produced by anything deflates its content, so "no readable text" was the
 * answer for almost every real file - and it is indistinguishable from a file
 * that genuinely has no text in it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ascii85Decode,
  asciiHexDecode,
  decodeStream,
  filterNames,
  inflate,
  predictorFor,
  runLengthDecode,
  undoPngPredictor,
} from '../../app/engines/pdf/filters';
import { drawPage } from '../../app/engines/pdf/render';
import { readPdf, readText } from '../../app/engines/pdf/reader';

const text = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const bytesOf = (source: string): Uint8Array =>
  Uint8Array.from([...source].map((character) => character.charCodeAt(0)));

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new CompressionStream('deflate'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// ------------------------------------------------------- naming the filters --

test('a single filter is found, not only the array form', () => {
  // A reader that handles only the array form silently skips every
  // single-filter stream, which is most of them.
  assert.deepEqual(filterNames('<< /Filter /FlateDecode /Length 42 >>'), ['FlateDecode']);
});

test('a filter chain keeps its order, because the order is the meaning', () => {
  // ASCII85 then Flate. Reversed, the bytes decode without complaint and are
  // wrong.
  assert.deepEqual(filterNames('<< /Filter [/ASCII85Decode /FlateDecode] >>'), [
    'ASCII85Decode',
    'FlateDecode',
  ]);
});

test('no filter at all is an empty list, not a guess', () => {
  assert.deepEqual(filterNames('<< /Length 10 >>'), []);
});

test('predictor parameters default to no predictor rather than to zero', () => {
  // A zero would make the row arithmetic divide by nothing.
  assert.deepEqual(predictorFor('<< /Length 1 >>'), { predictor: 1, columns: 1, colors: 1 });
  assert.deepEqual(
    predictorFor('<< /DecodeParms << /Predictor 12 /Columns 5 /Colors 1 >> >>'),
    { predictor: 12, columns: 5, colors: 1 },
  );
});

// ------------------------------------------------------------ the decoders --

test('hexadecimal decodes, and an odd final digit pairs with a zero', () => {
  // Refusing an odd count would reject files the specification calls valid.
  assert.equal(text(asciiHexDecode(bytesOf('48656C6C6F>'))), 'Hello');
  assert.equal(text(asciiHexDecode(bytesOf('414>'))), 'A@');
});

test('hexadecimal ignores the whitespace real files are full of', () => {
  assert.equal(text(asciiHexDecode(bytesOf('48 65 6C\n6C 6F >'))), 'Hello');
});

test('ASCII85 decodes, and z really is four zero bytes', () => {
  // A decoder that treats z as an ordinary character is the right kind of
  // wrong: mostly correct, with holes.
  assert.deepEqual([...ascii85Decode(bytesOf('z~>'))], [0, 0, 0, 0]);
  assert.equal(text(ascii85Decode(bytesOf('87cURD]j7BEbo80~>'))), 'Hello world!');
});

test('ASCII85 handles a partial final group rather than dropping it', () => {
  // The last group is nearly always partial, so dropping it loses the end of
  // every stream - quietly, because the rest reads fine.
  assert.equal(text(ascii85Decode(bytesOf('87cUR~>'))), 'Hell');
});

test('run length expands a repeat and copies a literal run', () => {
  // 2 means three literal bytes; 254 means the next byte three times.
  assert.equal(text(runLengthDecode(Uint8Array.from([2, 65, 66, 67, 254, 68, 128]))), 'ABCDDD');
});

test('run length stops at its end marker instead of reading past it', () => {
  assert.equal(text(runLengthDecode(Uint8Array.from([0, 65, 128, 66, 67]))), 'A');
});

test('inflate reads a zlib stream, which is what FlateDecode means', async () => {
  const original = bytesOf('The quick brown fox jumps over the lazy dog, repeatedly.');
  const packed = await deflate(original);
  assert.equal(text(await inflate(packed)), text(original));
});

test('inflate falls back to raw deflate, which some producers really emit', async () => {
  const original = bytesOf('raw deflate happens in the wild');
  const raw = new Uint8Array(
    await new Response(
      new Blob([original as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );
  assert.equal(text(await inflate(raw)), text(original));
});

// ------------------------------------------------------------- the predictor --

test('a PNG predictor is undone, including the leading filter byte', () => {
  // Dropping the filter byte and keeping the rest is the obvious shortcut, and
  // it gives data one byte narrower per row and wrong everywhere.
  // Two rows of three bytes: the first stored flat, the second as differences
  // from the row above.
  const encoded = Uint8Array.from([0, 10, 20, 30, 2, 1, 1, 1]);
  assert.deepEqual([...undoPngPredictor(encoded, 3, 1)], [10, 20, 30, 11, 21, 31]);
});

test('the Paeth predictor picks the closest neighbour, not simply the one above', () => {
  const encoded = Uint8Array.from([0, 10, 20, 4, 5, 5]);
  const out = undoPngPredictor(encoded, 2, 1);
  assert.deepEqual([...out].slice(0, 2), [10, 20]);
  // First byte of row two: left is 0, up is 10, up-left is 0 -> predicts 10.
  assert.equal(out[2], 15);
});

// ------------------------------------------------------------- the chain --

test('a deflated stream decodes, and says which filter it applied', async () => {
  const packed = await deflate(bytesOf('BT (hidden in a deflate) Tj ET'));
  const result = await decodeStream('<< /Filter /FlateDecode >>', packed);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.match(text(result.bytes), /hidden in a deflate/);
  assert.deepEqual(result.applied, ['FlateDecode']);
});

test('a chain applies in order, and the reverse order really does differ', async () => {
  const inner = await deflate(bytesOf('two filters deep'));
  const hex = [...inner].map((byte) => byte.toString(16).padStart(2, '0')).join('') + '>';

  const forwards = await decodeStream('<< /Filter [/ASCIIHexDecode /FlateDecode] >>', bytesOf(hex));
  assert.ok(forwards.ok);
  if (!forwards.ok) return;
  assert.equal(text(forwards.bytes), 'two filters deep');

  // The same bytes with the chain declared the other way round must NOT come
  // out the same. If they do, the order is being ignored.
  const backwards = await decodeStream(
    '<< /Filter [/FlateDecode /ASCIIHexDecode] >>',
    bytesOf(hex),
  );
  if (backwards.ok) assert.notEqual(text(backwards.bytes), 'two filters deep');
});

test('an unsupported filter is REFUSED BY NAME, not passed through as text', async () => {
  // Returning the compressed bytes produces a page of noise that looks exactly
  // like extracted content.
  const result = await decodeStream('<< /Filter /Crypt >>', bytesOf('anything'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /Crypt/);
  assert.equal(result.notText, false);
});

test('an image filter is reported as an image, not as a failure', async () => {
  // Calling a JPEG an error makes a perfectly normal document look broken.
  const result = await decodeStream('<< /Filter /DCTDecode >>', bytesOf('jpegbytes'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.notText, true);
  assert.match(result.reason, /image data/);
});

test('corrupt data is refused with its reason, and does not throw', async () => {
  // One damaged object in a long document should cost that object, not the
  // document.
  const result = await decodeStream('<< /Filter /FlateDecode >>', bytesOf('not compressed at all'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /FlateDecode/);
});

test('a stream with no filter comes back untouched', async () => {
  const result = await decodeStream('<< /Length 5 >>', bytesOf('plain'));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(text(result.bytes), 'plain');
  assert.deepEqual(result.applied, []);
});

// ---------------------------------------------------- against a real file --

const pdfWith = async (contents: Uint8Array, filter: string): Promise<Uint8Array> => {
  const head =
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
    '4 0 obj\n<< ' + filter + ' /Length ' + contents.length + ' >>\nstream\n';
  const tail = '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  const out = new Uint8Array(head.length + contents.length + tail.length);
  out.set(bytesOf(head), 0);
  out.set(contents, head.length);
  out.set(bytesOf(tail), head.length + contents.length);
  return out;
};

test('a real deflated PDF gives up its text, where the old path gave nothing', async () => {
  const packed = await deflate(bytesOf('BT /F1 12 Tf (Compressed and readable) Tj ET'));
  const file = await pdfWith(packed, '/Filter /FlateDecode');

  const result = await readText(readPdf(file));
  assert.deepEqual([...result.pages], ['Compressed and readable']);
  assert.deepEqual([...result.unreadable], []);
});

test('an uncompressed PDF still reads, so the new path did not replace the old', async () => {
  const file = await pdfWith(bytesOf('BT (Plain and readable) Tj ET'), '');
  const result = await readText(readPdf(file));
  assert.deepEqual([...result.pages], ['Plain and readable']);
});

test('a stream behind an unsupported filter is NAMED rather than silently absent', async () => {
  // "No readable text" without saying why is indistinguishable from a document
  // that genuinely has none.
  const file = await pdfWith(bytesOf('whatever'), '/Filter /Crypt');
  const result = await readText(readPdf(file));
  assert.equal(result.pages.length, 0);
  assert.equal(result.unreadable.length, 1);
  assert.match(result.unreadable[0] ?? '', /Crypt/);
});

test('an image stream is counted as an image, not reported as a fault', async () => {
  const file = await pdfWith(bytesOf('jpegdata'), '/Filter /DCTDecode');
  const result = await readText(readPdf(file));
  assert.equal(result.images, 1);
  assert.deepEqual([...result.unreadable], []);
});

test('one damaged object does not cost the whole document its other pages', async () => {
  // Two content streams, one of which is a lie about being deflated.
  const good = await deflate(bytesOf('BT (Second page survives) Tj ET'));
  const head =
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Filter /FlateDecode /Length 6 >>\nstream\nBROKEN\nendstream\nendobj\n' +
    '2 0 obj\n<< /Filter /FlateDecode /Length ' + good.length + ' >>\nstream\n';
  const tail = '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  const file = new Uint8Array(head.length + good.length + tail.length);
  file.set(bytesOf(head), 0);
  file.set(good, head.length);
  file.set(bytesOf(tail), head.length + good.length);

  const result = await readText(readPdf(file));
  assert.deepEqual([...result.pages], ['Second page survives']);
  assert.equal(result.unreadable.length, 1);
});

// -------------------------------------------------------- drawing a page --

test('a deflated page can actually be DRAWN, not only read as text', async () => {
  // The text path and the drawing path are separate, and fixing one leaves the
  // other exactly as broken - a reader that quotes a document it cannot show.
  const packed = await deflate(bytesOf('1 0 0 RG 10 10 100 50 re S BT (drawn) Tj ET'));
  const file = await pdfWith(packed, '/Filter /FlateDecode');

  const drawn = await drawPage(readPdf(file));
  assert.notEqual(drawn.page, null);
  assert.equal(drawn.reason, '');
});

test('a file with nothing drawable says WHY, rather than showing a blank canvas', async () => {
  const file = await pdfWith(bytesOf('jpegdata'), '/Filter /DCTDecode');
  const drawn = await drawPage(readPdf(file));
  assert.equal(drawn.page, null);
  assert.match(drawn.reason, /image/);
  // The old copy claimed the engine does not decompress. It does now, and a
  // message that was true when written became a false claim about the product.
  assert.ok(!/does not decompress/.test(drawn.reason), drawn.reason);
});

test('an unsupported filter reaches the drawing surface by name too', async () => {
  const file = await pdfWith(bytesOf('whatever'), '/Filter /Crypt');
  const drawn = await drawPage(readPdf(file));
  assert.equal(drawn.page, null);
  assert.match(drawn.reason, /Crypt/);
});
