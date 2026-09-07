/**
 * An animated GIF writer, from scratch.
 *
 * WHY THIS EXISTS AT ALL. The contract asks for a committed screen recording of
 * the application actually running, and this machine has no video encoder. The
 * alternatives were to add a dependency to a project that deliberately has
 * none, or to ship no recording and claim the surface could not be captured -
 * which would be false, because it plainly can.
 *
 * GIF is the format a browser and a forge both render inline with no player, no
 * codec and no plugin, so a recording in it is a recording anybody can watch
 * from the README without downloading anything.
 *
 * WHAT IT COSTS, SAID PLAINLY. GIF carries 256 colours per frame. A Material
 * Design interface is mostly flat fills and text, which quantizes well, but a
 * gradient will band. That is a real limitation of the format and not a defect
 * in the capture.
 */

/* ------------------------------------------------------------ quantizing -- */

/**
 * Median cut, down to at most 256 colours.
 *
 * Chosen over a fixed web palette because the interface is built from one seed
 * colour: a fixed palette spends most of its entries on colours the image does
 * not contain and then has nothing left for the twenty shades of surface that
 * it does.
 */
export function quantize(pixels, maxColours = 256) {
  // Unique colours first. A screenshot of a flat interface commonly has fewer
  // than 256 to begin with, in which case the palette is exact and there is no
  // loss at all.
  const seen = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    const key =
      (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const colours = [...seen.entries()].map(([key, count]) => ({
    r: (key >> 16) & 0xff,
    g: (key >> 8) & 0xff,
    b: key & 0xff,
    count,
  }));

  if (colours.length <= maxColours) {
    return colours.map((colour) => [colour.r, colour.g, colour.b]);
  }

  let boxes = [colours];
  while (boxes.length < maxColours) {
    // Split the box with the widest channel. Splitting the biggest box by count
    // instead leaves a wide box of rare colours unsplit, and those are exactly
    // the ones a viewer notices going wrong.
    let widest = -1;
    let target = -1;
    let channel = 'r';

    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (const key of ['r', 'g', 'b']) {
        let low = 255;
        let high = 0;
        for (const colour of box) {
          if (colour[key] < low) low = colour[key];
          if (colour[key] > high) high = colour[key];
        }
        if (high - low > widest) {
          widest = high - low;
          target = index;
          channel = key;
        }
      }
    });

    if (target < 0) break;
    const box = boxes[target];
    box.sort((a, b) => a[channel] - b[channel]);
    const middle = Math.floor(box.length / 2);
    boxes = [
      ...boxes.slice(0, target),
      box.slice(0, middle),
      box.slice(middle),
      ...boxes.slice(target + 1),
    ];
  }

  return boxes.map((box) => {
    // Weighted by how often each colour actually occurs, so a box holding one
    // pixel of white and four hundred of a surface tone lands on the surface
    // tone rather than halfway between them.
    let total = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const colour of box) {
      total += colour.count;
      r += colour.r * colour.count;
      g += colour.g * colour.count;
      b += colour.b * colour.count;
    }
    if (total === 0) return [0, 0, 0];
    return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
  });
}

/** Map every pixel onto its nearest palette entry. */
export function indexPixels(pixels, palette) {
  const width = pixels.length / 4;
  const indexed = new Uint8Array(width);
  // Memoised: a flat interface repeats the same few colours across hundreds of
  // thousands of pixels, and the nearest-colour search is the expensive part.
  const cache = new Map();

  for (let index = 0, at = 0; index < pixels.length; index += 4, at += 1) {
    const key = (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
    let best = cache.get(key);
    if (best === undefined) {
      let bestDistance = Infinity;
      best = 0;
      for (let entry = 0; entry < palette.length; entry += 1) {
        const dr = palette[entry][0] - pixels[index];
        const dg = palette[entry][1] - pixels[index + 1];
        const db = palette[entry][2] - pixels[index + 2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = entry;
        }
      }
      cache.set(key, best);
    }
    indexed[at] = best;
  }
  return indexed;
}

/* ------------------------------------------------------------------ LZW -- */

/**
 * GIF's variable-width LZW.
 *
 * The two details that make this fail silently if they are wrong: codes are
 * packed LEAST significant bit first, and the code width grows the moment the
 * dictionary reaches the next power of two - not one code later. Both produce a
 * file that every decoder accepts and renders as noise.
 */
export function lzwEncode(indexed, minimumCodeSize) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map();

  const output = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const reset = () => {
    dictionary = new Map();
    codeSize = minimumCodeSize + 1;
    nextCode = endCode + 1;
  };

  emit(clearCode);
  reset();

  let current = indexed[0];
  for (let index = 1; index < indexed.length; index += 1) {
    const next = indexed[index];
    const key = current * 4096 + next;
    const found = dictionary.get(key);
    if (found !== undefined) {
      current = found;
      continue;
    }

    emit(current);
    if (nextCode < 4096) {
      dictionary.set(key, nextCode);
      nextCode += 1;
      // Grows AT the power of two, not after it.
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      emit(clearCode);
      reset();
    }
    current = next;
  }

  emit(current);
  emit(endCode);
  if (bitCount > 0) output.push(bitBuffer & 0xff);

  return Uint8Array.from(output);
}

/* ----------------------------------------------------------- the writer -- */

class Bytes {
  constructor() {
    this.parts = [];
  }
  byte(value) {
    this.parts.push(Uint8Array.of(value & 0xff));
    return this;
  }
  short(value) {
    // Little endian, which every multi-byte field in GIF uses.
    this.parts.push(Uint8Array.of(value & 0xff, (value >> 8) & 0xff));
    return this;
  }
  text(value) {
    this.parts.push(new TextEncoder().encode(value));
    return this;
  }
  raw(value) {
    this.parts.push(value);
    return this;
  }
  build() {
    let length = 0;
    for (const part of this.parts) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** GIF data is carried in sub-blocks of at most 255 bytes, terminated by zero. */
function subBlocks(data) {
  const out = new Bytes();
  for (let at = 0; at < data.length; at += 255) {
    const chunk = data.subarray(at, Math.min(at + 255, data.length));
    out.byte(chunk.length).raw(chunk);
  }
  return out.byte(0).build();
}

/**
 * Write an animated GIF.
 *
 * Every frame carries its OWN palette in a local colour table. A single global
 * table across a walkthrough would have to cover the light theme, the dark
 * theme and every accent in one 256-entry budget, and the result is a recording
 * where half the frames look wrong.
 *
 * @param {{width: number, height: number, delayMs: number,
 *          frames: Uint8ClampedArray[]}} options RGBA frames.
 */
export function encodeGif({ width, height, delayMs, frames }) {
  if (frames.length === 0) throw new Error('a GIF needs at least one frame');

  const out = new Bytes();
  out.text('GIF89a').short(width).short(height);

  // No global colour table: the flag byte says so, and every frame brings its
  // own below.
  out.byte(0x70).byte(0).byte(0);

  // The looping extension. Without it the recording plays once and stops on a
  // frame nobody chose.
  out
    .byte(0x21)
    .byte(0xff)
    .byte(11)
    .text('NETSCAPE2.0')
    .byte(3)
    .byte(1)
    .short(0)
    .byte(0);

  // GIF counts delay in hundredths of a second, and a zero delay means "as fast
  // as possible" in most viewers - which is not a recording, it is a flicker.
  const delay = Math.max(2, Math.round(delayMs / 10));

  for (const frame of frames) {
    if (frame.length !== width * height * 4) {
      throw new Error(
        'a frame is ' + frame.length + ' bytes, expected ' + width * height * 4,
      );
    }

    const palette = quantize(frame);
    const indexed = indexPixels(frame, palette);

    // The table size is a power of two, and the header stores its log minus one.
    let bits = 1;
    while (1 << bits < palette.length) bits += 1;
    if (bits > 8) bits = 8;
    const tableSize = 1 << bits;

    out.byte(0x21).byte(0xf9).byte(4).byte(0x04).short(delay).byte(0).byte(0);

    out
      .byte(0x2c)
      .short(0)
      .short(0)
      .short(width)
      .short(height)
      .byte(0x80 | (bits - 1));

    const table = new Uint8Array(tableSize * 3);
    palette.forEach((colour, index) => {
      table[index * 3] = colour[0];
      table[index * 3 + 1] = colour[1];
      table[index * 3 + 2] = colour[2];
    });
    out.raw(table);

    // The minimum code size must be at least 2: a one-bit code size is legal in
    // the spec and rejected by real decoders.
    const minimumCodeSize = Math.max(2, bits);
    out.byte(minimumCodeSize).raw(subBlocks(lzwEncode(indexed, minimumCodeSize)));
  }

  out.byte(0x3b);
  return out.build();
}

/* ------------------------------------------------------------- reading -- */

/**
 * Count the frames in a GIF by WALKING it, not by scanning for a byte pair.
 *
 * Scanning for the graphic-control introducer is the obvious way and it is
 * wrong: those two bytes occur inside compressed image data and inside colour
 * tables all the time. It reported 39 frames in a 33-frame recording, which is
 * the sort of wrong that reads as a real defect and sends somebody looking for
 * a bug in the encoder.
 */
export function countGifFrames(bytes) {
  if (bytes.length < 13) throw new Error('too short to be a GIF');
  if (String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF') throw new Error('not a GIF');

  let at = 10;
  const globalFlags = bytes[at];
  at += 3;
  if (globalFlags & 0x80) at += 3 * (1 << ((globalFlags & 0x07) + 1));

  const skipSubBlocks = () => {
    for (;;) {
      const length = bytes[at];
      at += 1;
      if (length === 0) return;
      at += length;
    }
  };

  let frames = 0;
  while (at < bytes.length) {
    const introducer = bytes[at];
    at += 1;

    if (introducer === 0x3b) break;

    if (introducer === 0x21) {
      at += 1;
      skipSubBlocks();
      continue;
    }

    if (introducer === 0x2c) {
      frames += 1;
      // Left, top, width, height, then the flags byte.
      at += 8;
      const flags = bytes[at];
      at += 1;
      if (flags & 0x80) at += 3 * (1 << ((flags & 0x07) + 1));
      // The minimum code size, then the image data.
      at += 1;
      skipSubBlocks();
      continue;
    }

    throw new Error('unknown block 0x' + introducer.toString(16) + ' at ' + (at - 1));
  }

  return frames;
}
