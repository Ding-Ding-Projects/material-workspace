#!/usr/bin/env node
/**
 * Drive Formula in the built application.
 *
 * The checks that matter most are the accessibility ones: an equation editor
 * whose output cannot be read aloud has failed at the one thing that
 * distinguishes it from a drawing of a formula.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[formula] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[formula] FAILED: ' + message + '\n');
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

  const type = (value) =>
    evaluate(`
      (() => {
        const node = document.querySelector('.formula__input');
        node.focus();
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event('input', { bubbles: true }));
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
    'Formula is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="formula"]\')?.getAttribute("data-available")',
    ),
    'true',
  );

  await click('.app-card[data-application="formula"]');
  await waitFor('!!document.querySelector(".formula__input")', 'the editor');

  check(
    'the empty state says so rather than showing a blank box',
    await evaluate('document.querySelector(".formula__empty")?.textContent'),
    'Nothing typed yet.',
  );

  // ------------------------------------------------------------ rendering --

  await type('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}');
  await waitFor('!!document.querySelector(".formula__preview math")', 'the rendered formula');

  check(
    'the preview is real MathML in the document, not an image or a string',
    await evaluate(`
      (() => {
        const math = document.querySelector('.formula__preview math');
        if (!math) return null;
        return [
          math.namespaceURI,
          math.querySelectorAll('mfrac').length,
          math.querySelectorAll('msqrt').length,
          math.querySelectorAll('msup').length,
        ];
      })()
    `),
    ['http://www.w3.org/1998/Math/MathML', 1, 1, 1],
  );

  check(
    // The element chosen for each part is what decides how a screen reader
    // speaks it. mi for everything renders identically and reads as nonsense.
    'numbers are mn, variables are mi and operators are mo',
    await evaluate(`
      (() => {
        const math = document.querySelector('.formula__preview math');
        return [
          math.querySelectorAll('mn').length > 0,
          math.querySelectorAll('mi').length > 0,
          math.querySelectorAll('mo').length > 0,
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    // Shown, not hidden in an attribute: it is the only part of an equation
    // editor a person who cannot see the rendering can verify.
    'the spoken reading is SHOWN and reads as mathematics',
    await evaluate(`
      (() => {
        const text = document.querySelector('.formula__spoken')?.textContent ?? '';
        return [
          text.includes('the fraction with numerator'),
          text.includes('the square root of'),
          text.includes('to the power'),
        ];
      })()
    `),
    [true, true, true],
  );

  // ------------------------------------------------------- half-typed input --

  await type('\\frac{a');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'a half-typed formula says WHAT is wrong, not just that something is',
    await evaluate(`
      (() => {
        const problem = document.querySelector('.formula__problem');
        return [
          problem?.getAttribute('data-shown'),
          (problem?.textContent ?? '').length > 10,
        ];
      })()
    `),
    ['true', true],
  );

  check(
    // Clearing it would make the preview flicker empty on nearly every
    // keystroke, because most partial input is invalid.
    'and the previous rendering stays on screen rather than flickering away',
    await evaluate('!!document.querySelector(".formula__preview math")'),
    true,
  );

  // ------------------------------------------------------------- palette --

  await type('');
  await new Promise((resolve) => setTimeout(resolve, 150));

  check(
    // A button reading only a backslash command is unreadable aloud and
    // meaningless to anybody who does not already know the notation.
    'palette buttons are named by what they MEAN, with the source as a tooltip',
    await evaluate(`
      (() => {
        const button = document.querySelector('.formula__insert[data-insert="\\\\\\\\frac{a}{b}"]')
          ?? document.querySelector('.formula__insert');
        return [
          button?.textContent,
          (button?.getAttribute('aria-label') ?? '').startsWith('Insert '),
          (button?.getAttribute('title') ?? '').includes('frac'),
        ];
      })()
    `),
    ['Fraction', true, true],
  );

  // Insert at the caret, not at the end.
  await type('1 + 1');
  await evaluate(`
    (() => {
      const input = document.querySelector('.formula__input');
      input.focus();
      // Caret between the two ones.
      input.setSelectionRange(4, 4);
      return true;
    })()
  `);
  await click('.formula__insert[data-insert="\\\\alpha"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    // Appending is what a palette usually does and it is wrong: somebody who
    // put the caret in the middle wants the symbol there.
    'inserting puts the symbol at the caret, not at the end',
    await evaluate('document.querySelector(".formula__input")?.value'),
    '1 + \\alpha1',
  );

  // ------------------------------------------------------------ examples --

  await evaluate(`
    (() => {
      const select = document.querySelector('.formula__examples');
      select.value = select.options[2].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    'document.querySelectorAll(".formula__preview math munderover").length > 0',
    'the sum example',
  );
  check(
    // A sum whose bounds sit beside it is a different, and wrong, piece of
    // notation.
    'a sum renders with its limits above and below, not beside',
    await evaluate(
      'document.querySelectorAll(".formula__preview math munderover").length',
    ),
    1,
  );

  check(
    'and the example selector resets so the same one can be chosen twice',
    await evaluate('document.querySelector(".formula__examples")?.value'),
    '',
  );

  // ------------------------------------------------------- display toggle --

  await click('.formula__action[data-action="display"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'block display is applied to the real element and announced',
    await evaluate(`
      (() => {
        const math = document.querySelector('.formula__preview math');
        const button = document.querySelector('.formula__action[data-action="display"]');
        return [math?.getAttribute('display'), button?.getAttribute('aria-pressed')];
      })()
    `),
    ['block', 'true'],
  );

  // -------------------------------------------------------------- export --

  await evaluate(`
    (() => {
      window.__mathmlBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__mathmlBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.formula__action[data-action="export"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__mathmlBlob', 'the export');

  await evaluate(`
    (() => {
      window.__mathmlText = null;
      window.__mathmlBlob.text().then((text) => { window.__mathmlText = text; });
      return true;
    })()
  `);
  await waitFor('window.__mathmlText !== null', 'the exported text');
  check(
    'the export is MathML carrying its own accessible description',
    await evaluate(`
      (() => {
        const text = window.__mathmlText;
        return [
          text.startsWith('<math '),
          text.includes('xmlns="http://www.w3.org/1998/Math/MathML"'),
          text.includes('aria-label="the sum'),
        ];
      })()
    `),
    [true, true, true],
  );

  // ------------------------------------------------------------ geometry --

  check(
    'the toolbar and status line stay within the window',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const t = document.querySelector('.formula__toolbar').getBoundingClientRect();
        const s = document.querySelector('.formula__status').getBoundingClientRect();
        return t.top >= 0 && t.bottom <= h && s.bottom <= h + 1;
      })()
    `),
    true,
  );

  check(
    'every control meets the touch-target height',
    await evaluate(`
      (() => {
        const target = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--workspace-touch-target'),
        ) || 48;
        return [...document.querySelectorAll('.formula__action, .formula__examples, .formula__insert')]
          .every(b => b.getBoundingClientRect().height >= target - 1);
      })()
    `),
    true,
  );

  await capture('21-formula');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
