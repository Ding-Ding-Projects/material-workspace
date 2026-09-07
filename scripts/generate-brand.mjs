#!/usr/bin/env node
/**
 * Generate the application mark and the link-embed graphic.
 *
 * Both are produced from code rather than checked in as opaque binaries, so the
 * design is reviewable in a diff, reproducible on any machine, and cannot
 * silently become a raster of the wrong format wearing an .ico extension.
 *
 * The mark: three stacked sheets fanned to the right, in the Material primary,
 * secondary and tertiary roles, on a rounded container. It reads as "documents,
 * more than one" at 256 pixels and still reads as a coloured stack at 16, which
 * is where a Windows icon actually spends its life.
 *
 * Outputs:
 *   assets/icon.ico          multi-resolution, 16 through 256
 *   assets/icon.png          512, for the installer and the site
 *   docs/images/logo.png     256, for documentation
 *   social-preview.png       1280x640 at the REPOSITORY ROOT
 *
 * The social preview goes to the root deliberately. GitHub's social-preview
 * upload cannot be scripted, so the last step is always a person opening a
 * folder and dragging an image in — and a path four directories deep turns that
 * into a hunt, which is a step that quietly does not happen.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Raster, encodeIco, encodePng } from './lib/raster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Material roles, matching the token layer the application actually renders.
const SURFACE = [18, 20, 24];
const PRIMARY = [179, 197, 255];
const SECONDARY = [193, 197, 221];
const TERTIARY = [226, 187, 219];
const ON_SURFACE = [227, 226, 233];
const CONTAINER = [50, 69, 120];

/** Draw the mark at a given size into a fresh raster. */
function drawMark(size, { background = true } = {}) {
  const raster = new Raster(size, size);
  const unit = size / 100;

  if (background) {
    raster.roundedRect(0, 0, size, size, 22 * unit, CONTAINER, 1);
  }

  // Three fanned sheets, back to front, so the front one overlaps cleanly.
  const sheets = [
    { x: 22, y: 20, colour: TERTIARY, alpha: 0.85 },
    { x: 30, y: 26, colour: SECONDARY, alpha: 0.92 },
    { x: 38, y: 32, colour: PRIMARY, alpha: 1 },
  ];

  for (const sheet of sheets) {
    raster.roundedRect(
      sheet.x * unit,
      sheet.y * unit,
      34 * unit,
      44 * unit,
      4 * unit,
      sheet.colour,
      sheet.alpha,
    );
  }

  // Three text rules on the front sheet, so it reads as a document rather than
  // a plain rectangle. Dropped below 32 pixels, where they would smear into a
  // grey band and make the mark less legible rather than more.
  if (size >= 32) {
    const front = sheets[2];
    for (let line = 0; line < 3; line += 1) {
      raster.roundedRect(
        (front.x + 6) * unit,
        (front.y + 10 + line * 8) * unit,
        (22 - line * 5) * unit,
        2.5 * unit,
        1.25 * unit,
        CONTAINER,
        0.55,
      );
    }
  }

  return raster;
}

function write(relativePath, buffer) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  process.stdout.write(
    '[brand] ' + relativePath + ' (' + buffer.length.toLocaleString('en-GB') + ' bytes)\n',
  );
}

/* ------------------------------------------------------------------- icons */

// Drawn once at high resolution and downscaled, so every size shares exactly
// one design rather than drifting apart as somebody tweaks one of them.
const master = drawMark(512);
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const iconRasters = ICON_SIZES.map((size) =>
  size === 512 ? master : drawMark(size >= 32 ? size : size, {}),
);

write('assets/icon.ico', encodeIco(iconRasters));
write('assets/icon.png', encodePng(master));
write('docs/images/logo.png', encodePng(master.resized(256)));

/* ---------------------------------------------------------- social preview */

/**
 * 1280x640 is GitHub's recommended social-preview size. A link is how a project
 * is introduced to people, and most of them see it for the first time in a chat
 * window — a bare grey card is a first impression thrown away.
 */
const preview = new Raster(1280, 640);
preview.fill(SURFACE);

// A soft container panel so the mark is not floating on flat black.
preview.roundedRect(64, 64, 1152, 512, 32, [30, 31, 37], 1);

// The mark, large, on the left.
const markSize = 288;
const mark = drawMark(markSize);
for (let y = 0; y < markSize; y += 1) {
  for (let x = 0; x < markSize; x += 1) {
    const index = (y * markSize + x) * 4;
    const alpha = mark.data[index + 3] / 255;
    if (alpha <= 0) continue;
    preview.blend(
      144 + x,
      176 + y,
      [mark.data[index], mark.data[index + 1], mark.data[index + 2]],
      alpha,
    );
  }
}

/**
 * Wordmark, drawn as geometry rather than text.
 *
 * There is no font here and no font is fetched, so the letters are built from
 * rectangles and polygons. That is deliberate: a remote font would be a network
 * dependency in a build step, and a bundled font would be a licence to track for
 * the sake of two words.
 */
const GLYPHS = {
  M: (r, x, y, w, h, c) => {
    const t = w * 0.2;
    r.roundedRect(x, y, t, h, t / 2, c);
    r.roundedRect(x + w - t, y, t, h, t / 2, c);
    r.polygon(
      [
        [x + t * 0.6, y],
        [x + t * 1.6, y],
        [x + w / 2, y + h * 0.62],
        [x + w / 2 - t * 0.5, y + h * 0.62],
      ],
      c,
    );
    r.polygon(
      [
        [x + w - t * 1.6, y],
        [x + w - t * 0.6, y],
        [x + w / 2 + t * 0.5, y + h * 0.62],
        [x + w / 2, y + h * 0.62],
      ],
      c,
    );
  },
  W: (r, x, y, w, h, c) => {
    const t = w * 0.18;
    r.polygon(
      [
        [x, y],
        [x + t, y],
        [x + w * 0.32, y + h],
        [x + w * 0.32 - t, y + h],
      ],
      c,
    );
    r.polygon(
      [
        [x + w * 0.32 - t, y + h],
        [x + w * 0.32, y + h],
        [x + w * 0.5 + t / 2, y],
        [x + w * 0.5 - t / 2, y],
      ],
      c,
    );
    r.polygon(
      [
        [x + w * 0.5 - t / 2, y],
        [x + w * 0.5 + t / 2, y],
        [x + w * 0.68 + t, y + h],
        [x + w * 0.68, y + h],
      ],
      c,
    );
    r.polygon(
      [
        [x + w * 0.68, y + h],
        [x + w * 0.68 + t, y + h],
        [x + w, y],
        [x + w - t, y],
      ],
      c,
    );
  },
};

// "MW" as the wordmark, at a size that stays legible in a chat-window thumbnail.
GLYPHS.M(preview, 520, 220, 150, 150, ON_SURFACE);
GLYPHS.W(preview, 700, 220, 170, 150, PRIMARY);

// A rule and a tagline block beneath, drawn as bars rather than text so the
// image needs no font at all. It reads as a title and a subtitle.
preview.roundedRect(520, 400, 560, 10, 5, PRIMARY, 0.9);
preview.roundedRect(520, 430, 420, 8, 4, ON_SURFACE, 0.45);
preview.roundedRect(520, 452, 330, 8, 4, ON_SURFACE, 0.3);

write('social-preview.png', encodePng(preview));

process.stdout.write('[brand] done\n');
