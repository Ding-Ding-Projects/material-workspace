/**
 * The GIF writer.
 *
 * Written from scratch because this machine has no video encoder and the
 * project has no dependencies, so the recording contract had to be met with
 * code rather than with an install.
 *
 * The tests that matter are the ones that DECODE what was written. A GIF with a
 * wrong bit order or a code width that grows one code late is accepted by every
 * viewer and rendered as noise - so asserting on the header alone would pass on
 * a file that shows nothing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error - a build script, deliberately plain JavaScript with no types.
import {
  countGifFrames,
  encodeGif,
  indexPixels,
  lzwEncode,
  quantize,
} from '../../scripts/gif-encoder.mjs';

/** A solid frame of one colour. */
function solid(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = rgb[0];
    pixels[at + 1] = rgb[1];
    pixels[at + 2] = rgb[2];
    pixels[at + 3] = 255;
  }
  return pixels;
}

/**
 * Decode LZW back, so the test proves the bytes mean what they should.
 *
 * Deliberately a separate implementation from the encoder rather than a mirror
 * of it: a decoder written by copying the encoder's own assumptions agrees with
 * it about everything, including whatever it gets wrong.
 */
function lzwDecode(bytes: Uint8Array, minimumCodeSize: number): number[] {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minimumCodeSize + 1;
  let dictionary: number[][] = [];
  const reset = (): void => {
    dictionary = [];
    for (let index = 0; index < clearCode; index += 1) dictionary.push([index]);
    dictionary.push([]);
    dictionary.push([]);
    codeSize = minimumCodeSize + 1;
  };
  reset();

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let at = 0;
  let previous: number[] | null = null;

  for (;;) {
    while (bitCount < codeSize && at < bytes.length) {
      bitBuffer |= bytes[at] << bitCount;
      at += 1;
      bitCount += 8;
    }
    if (bitCount < codeSize) break;

    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;

    if (code === endCode) break;
    if (code === clearCode) {
      reset();
      previous = null;
      continue;
    }

    let entry: number[];
    if (code < dictionary.length && dictionary[code].length > 0) {
      entry = dictionary[code];
    } else if (previous !== null) {
      entry = [...previous, previous[0]];
    } else {
      throw new Error('the stream begins with a code that is not in the table');
    }

    out.push(...entry);
    if (previous !== null) {
      dictionary.push([...previous, entry[0]]);
      // ONE EARLIER than the encoder's own test, because a decoder is always one
      // entry behind: it can only add the entry for the previous code once it
      // has read the next one. Growing at the same point as the encoder makes
      // it read the first wide code at the old width, and everything after that
      // is noise - which is exactly what a viewer shows for a bad GIF.
      if (dictionary.length + 1 > (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }

  return out;
}

// ------------------------------------------------------------ quantizing --

test('an image with few colours is quantized EXACTLY, with no loss at all', () => {
  // A flat interface commonly has under 256 colours, so the palette should be
  // the colours themselves rather than an approximation of them.
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 0, 0, 255,
  ]);
  const palette = quantize(pixels);
  assert.equal(palette.length, 3);
  const keys = palette.map((c: number[]) => c.join(',')).sort();
  assert.deepEqual(keys, ['0,0,255', '0,255,0', '255,0,0']);
});

test('a palette never exceeds the limit it was given', () => {
  const pixels = new Uint8ClampedArray(64 * 4);
  for (let index = 0; index < 64; index += 1) {
    pixels[index * 4] = index * 4;
    pixels[index * 4 + 1] = 255 - index * 4;
    pixels[index * 4 + 2] = (index * 9) % 256;
    pixels[index * 4 + 3] = 255;
  }
  assert.ok(quantize(pixels, 8).length <= 8);
  assert.ok(quantize(pixels, 4).length <= 4);
});

test('the palette is weighted by how often a colour actually occurs', () => {
  // A box holding one white pixel and many of a surface tone should land on the
  // surface tone, not halfway between them where neither exists.
  const pixels = new Uint8ClampedArray(101 * 4);
  for (let index = 0; index < 100; index += 1) {
    pixels[index * 4] = 30;
    pixels[index * 4 + 1] = 30;
    pixels[index * 4 + 2] = 30;
    pixels[index * 4 + 3] = 255;
  }
  pixels[400] = 255;
  pixels[401] = 255;
  pixels[402] = 255;
  pixels[403] = 255;

  const palette = quantize(pixels, 1);
  assert.equal(palette.length, 1);
  assert.ok(palette[0][0] < 60, 'the single entry landed at ' + palette[0].join(','));
});

test('every pixel maps to its nearest entry', () => {
  const pixels = new Uint8ClampedArray([250, 0, 0, 255, 0, 0, 250, 255]);
  const palette = [
    [255, 0, 0],
    [0, 0, 255],
  ];
  assert.deepEqual([...indexPixels(pixels, palette)], [0, 1]);
});

// ------------------------------------------------------------------ LZW --

test('LZW round-trips a run of one value', () => {
  const indexed = new Uint8Array(1000).fill(3);
  const encoded = lzwEncode(indexed, 4);
  assert.deepEqual(lzwDecode(encoded, 4), [...indexed]);
});

test('LZW round-trips a repeating pattern, which is where the dictionary works', () => {
  const indexed = new Uint8Array(600);
  for (let index = 0; index < indexed.length; index += 1) indexed[index] = index % 7;
  const encoded = lzwEncode(indexed, 3);
  assert.deepEqual(lzwDecode(encoded, 3), [...indexed]);
});

test('LZW round-trips data long enough to grow the code width several times', () => {
  // THE ONE THAT CATCHES THE REAL BUG. A code width that grows one code late
  // produces a file every viewer accepts and renders as noise, and nothing
  // shorter than this exercises it.
  const indexed = new Uint8Array(9000);
  for (let index = 0; index < indexed.length; index += 1) {
    indexed[index] = (index * 31 + (index >> 5)) % 251;
  }
  const encoded = lzwEncode(indexed, 8);
  assert.deepEqual(lzwDecode(encoded, 8), [...indexed]);
});

test('LZW round-trips a stream long enough to exhaust the dictionary', () => {
  // Past 4096 entries the encoder must emit a clear code and start again. A
  // decoder that is never handed one still works; an encoder that never sends
  // one produces a corrupt stream at exactly this length.
  const indexed = new Uint8Array(60000);
  for (let index = 0; index < indexed.length; index += 1) {
    indexed[index] = (index ^ (index >> 7)) % 256;
  }
  const encoded = lzwEncode(indexed, 8);
  assert.deepEqual(lzwDecode(encoded, 8), [...indexed]);
});

// ------------------------------------------------------------ the writer --

test('a written GIF has the header, the loop, and the trailer', () => {
  const gif = encodeGif({
    width: 2,
    height: 2,
    delayMs: 100,
    frames: [solid(2, 2, [10, 20, 30])],
  });

  assert.equal(new TextDecoder().decode(gif.subarray(0, 6)), 'GIF89a');
  assert.equal(gif[6] | (gif[7] << 8), 2, 'width');
  assert.equal(gif[8] | (gif[9] << 8), 2, 'height');
  assert.equal(gif[gif.length - 1], 0x3b, 'trailer');
  assert.ok(
    new TextDecoder().decode(gif).includes('NETSCAPE2.0'),
    'no loop extension, so it would play once and stop',
  );
});

test('every frame is written, so a recording is not one still', () => {
  const frames = [
    solid(2, 2, [255, 0, 0]),
    solid(2, 2, [0, 255, 0]),
    solid(2, 2, [0, 0, 255]),
  ];
  const gif = encodeGif({ width: 2, height: 2, delayMs: 100, frames });

  // Counted by WALKING the file. The obvious version scans for the two
  // graphic-control bytes, and those occur inside compressed image data all the
  // time - it reported 39 frames in a real 33-frame recording, which reads as a
  // defect in the encoder rather than in the counting.
  assert.equal(countGifFrames(gif), frames.length);
});

test('the delay is never zero, which most viewers play as a flicker', () => {
  const gif = encodeGif({ width: 1, height: 1, delayMs: 0, frames: [solid(1, 1, [0, 0, 0])] });
  const at = gif.indexOf(0x21);
  // Header, block label, size, flags, then the two delay bytes.
  const delay = gif[at + 4] | (gif[at + 5] << 8);
  assert.ok(delay >= 2, 'the delay was written as ' + delay);
});

test('a frame of the wrong size is refused rather than written as garbage', () => {
  assert.throws(
    () => encodeGif({ width: 4, height: 4, delayMs: 100, frames: [solid(2, 2, [0, 0, 0])] }),
    /expected 64/,
  );
});

test('a GIF with no frames is refused', () => {
  assert.throws(() => encodeGif({ width: 2, height: 2, delayMs: 100, frames: [] }), /at least one/);
});

test('the pixels really survive the whole round trip', () => {
  // Header checks pass on a file that renders as noise. This decodes the image
  // data back and compares it to what went in.
  const width = 8;
  const height = 4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = index % 2 === 0 ? 200 : 20;
    pixels[index * 4 + 1] = 40;
    pixels[index * 4 + 2] = index < 16 ? 90 : 180;
    pixels[index * 4 + 3] = 255;
  }

  const gif = encodeGif({ width, height, delayMs: 100, frames: [pixels] });

  // Walk to the image descriptor, read its local table, then decode.
  let at = gif.indexOf(0x2c);
  assert.ok(at > 0, 'no image descriptor');
  const flags = gif[at + 9];
  const tableSize = 1 << ((flags & 0x07) + 1);
  const tableAt = at + 10;
  const palette: number[][] = [];
  for (let entry = 0; entry < tableSize; entry += 1) {
    palette.push([gif[tableAt + entry * 3], gif[tableAt + entry * 3 + 1], gif[tableAt + entry * 3 + 2]]);
  }

  const minimumCodeSize = gif[tableAt + tableSize * 3];
  let dataAt = tableAt + tableSize * 3 + 1;
  const data: number[] = [];
  for (;;) {
    const length = gif[dataAt];
    if (length === 0) break;
    for (let index = 1; index <= length; index += 1) data.push(gif[dataAt + index]);
    dataAt += length + 1;
  }

  const indexed = lzwDecode(Uint8Array.from(data), minimumCodeSize);
  assert.equal(indexed.length, width * height, 'the decoded frame is the wrong size');

  for (let index = 0; index < width * height; index += 1) {
    const colour = palette[indexed[index]];
    assert.deepEqual(
      colour,
      [pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]],
      'pixel ' + index + ' came back wrong',
    );
  }
});

test('the frame count walks the file rather than scanning for a byte pair', () => {
  // Built so that the graphic-control introducer appears inside the pixel data.
  // A scanning count reports more frames than there are; a walking one does not.
  const width = 16;
  const height = 16;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = index % 2 === 0 ? 0x21 : 0xf9;
    pixels[index * 4 + 1] = 0x21;
    pixels[index * 4 + 2] = 0xf9;
    pixels[index * 4 + 3] = 255;
  }
  const gif = encodeGif({ width, height, delayMs: 100, frames: [pixels, pixels] });
  assert.equal(countGifFrames(gif), 2);
});

test('the frame count refuses something that is not a GIF', () => {
  assert.throws(() => countGifFrames(new Uint8Array(4)), /too short/);
  assert.throws(() => countGifFrames(new Uint8Array(40)), /not a GIF/);
});
