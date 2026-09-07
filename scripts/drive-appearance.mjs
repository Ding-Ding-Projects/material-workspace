#!/usr/bin/env node
/**
 * Drive Appearance and the colour picker in the built application.
 *
 * The checks lean on the two things that are normally decorative here: that
 * the field is reachable WITHOUT a pointer, and that the translator's rows are
 * real values rather than a static example. Both look identical in a
 * screenshot to versions that do nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[appearance] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[appearance] FAILED: ' + message + '\n');
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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1400));

  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  await evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('[role="tab"], .tab')]
        .find(t => (t.textContent ?? '').includes('Appearance'));
      if (tab) { tab.click(); return true; }
      return false;
    })()
  `);
  await waitFor('!!document.querySelector(".picker")', 'the colour picker');

  // ---------------------------------------------------------- translator --

  check(
    'every notation is listed, not a favourite few',
    await evaluate(`document.querySelectorAll('.picker-notation').length`),
    14,
  );

  check(
    'the notations that are not CSS are marked as such',
    await evaluate(`
      [...document.querySelectorAll('.picker-notation')]
        .filter(n => n.querySelector('.picker-not-css'))
        .map(n => n.firstElementChild.textContent)
        .sort()
    `),
    ['cmyk', 'hsv'],
  );

  // A STATIC EXAMPLE WOULD LOOK IDENTICAL IN A SCREENSHOT. So the value is
  // changed and the rows are asserted to follow.
  await evaluate(`
    (() => {
      const entry = document.querySelector('.picker-entry');
      entry.value = 'rebeccapurple';
      entry.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);

  check(
    'entering a named colour resolves it in every notation',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.picker-translation .picker-value')]
          .map(v => v.textContent);
        return [rows[0], rows[1], rows[3]];
      })()
    `),
    ['rebeccapurple', '#663399', 'rgb(102 51 153)'],
  );

  check(
    'the contrast readout names a ratio and a verdict, not a colour alone',
    await evaluate(`
      (() => {
        const row = document.querySelector('.picker-contrast');
        return [
          row.dataset.verdict,
          /\\d+(\\.\\d+)?:1/.test(row.textContent ?? ''),
        ];
      })()
    `),
    ['AAA', true],
  );

  await capture('30-appearance-picker');

  // ------------------------------------------------------------ refusal --

  await evaluate(`
    (() => {
      const entry = document.querySelector('.picker-entry');
      entry.value = 'not a colour at all';
      entry.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);

  check(
    'unreadable input is reported inline rather than guessed at',
    await evaluate(`!document.querySelector('.picker-entry-error').hidden`),
    true,
  );

  check(
    'and what was typed is left alone rather than wiped',
    await evaluate(`document.querySelector('.picker-entry').value`),
    'not a colour at all',
  );

  check(
    'the colour itself did not move because of an unreadable entry',
    await evaluate(
      `[...document.querySelectorAll('.picker-translation .picker-value')][1].textContent`,
    ),
    '#663399',
  );

  await capture('31-appearance-refused');

  // ----------------------------------------------------------- keyboard --

  // THE CHECK THAT MATTERS MOST. A two-dimensional field driven only by a
  // pointer is unreachable for anybody who cannot use one, and it looks
  // completely correct in every screenshot.
  const before = await evaluate(
    `[...document.querySelectorAll('.picker-translation .picker-value')][1].textContent`,
  );

  await evaluate(`
    (() => {
      const field = document.querySelector('.picker-field');
      field.focus();
      for (let i = 0; i < 5; i += 1) {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      }
      return true;
    })()
  `);

  const after = await evaluate(
    `[...document.querySelectorAll('.picker-translation .picker-value')][1].textContent`,
  );

  check('the field responds to the arrow keys', after !== before, true);

  check(
    'the field is focusable and describes itself to a screen reader',
    await evaluate(`
      (() => {
        const field = document.querySelector('.picker-field');
        return [
          field.getAttribute('tabindex'),
          (field.getAttribute('aria-label') ?? '').includes('Arrow keys'),
        ];
      })()
    `),
    ['0', true],
  );

  // ------------------------------------------------------------ rainbow --

  await evaluate(`
    (() => {
      const toggle = document.querySelector('.picker-rainbow-toggle');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);

  // Asks what RENDERS, not what the attribute says. The first version of this
  // check read `.hidden` and passed while the row was permanently on screen,
  // because an explicit `display` in the stylesheet beats the browser's own
  // `[hidden] { display: none }`. Found by looking at a capture.
  check(
    'the speed control is hidden until the rainbow is chosen, and then shown',
    await evaluate(`
      (() => {
        const row = document.querySelector('.picker-speed-row');
        const toggle = document.querySelector('.picker-rainbow-toggle');
        const shown = () => getComputedStyle(row).display !== 'none';

        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        const whenOff = shown();

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        return [whenOff, shown()];
      })()
    `),
    [false, true],
  );

  check(
    'the speed readout states the real duration rather than a bare level',
    await evaluate(
      `/one full cycle every \\d+(\\.\\d+)?s/.test(document.querySelector('.picker-speed-readout').textContent ?? '')`,
    ),
    true,
  );

  check(
    'the accent line says what the rainbow does under reduced motion',
    await evaluate(
      `(document.querySelector('.appearance-current')?.textContent ?? '').includes('settles on a single colour')`,
    ),
    true,
  );

  // MEASURED, NOT ASSUMED, because this environment lies about it.
  //
  // In headless off-screen Electron the style engine resolves
  // `prefers-reduced-motion: reduce` as TRUE while `window.matchMedia` reports
  // FALSE - verified with a probe element the application never styles, which
  // came back clamped to 0.001s and one iteration. So every capture taken this
  // way shows the REDUCED-MOTION presentation, and a check that demanded
  // `infinite` would fail on correct code, for ever, in CI only.
  //
  // What is asserted instead is the thing that must hold either way: the
  // animation is WIRED to the stylesheet rather than repainted by a timer, and
  // the presentation matches whichever state is actually in force.
  const motion = await evaluate(`
    (() => {
      const probe = document.createElement('div');
      probe.style.animation = 'picker-rainbow 9s linear infinite';
      document.body.append(probe);
      const clamped = getComputedStyle(probe).animationIterationCount === '1';
      probe.remove();

      const preview = document.querySelector('.picker-preview');
      const style = getComputedStyle(preview);
      return {
        clamped,
        rainbow: preview.dataset.rainbow,
        name: style.animationName,
        iteration: style.animationIterationCount,
      };
    })()
  `);

  check(
    'the preview is animated by the stylesheet, not repainted by a timer',
    [motion.rainbow, motion.name],
    ['yes', 'picker-rainbow'],
  );

  check(
    motion.clamped
      ? 'under reduced motion it settles rather than cycling'
      : 'with motion allowed it cycles without end',
    motion.iteration,
    motion.clamped ? '1' : 'infinite',
  );

  await capture('32-appearance-rainbow');

  // ------------------------------------------------------ accessibility --

  check(
    'the sliders and the entry all have labels bound to them',
    await evaluate(`
      (() => {
        const ids = ['picker-hue', 'picker-alpha', 'picker-entry', 'picker-rainbow', 'picker-speed'];
        return ids.every(id =>
          !!document.querySelector('label[for="' + id + '"]') && !!document.getElementById(id));
      })()
    `),
    true,
  );

  check(
    'every copy button says which notation it copies',
    await evaluate(`
      [...document.querySelectorAll('.picker-copy')]
        .every(b => /^Copy the \\S+ form$/.test(b.getAttribute('aria-label') ?? ''))
    `),
    true,
  );

  check(
    'nothing on the surface overflows its own container',
    await evaluate(`
      (() => {
        const root = document.querySelector('.appearance');
        const box = root.getBoundingClientRect();
        return [...root.querySelectorAll('.picker-main, .picker-translations, .appearance-current')]
          .every(node => {
            const r = node.getBoundingClientRect();
            return r.right <= box.right + 1 && r.left >= box.left - 1;
          });
      })()
    `),
    true,
  );

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
