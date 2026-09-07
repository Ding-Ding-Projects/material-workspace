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
    // The outline sits above every SHAPE, and the handles above the outline.
    // This check used to assert the outline was the very last node, and it went
    // red the moment handles were added - correctly, because handles under the
    // outline would be covered by it.
    'the outline is above every shape, and the handles above the outline',
    await evaluate(`
      (() => {
        const nodes = [...document.querySelector('.draw__canvas').children];
        const classOf = (node) => node.getAttribute('class');
        const lastShape = nodes.map(classOf).lastIndexOf('draw__shape');
        const outline = nodes.map(classOf).indexOf('draw__selection');
        const firstHandle = nodes.map(classOf).indexOf('draw__handle');
        return [outline > lastShape, firstHandle > outline];
      })()
    `),
    [true, true],
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

  // ------------------------------------------------- handles and booleans --

  // Handles, measured on the real canvas. A handle that is stored and never
  // drawn is the wired-at-one-end defect; a handle drawn in the wrong place is
  // worse, because a drag then moves the shape somewhere nobody aimed.

  // Two OVERLAPPING rectangles, drawn here rather than relying on whatever the
  // earlier checks left behind - a test that depends on leftovers breaks the
  // day somebody reorders the file, for a reason that looks unrelated.
  await evaluate(`
    (() => {
      const rect = [...document.querySelectorAll('.draw__tool')]
        .find(tool => tool.getAttribute('data-tool') === 'rectangle');
      if (rect) rect.click();
      return true;
    })()
  `);
  await drag(60, 60, 200, 180);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await evaluate(`
    (() => {
      const rect = [...document.querySelectorAll('.draw__tool')]
        .find(tool => tool.getAttribute('data-tool') === 'rectangle');
      if (rect) rect.click();
      return true;
    })()
  `);
  await drag(140, 120, 280, 240);
  await new Promise((resolve) => setTimeout(resolve, 350));

  check(
    'a selected shape gets eight resize handles and one to rotate',
    await evaluate(`
      (() => {
        const handles = [...document.querySelectorAll('.draw__handle')];
        const names = handles.map(handle => handle.getAttribute('data-handle'));
        return [
          handles.length,
          names.includes('rotate'),
          names.includes('bottomRight'),
          names.includes('left'),
        ];
      })()
    `),
    [9, true, true, true],
  );

  check(
    // The cursor says what a drag will do BEFORE the drag, which is the only
    // moment it helps. A handle with no accessible name does not exist for
    // anybody using a screen reader.
    'every handle carries its own cursor and its own name',
    await evaluate(`
      (() => {
        const handles = [...document.querySelectorAll('.draw__handle')];
        return [
          handles.every(handle => (handle.getAttribute('style') || '').includes('cursor:')),
          handles.every(handle => (handle.getAttribute('aria-label') || '').length > 5),
        ];
      })()
    `),
    [true, true],
  );

  check(
    // Above the shape, clear of the corners: otherwise it is a coin toss which
    // one the pointer catches.
    'the rotate handle is above the shape, not on a corner',
    await evaluate(`
      (() => {
        const rotate = document.querySelector('.draw__handle[data-handle="rotate"]');
        const corner = document.querySelector('.draw__handle[data-handle="topLeft"]');
        return Number(rotate.getAttribute('y')) < Number(corner.getAttribute('y'));
      })()
    `),
    true,
  );

  check(
    // Hiding them makes a locked shape look unselected. What the lock does is
    // refuse the drag, and it says why when it does.
    'a locked shape still SHOWS its handles, marked as locked',
    await (async () => {
      await evaluate(`
        (() => {
          const row = document.querySelector('.draw__layer');
          row.querySelector('[data-toggle="locked"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await evaluate(`
        (() => {
          const handles = [...document.querySelectorAll('.draw__handle')];
          return [
            handles.length,
            handles.every(handle => handle.getAttribute('data-locked') === 'true'),
            handles.every(handle => (handle.getAttribute('style') || '').includes('not-allowed')),
          ];
        })()
      `);
      // Unlocked again, so the rest of the run starts where it expects to.
      await evaluate(`
        (() => {
          document.querySelector('.draw__layer [data-toggle="locked"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return result;
    })(),
    [9, true, true],
  );

  await capture('52-draw-handles');

  // The booleans. Two overlapping rectangles, marked, then combined.

  await evaluate(`
    (() => {
      document.querySelector('[data-action="select-all"]').click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const markedCount = await evaluate(
    'document.querySelectorAll(`.draw__layer[data-marked="yes"]`).length',
  );

  check(
    // Two, not "the selection": a boolean of three shapes has an order and the
    // order changes the answer, so asking for two is honest rather than
    // picking one silently.
    'combining anything other than two shapes is refused, and says how many are marked',
    await (async () => {
      if (markedCount === 2) return [true, true];
      await evaluate(`
        (() => {
          document.querySelector('[data-action="union"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return evaluate(`
        (() => {
          const status = document.querySelector('.draw__status').textContent || '';
          return [status.includes('exactly two'), status.includes(String(${markedCount}))];
        })()
      `);
    })(),
    [true, true],
  );

  check(
    'two marked shapes union into one, and the layer list says so',
    await (async () => {
      // Clear the marks, then mark two rows ONE AT A TIME. Each click
      // re-renders the layer list, so a loop over a list captured beforehand
      // clicks a node that is no longer in the document and marks one shape -
      // which is exactly what this driver caught the first time it ran.
      await evaluate(`
        (() => {
          document.querySelector('[data-action="select-all"]').click();
          document.querySelector('[data-action="invert"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const ids = await evaluate(
        '[...document.querySelectorAll(".draw__layer")].slice(0, 2).map(row => row.getAttribute("data-shape"))',
      );
      for (const id of ids) {
        await evaluate(
          'document.querySelector(`.draw__layer[data-shape="' +
            id +
            '"] .draw__layer-mark`).click()',
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      check(
        'marking two rows one at a time really does mark two',
        await evaluate('document.querySelectorAll(`.draw__layer[data-marked="yes"]`).length'),
        2,
      );

      const before = await evaluate('document.querySelectorAll(".draw__layer").length');
      await evaluate(`
        (() => {
          document.querySelector('[data-action="union"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));

      return evaluate(`
        (() => {
          const after = document.querySelectorAll('.draw__layer').length;
          const names = [...document.querySelectorAll('.draw__layer-name')]
            .map(node => node.textContent);
          const status = document.querySelector('.draw__status').textContent || '';
          return [
            after < ${before},
            names.some(name => name === 'Union' || (name || '').startsWith('Piece')),
            status.length > 10,
          ];
        })()
      `);
    })(),
    [true, true, true],
  );

  check(
    // Counting shapes and reading the status line both passed against a walk
    // that produced a self-crossing tangle. The AREA is what caught it, so the
    // driver measures the geometry the application actually drew rather than
    // trusting that one shape means the right shape.
    'the union really is an L-shape: eight corners, and no edge crossing another',
    await evaluate(`
      (() => {
        const node = document.querySelector('polyline.draw__shape');
        const points = (node.getAttribute('points') || '')
          // Split on a literal space, NOT on a whitespace class: a backslash
          // inside this template literal is eaten before the page ever sees it,
          // so the class arrives as the letter s and matches nothing.
          .trim().split(' ').filter(Boolean)
          .map(pair => pair.split(',').map(Number))
          .map(([x, y]) => ({ x, y }));

        let twice = 0;
        for (let i = 0; i < points.length; i += 1) {
          const a = points[i];
          const b = points[(i + 1) % points.length];
          twice += a.x * b.y - b.x * a.y;
        }

        const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        let crossing = false;
        for (let i = 0; i < points.length; i += 1) {
          for (let j = i + 2; j < points.length; j += 1) {
            if (i === 0 && j === points.length - 1) continue;
            const a = points[i], b = points[(i + 1) % points.length];
            const c = points[j], d = points[(j + 1) % points.length];
            if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) {
              crossing = true;
            }
          }
        }

        return [points.length, crossing, Math.abs(twice / 2) > 0];
      })()
    `),
    [8, false, true],
  );

  await capture('53-draw-boolean');

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
