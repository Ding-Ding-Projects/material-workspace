/**
 * Record the application actually running, and commit the result.
 *
 * A gallery of stills proves a surface exists. Only a recording proves the
 * thing MOVES - that a control responds, that a wizard advances, that a long
 * operation reports progress instead of hanging. Half the defects worth
 * catching are invisible in a still, because a still cannot tell a working
 * control from a decorative one.
 *
 * PRIVACY, WHICH IS THE PART THAT MATTERS. This never records the screen. It
 * asks the application's own renderer for its own pixels, over the debugging
 * protocol, while that renderer sits on an off-screen desktop. Whatever is on
 * the visible desktop is never touched, never captured and never in the file.
 *
 * HOW THE PIXELS BECOME A GIF WITHOUT A DEPENDENCY. The frames arrive as
 * base64 PNG. Decoding PNG in Node would mean writing a decoder or installing
 * one, so each frame is handed BACK to the page, which decodes it with the
 * browser's own decoder into a canvas, and the encoder runs there too. Only the
 * finished GIF comes back across the wire.
 */

import { build } from 'esbuild';

import { countGifFrames } from './gif-encoder.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const port = process.argv[2] ?? '9333';
const output = process.argv[3] ?? path.join(ROOT, 'docs', 'images', 'walkthrough.gif');

const log = (message) => process.stdout.write('[record] ' + message + '\n');
const fail = (message) => {
  process.stderr.write('[record] FAILED: ' + message + '\n');
  process.exit(1);
};

/**
 * The walkthrough.
 *
 * The real path a person takes, not a curated highlight: opening the
 * application, reaching the main surfaces, and completing one genuine task end
 * to end. An empty state is worth recording too - it is what most people meet
 * first.
 */
const STEPS = [
  { label: 'the front screen', tab: 'home', hold: 3 },
  { label: 'the writer, empty', tab: 'writer', hold: 2 },
  {
    label: 'typing into it',
    type: { selector: '.writer__input', text: 'A document, written and saved as it goes.' },
    hold: 3,
  },
  { label: 'the spreadsheet', tab: 'sheets', hold: 2 },
  { label: 'drawing', tab: 'draw', hold: 2 },
  { label: 'the database', tab: 'database', hold: 2 },
  { label: 'appearance', tab: 'appearance', hold: 3 },
  { label: 'settings', tab: 'settings', hold: 2 },
  { label: 'back home', tab: 'home', hold: 3 },
];

async function main() {
  // The encoder is a module; the page needs it as one script it can run. esbuild
  // is already a dependency of this project, so no new one is added to make a
  // recording.
  const bundle = path.join(ROOT, '.tmp', 'gif-encoder.iife.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  // Through the API rather than the CLI: spawning npx on Windows fails with
  // EINVAL from a Node script, and the project already depends on esbuild.
  await build({
    entryPoints: [path.join(ROOT, 'scripts', 'gif-encoder.mjs')],
    bundle: true,
    format: 'iife',
    globalName: 'GifEncoder',
    outfile: bundle,
  });
  const encoderSource = fs.readFileSync(bundle, 'utf8');
  log('encoder bundled');

  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const pages = targets.filter((target) => target.type === 'page');
  if (pages.length !== 1) fail('expected exactly one page target, saw ' + pages.length);
  log('one page target confirmed');

  const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not connect')), { once: true });
  });

  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        socket.removeEventListener('message', listener);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  };

  const waitFor = async (expression, description, timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error('timed out waiting for ' + description);
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // A fixed size, so the recording is the same shape every time it is remade and
  // a diff of the file means something. Small enough that the GIF stays a file
  // Git is happy to carry.
  const WIDTH = 900;
  const HEIGHT = 600;
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  // The encoder, and the frame store, live in the page.
  await evaluate(
    encoderSource +
      ';window.__frames = [];' +
      'window.__addFrame = (dataUrl) => new Promise((resolve) => {' +
      '  const image = new Image();' +
      '  image.onload = () => {' +
      '    const canvas = document.createElement("canvas");' +
      '    canvas.width = ' + WIDTH + '; canvas.height = ' + HEIGHT + ';' +
      '    const context = canvas.getContext("2d");' +
      '    context.drawImage(image, 0, 0, ' + WIDTH + ', ' + HEIGHT + ');' +
      '    window.__frames.push(context.getImageData(0, 0, ' + WIDTH + ', ' + HEIGHT + ').data);' +
      '    resolve(true);' +
      '  };' +
      '  image.src = dataUrl;' +
      '});' +
      'true',
  );

  const shoot = async () => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    // Handed back to the page rather than decoded here: the browser already has
    // a PNG decoder, and writing a second one to avoid one round trip would be
    // a lot of code for nothing.
    await evaluate(
      'window.__frameDone = false;' +
        'window.__addFrame("data:image/png;base64,' + shot.data + '").then(() => {' +
        '  window.__frameDone = true;' +
        '}); true',
    );
    await waitFor('window.__frameDone === true', 'the frame to decode');
  };

  let taken = 0;
  for (const step of STEPS) {
    if (step.tab !== undefined) {
      await evaluate(`
        (() => {
          const tab = [...document.querySelectorAll('[role="tab"]')]
            .find(t => t.getAttribute('data-tab') === ${JSON.stringify(step.tab)});
          if (tab) tab.click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    if (step.type !== undefined) {
      // Typed a character at a time, because the point of a recording is that
      // the text APPEARS rather than arriving all at once like a paste.
      for (let at = 1; at <= step.type.text.length; at += 4) {
        await evaluate(`
          (() => {
            const node = document.querySelector(${JSON.stringify(step.type.selector)});
            if (!node) return false;
            node.focus();
            node.value = ${JSON.stringify(step.type.text)}.slice(0, ${at});
            node.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()
        `);
        await shoot();
        taken += 1;
      }
    }

    // Held for a few frames, so a viewer has time to read the surface rather
    // than watching a slideshow at four frames a second.
    for (let frame = 0; frame < (step.hold ?? 2); frame += 1) {
      await shoot();
      taken += 1;
    }
    log(step.label + ' (' + taken + ' frames)');
  }

  log('encoding ' + taken + ' frames');
  await evaluate(
    'window.__gif = null;' +
      'window.__gifError = null;' +
      'try {' +
      '  const bytes = GifEncoder.encodeGif({' +
      '    width: ' + WIDTH + ', height: ' + HEIGHT + ', delayMs: 400, frames: window.__frames });' +
      '  let binary = "";' +
      '  for (let at = 0; at < bytes.length; at += 8192) {' +
      '    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 8192));' +
      '  }' +
      '  window.__gif = btoa(binary);' +
      '} catch (error) { window.__gifError = String(error && error.message ? error.message : error); }' +
      'true',
  );

  const error = await evaluate('window.__gifError');
  if (error) fail('the encoder threw: ' + error);

  const base64 = await evaluate('window.__gif');
  if (typeof base64 !== 'string' || base64.length === 0) fail('the encoder produced nothing');

  const bytes = Buffer.from(base64, 'base64');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);

  // Read it back rather than trusting the write. A recording nobody has opened
  // is a file, not a recording.
  const written = fs.readFileSync(output);
  if (written.length !== bytes.length) fail('the file on disk is a different size');
  if (written.subarray(0, 6).toString('latin1') !== 'GIF89a') fail('that is not a GIF');
  if (written[written.length - 1] !== 0x3b) fail('the GIF has no trailer, so it is truncated');

  // Counted by walking the structure. Scanning for the graphic-control bytes
  // reported 39 frames in a 33-frame recording, because those two bytes occur
  // inside compressed image data all the time.
  const frames = countGifFrames(written);
  if (frames !== taken) fail('wrote ' + frames + ' frames, recorded ' + taken);

  await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  socket.close();

  log('');
  log('wrote ' + output);
  log(
    frames + ' frames, ' + WIDTH + 'x' + HEIGHT + ', ' +
      (written.length / 1024 / 1024).toFixed(2) + ' MB',
  );
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
