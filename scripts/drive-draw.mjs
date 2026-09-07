#!/usr/bin/env node
/**
 * Drive Draw in the built application.
 *
 * Shapes are created by real pointer events at real coordinates, so this
 * exercises the screen-to-drawing mapping — which is the part that silently
 * puts every shape in the wrong place when the window is a different size.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[draw] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[draw] FAILED: ' + message + '\n');
  process.exit(1);
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ label, ok });
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  actual=' + JSON.stringify(actual)));
}

async function main() {
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  if (targets.length !== 1 || targets[0].type !== 'page') {
    fail('expected exactly one page target, found ' + targets.length);
  }

  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
  });

  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 30_000);
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        socket.removeEventListener('message', listener);
        clearTimeout(timer);
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

  const waitFor = async (expression, description, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 120));
    }
    fail('timed out waiting for ' + description);
  };

  const capture = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, name + '.png'), Buffer.from(shot.data, 'base64'));
    log('captured ' + name + '.png');
  };

  const click = (selector) =>
    evaluate('document.querySelector(' + JSON.stringify(selector) + ').click(); true');

  /**
   * Drag on the canvas in DRAWING coordinates.
   *
   * Converted to client coordinates here, the same way the application
   * converts back, so the round trip through the mapping is what is being
   * exercised rather than a set of numbers chosen to agree with it.
   */
  const drag = (fromX, fromY, toX, toY) =>
    evaluate(`
      (() => {
        const svg = document.querySelector('.draw__canvas');
        const box = svg.getBoundingClientRect();
        const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
        const toClient = (x, y) => ({
          clientX: box.left + (x / viewBox[2]) * box.width,
          clientY: box.top + (y / viewBox[3]) * box.height,
        });
        const down = toClient(${fromX}, ${fromY});
        const move = toClient(${toX}, ${toY});
        const options = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
        svg.dispatchEvent(new PointerEvent('pointerdown', { ...options, ...down }));
        svg.dispatchEvent(new PointerEvent('pointermove', { ...options, ...move }));
        svg.dispatchEvent(new PointerEvent('pointerup', { ...options, ...move }));
        return true;
      })()
    `);

  const key = (keyName, options = {}) =>
    evaluate(`
      (() => {
        const svg = document.querySelector('.draw__canvas');
        svg.focus();
        svg.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(keyName)},
          shiftKey: ${options.shift === true},
          bubbles: true, cancelable: true,
        }));
        return true;
      })()
    `);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1400));

  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  check(
    'Draw is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="draw"]\')?.getAttribute("data-available")',
    ),
    'true',
  );

  await click('.app-card[data-application="draw"]');
  await waitFor('!!document.querySelector(".draw__canvas")', 'the canvas');

  check(
    'the empty state says what to do rather than showing a blank panel',
    await evaluate('document.querySelector(".draw__empty")?.textContent'),
    'No shapes yet. Choose a tool and drag on the canvas.',
  );

  // ------------------------------------------------------------- drawing --

  await click('.draw__tool[data-tool="rectangle"]');
  check(
    'the active tool is announced, not only coloured',
    await evaluate(
      'document.querySelector(\'.draw__tool[data-tool="rectangle"]\')?.getAttribute("aria-pressed")',
    ),
    'true',
  );

  await drag(100, 100, 300, 220);
  await waitFor('!!document.querySelector(".draw__shape")', 'a shape');

  check(
    'dragging creates a shape at the dragged position, through the real mapping',
    await evaluate(`
      (() => {
        const rect = document.querySelector('.draw__shape[data-kind="rectangle"]');
        if (!rect) return null;
        return [
          Math.round(Number(rect.getAttribute('width'))),
          Math.round(Number(rect.getAttribute('height'))),
          rect.getAttribute('transform'),
        ];
      })()
    `),
    [200, 120, 'matrix(1 0 0 1 100 100)'],
  );

  check(
    // Position lives in the transform, not in the geometry, so the size the
    // user dragged stays the size the shape reports after it is moved.
    //
    // Matched on the pieces rather than on one exact string: the first version
    // pinned the run of spaces between them and failed on a difference of one
    // space, which says nothing about whether the numbers are right.
    'the status line reports its real position and size',
    await evaluate(`
      (() => {
        const text = document.querySelector('.draw__status')?.textContent ?? '';
        return ['Rectangle', '100, 100', '200 by 120'].every(part => text.includes(part));
      })()
    `),
    true,
  );

  check(
    'the tool returns to Select after drawing one shape',
    await evaluate(
      'document.querySelector(\'.draw__tool[data-tool="select"]\')?.getAttribute("aria-pressed")',
    ),
    'true',
  );

  // A second shape, an ellipse, using the keyboard shortcut for the tool.
  await key('e');
  await drag(350, 120, 480, 220);
  await waitFor(
    'document.querySelectorAll(".draw__shape").length === 2',
    'the second shape',
  );

  check(
    'a keyboard shortcut selects a tool',
    await evaluate('document.querySelectorAll(\'.draw__shape[data-kind="ellipse"]\').length'),
    1,
  );

  check(
    'an unfilled shape would not become a solid block: fill is always explicit',
    await evaluate(`
      [...document.querySelectorAll('.draw__shape')].every(s => s.hasAttribute('fill'))
    `),
    true,
  );

  // ----------------------------------------------------------- selection --

  // Click the rectangle. Hit testing runs in the model, so this proves the
  // inverse transform and the containment test, not SVG's own picking.
  await drag(150, 150, 150, 150);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'clicking inside a shape selects it',
    await evaluate(
      '(document.querySelector(".draw__status")?.textContent ?? "").includes("Rectangle")',
    ),
    true,
  );
  check(
    'and a selection outline is drawn on top of everything',
    await evaluate(`
      (() => {
        const nodes = [...document.querySelector('.draw__canvas').children];
        return nodes[nodes.length - 1].getAttribute('class') === 'draw__selection';
      })()
    `),
    true,
  );

  // Clicking empty space clears it.
  await drag(700, 400, 700, 400);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'clicking empty canvas clears the selection',
    await evaluate('document.querySelectorAll(".draw__selection").length'),
    0,
  );

  // --------------------------------------------------------------- nudge --

  await drag(150, 150, 150, 150);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await key('ArrowRight', { shift: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    // The only way to position something precisely when a pointer snaps to
    // whole pixels.
    'shift and an arrow key nudge the selection by ten',
    await evaluate(
      '(document.querySelector(".draw__status")?.textContent ?? "").includes("110, 100")',
    ),
    true,
  );

  // ------------------------------------------------------ layers and locks --

  check(
    'the shape list runs front to back, matching what is on screen',
    await evaluate(
      '[...document.querySelectorAll(".draw__layer-name")].map(n => n.textContent)',
    ),
    ['Ellipse', 'Rectangle'],
  );

  check(
    // An eye and a padlock are invisible to a screen reader and ambiguous to
    // anybody who has not used this application before.
    'hidden and locked are stated in words',
    // Selected by what each control IS, never by position. The first version
    // took the first two toggles by index and broke the moment a mark button
    // was added ahead of them, which says nothing about whether the words are
    // there.
    await evaluate(`
      (() => {
        const row = document.querySelector('.draw__layer');
        return ['hidden', 'locked'].map(
          (which) => row.querySelector('[data-toggle="' + which + '"]').textContent,
        );
      })()
    `),
    ['Visible', 'Unlocked'],
  );

  // Lock the rectangle, then try to delete it.
  await evaluate(`
    (() => {
      const layers = [...document.querySelectorAll('.draw__layer')];
      const rect = layers.find(l => (l.textContent ?? '').includes('Rectangle'));
      rect.querySelector('[data-toggle="locked"]').click();
      return true;
    })()
  `);
  await waitFor(
    '[...document.querySelectorAll(".draw__layer-toggle")].some(t => t.textContent === "Locked")',
    'the lock',
  );

  await evaluate(`
    (() => {
      const layers = [...document.querySelectorAll('.draw__layer')];
      const rect = layers.find(l => (l.textContent ?? '').includes('Rectangle'));
      rect.click();
      return true;
    })()
  `);
  await click('.draw__action[data-action="delete"]');
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'a locked shape refuses to be deleted, and says why',
    await evaluate(`
      [
        document.querySelectorAll('.draw__layer').length,
        (document.querySelector('.draw__status')?.textContent ?? '').includes('locked'),
      ]
    `),
    [2, true],
  );

  // Hiding removes it from the canvas but not from the drawing.
  await evaluate(`
    (() => {
      const layers = [...document.querySelectorAll('.draw__layer')];
      const rect = layers.find(l => (l.textContent ?? '').includes('Rectangle'));
      rect.querySelector('[data-toggle="hidden"]').click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'a hidden shape leaves the canvas but stays in the drawing',
    await evaluate(`
      [
        document.querySelectorAll('.draw__shape').length,
        document.querySelectorAll('.draw__layer').length,
      ]
    `),
    [1, 2],
  );

  // ------------------------------------------------------------- ordering --

  await evaluate(`
    (() => {
      const layers = [...document.querySelectorAll('.draw__layer')];
      const ellipse = layers.find(l => (l.textContent ?? '').includes('Ellipse'));
      ellipse.click();
      return true;
    })()
  `);
  await click('.draw__action[data-arrange="back"]');
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'sending to back reorders the list',
    await evaluate(
      '[...document.querySelectorAll(".draw__layer-name")].map(n => n.textContent)',
    ),
    ['Rectangle', 'Ellipse'],
  );

  // -------------------------------------------------------------- export --

  await evaluate(`
    (() => {
      window.__svgBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__svgBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.draw__action[data-action="export"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__svgBlob', 'the export');

  check(
    'the export reports that a hidden shape was not included',
    await evaluate(
      '(document.querySelector(".draw__status")?.textContent ?? "").includes("hidden shape was not included")',
    ),
    true,
  );

  await evaluate(`
    (() => {
      window.__svgText = null;
      window.__svgBlob.text().then((text) => { window.__svgText = text; });
      return true;
    })()
  `);
  await waitFor('window.__svgText !== null', 'the exported text');
  check(
    'and the SVG is real SVG carrying the transform',
    await evaluate(`
      (() => {
        const svg = window.__svgText;
        return [
          svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'),
          svg.includes('<ellipse'),
          svg.includes('matrix('),
          // The hidden rectangle must not be in the file.
          !svg.includes('<rect'),
        ];
      })()
    `),
    [true, true, true, true],
  );

  // ------------------------------------------------------------ in bulk --

  // Every list carries bulk actions. Deleting shapes one at a time is the
  // application failing to do its job.

  await click('[data-action="select-all"]');
  check(
    'select-all marks every layer, and says so in words rather than by tint',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.draw__layer')];
        return [
          rows.length > 1,
          rows.every(r => r.getAttribute('data-marked') === 'yes'),
          rows.every(r => r.querySelector('.draw__layer-mark').getAttribute('aria-pressed') === 'true'),
        ];
      })()
    `),
    [true, true, true],
  );

  await click('[data-action="invert"]');
  check(
    'inverting leaves nothing marked when everything was',
    await evaluate(`document.querySelectorAll('.draw__layer[data-marked="yes"]').length`),
    0,
  );

  await click('[data-action="select-all"]');
  await click('[data-action="delete-marked"]');
  check(
    // A locked shape is KEPT and named, rather than silently skipped. A bulk
    // action that quietly drops items is indistinguishable from one that failed.
    'a bulk delete keeps what it may not touch and names the reason',
    await evaluate(`
      (() => {
        const status = document.querySelector('.draw__status').textContent || '';
        return [
          document.querySelectorAll('.draw__layer').length,
          /kept/.test(status),
          /locked/.test(status),
        ];
      })()
    `),
    [1, true, true],
  );

  // ------------------------------------------------------------ geometry --

  check(
    'the toolbar and status line stay within the window',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const t = document.querySelector('.draw__toolbar').getBoundingClientRect();
        const s = document.querySelector('.draw__status').getBoundingClientRect();
        return t.top >= 0 && t.bottom <= h && s.bottom <= h + 1;
      })()
    `),
    true,
  );

  check(
    'every tool and swatch meets the touch-target size',
    await evaluate(`
      (() => {
        const target = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--workspace-touch-target'),
        ) || 48;
        return [...document.querySelectorAll('.draw__tool, .draw__action, .draw__swatch')]
          .every(b => {
            const r = b.getBoundingClientRect();
            return r.height >= target - 1;
          });
      })()
    `),
    true,
  );

  await capture('20-draw');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
