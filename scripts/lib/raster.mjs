/**
 * A tiny RGBA raster with a PNG and ICO encoder.
 *
 * No dependency. Everything here uses node:zlib and a few hundred lines of
 * arithmetic, which is cheaper than adding an image library to the build for the
 * sake of generating four files.
 *
 * The application mark is GENERATED rather than checked in as an opaque binary,
 * so it is reviewable in a diff, reproducible, and cannot silently become a
 * renamed file of the wrong format. A raster merely renamed to .ico is a real
 * release blocker elsewhere, and this removes the possibility.
 */

import zlib from 'node:zlib';

/* ------------------------------------------------------------------ raster */

export class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4, 0);
  }

  /** Alpha-composite a colour over the existing pixel. */
  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0) return;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const a = Math.min(1, alpha);
    const existingAlpha = this.data[index + 3] / 255;
    const outAlpha = a + existingAlpha * (1 - a);
    if (outAlpha <= 0) return;
    for (let channel = 0; channel < 3; channel += 1) {
      const source = [r, g, b][channel];
      const destination = this.data[index + channel];
      this.data[index + channel] = Math.round(
        (source * a + destination * existingAlpha * (1 - a)) / outAlpha,
      );
    }
    this.data[index + 3] = Math.round(outAlpha * 255);
  }

  fill(colour) {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) this.blend(x, y, colour, 1);
    }
  }

  /**
   * A rounded rectangle, antialiased by sampling the signed distance to the
   * shape. Antialiasing is not decoration here: at 16 pixels an aliased mark
   * reads as a smear, and 16 pixels is where a Windows icon spends most of its
   * life.
   */
  roundedRect(left, top, width, height, radius, colour, alpha = 1) {
    const right = left + width;
    const bottom = top + height;
    const r = Math.min(radius, width / 2, height / 2);

    for (let y = Math.floor(top) - 1; y <= Math.ceil(bottom) + 1; y += 1) {
      for (let x = Math.floor(left) - 1; x <= Math.ceil(right) + 1; x += 1) {
        // Sample at the pixel centre.
        const px = x + 0.5;
        const py = y + 0.5;

        // Distance from the rounded-rectangle boundary.
        const dx = Math.max(left + r - px, 0, px - (right - r));
        const dy = Math.max(top + r - py, 0, py - (bottom - r));
        const distance = Math.sqrt(dx * dx + dy * dy) - r;

        // One-pixel linear ramp across the edge.
        const coverage = Math.min(1, Math.max(0, 0.5 - distance));
        if (coverage > 0) this.blend(x, y, colour, coverage * alpha);
      }
    }
  }

  /** A filled convex polygon, sampled with the same one-pixel edge ramp. */
  polygon(points, colour, alpha = 1) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.floor(Math.min(...xs)) - 1;
    const maxX = Math.ceil(Math.max(...xs)) + 1;
    const minY = Math.floor(Math.min(...ys)) - 1;
    const maxY = Math.ceil(Math.max(...ys)) + 1;

    const SAMPLES = 4;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy += 1) {
          for (let sx = 0; sx < SAMPLES; sx += 1) {
            const px = x + (sx + 0.5) / SAMPLES;
            const py = y + (sy + 0.5) / SAMPLES;
            if (pointInPolygon(px, py, points)) hits += 1;
          }
        }
        const coverage = hits / (SAMPLES * SAMPLES);
        if (coverage > 0) this.blend(x, y, colour, coverage * alpha);
      }
    }
  }

  /** Nearest-neighbour-free box downscale, so small icons stay legible. */
  resized(size) {
    const out = new Raster(size, size);
    const scale = this.width / size;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        const x0 = Math.floor(x * scale);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
        const y0 = Math.floor(y * scale);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
        for (let sy = y0; sy < y1 && sy < this.height; sy += 1) {
          for (let sx = x0; sx < x1 && sx < this.width; sx += 1) {
            const index = (sy * this.width + sx) * 4;
            const alpha = this.data[index + 3] / 255;
            r += this.data[index] * alpha;
            g += this.data[index + 1] * alpha;
            b += this.data[index + 2] * alpha;
            a += alpha;
            count += 1;
          }
        }
        if (count === 0) continue;
        const outIndex = (y * size + x) * 4;
        const averageAlpha = a / count;
        if (averageAlpha > 0) {
          out.data[outIndex] = Math.round(r / a);
          out.data[outIndex + 1] = Math.round(g / a);
          out.data[outIndex + 2] = Math.round(b / a);
        }
        out.data[outIndex + 3] = Math.round(averageAlpha * 255);
      }
    }
    return out;
  }
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* --------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, body])), 0);
  return Buffer.concat([length, typeBuffer, body, crc]);
}

export function encodePng(raster) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Filter byte 0 (none) per scanline. Simple, and the images are small enough
  // that a smarter filter would save bytes nobody is counting.
  const stride = raster.width * 4;
  const raw = Buffer.alloc((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raster.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------------- ICO */

/**
 * A genuine multi-resolution ICO container with PNG-encoded entries.
 *
 * Windows Vista and later read PNG entries at every size. The width and height
 * bytes are 0 for 256, which is the one piece of this format that surprises
 * people.
 */
export function encodeIco(rasters) {
  const images = rasters.map((raster) => ({ raster, png: encodePng(raster) }));

  const directory = Buffer.alloc(6);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(images.length, 4);

  const ENTRY_SIZE = 16;
  let offset = directory.length + images.length * ENTRY_SIZE;
  const entries = [];

  for (const image of images) {
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry[0] = image.raster.width >= 256 ? 0 : image.raster.width;
    entry[1] = image.raster.height >= 256 ? 0 : image.raster.height;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.png.length;
  }

  return Buffer.concat([directory, ...entries, ...images.map((image) => image.png)]);
}
