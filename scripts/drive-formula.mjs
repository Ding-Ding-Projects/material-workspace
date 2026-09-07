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

  // -------------------------------------------------------------- tables --

  // Sources are assembled from character codes rather than written as escapes.
  // A backslash handed to the page through a template literal is eaten before
  // the page sees it, and a matrix source that loses its backslashes is not a
  // syntax error - it is a completely different formula that still parses.
  const bs = String.fromCharCode(92);
  const rowBreak = bs + bs;
  const table = (name, body) =>
    bs + 'begin{' + name + '} ' + body + ' ' + bs + 'end{' + name + '}';

  await type(table('pmatrix', 'a & b ' + rowBreak + ' c & d'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  check(
    'a matrix renders as a real mtable with two rows and four cells',
    await evaluate(`
      (() => {
        const math = document.querySelector('.formula__preview math');
        return [
          math.querySelectorAll('mtable').length,
          math.querySelectorAll('mtr').length,
          math.querySelectorAll('mtd').length,
        ];
      })()
    `),
    [1, 2, 4],
  );

  check(
    // Without stretchy the bracket stays one line tall beside a two-line
    // matrix, which reads as a rendering fault rather than a missing attribute.
    'its brackets are real stretchy fences, not two characters in a cell',
    await evaluate(`
      (() => {
        const fences = [...document.querySelectorAll('.formula__preview mo[fence="true"]')];
        return [
          fences.length,
          fences.map(node => node.textContent).join(''),
          fences.every(node => node.getAttribute('stretchy') === 'true'),
        ];
      })()
    `),
    [2, '()', true],
  );

  check(
    // The reading is what a screen reader gets. Cell by cell it is a stream of
    // letters with no way to tell where a row ended.
    'the spoken reading names the shape and then the rows',
    await evaluate(`
      (() => {
        const spoken = document.querySelector('.formula__spoken').textContent || '';
        return [
          spoken.includes('2 by 2 matrix'),
          spoken.includes('row 1'),
          spoken.includes('row 2'),
        ];
      })()
    `),
    [true, true, true],
  );

  await type(table('aligned', 'a &= b ' + rowBreak + ' c &= d'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  check(
    // The alternation IS the feature. Centre the columns instead and the equals
    // signs do not line up, which is the only reason to reach for it.
    'aligned equations line up right then left, and carry no brackets',
    await evaluate(`
      (() => {
        const math = document.querySelector('.formula__preview math');
        const mtable = math.querySelector('mtable');
        return [
          mtable.getAttribute('columnalign'),
          math.querySelectorAll('mo[fence="true"]').length,
        ];
      })()
    `),
    ['right left', 0],
  );

  await type(table('cases', 'x & if a ' + rowBreak + ' y'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  check(
    // The missing right brace is the notation. Adding one changes what the
    // formula says, so a renderer that pairs them up is wrong.
    'a cases block opens with one brace and closes with none',
    await evaluate(`
      (() => {
        const fences = [...document.querySelectorAll('.formula__preview mo[fence="true"]')];
        return [fences.length, fences.map(node => node.textContent).join('')];
      })()
    `),
    [1, '{'],
  );

  check(
    // Padding is right here - a cases block really does mix one-cell and
    // two-cell rows - but saying nothing about it means a matrix a cell short
    // silently becomes a plausible matrix nobody wrote.
    'a short row is padded, and the status line SAYS it was',
    await evaluate(`
      (() => {
        const status = document.querySelector('.formula__status').textContent || '';
        const cells = document.querySelectorAll('.formula__preview mtd').length;
        return [cells, status.includes('short row'), status.includes('padded')];
      })()
    `),
    [4, true, true],
  );

  await type(table('pmatrix', 'a & b ' + rowBreak + ' c & d'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  check(
    'and a square table says nothing about padding, so the warning still means something',
    await evaluate(
      '(document.querySelector(".formula__status").textContent || "").includes("short row")',
    ),
    false,
  );

  check(
    // A refusal that names the environments a person can actually use, rather
    // than rendering an empty row and dropping everything they typed.
    'an unknown environment is refused by name, and lists the real ones',
    await (async () => {
      await type(table('smallmatrix', 'a'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return evaluate(`
        (() => {
          const problem = document.querySelector('.formula__problem').textContent || '';
          return [
            problem.includes('smallmatrix'),
            problem.includes('pmatrix'),
            problem.includes('cases'),
          ];
        })()
      `);
    })(),
    [true, true, true],
  );

  check(
    // Four buttons that write a matrix somebody can then edit, rather than
    // requiring the syntax to be known before the feature can be found at all.
    'the palette offers the tables, each with a readable name',
    await evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.formula__insert')];
        const names = buttons.map(node => node.getAttribute('aria-label'));
        return [
          names.includes('Insert Matrix'),
          names.includes('Insert Cases'),
          names.includes('Insert Aligned equations'),
          names.includes('Insert Determinant'),
        ];
      })()
    `),
    [true, true, true, true],
  );

  check(
    'pressing the matrix button leaves something that actually renders',
    await (async () => {
      await type('');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await evaluate(`
        (() => {
          const button = [...document.querySelectorAll('.formula__insert')]
            .find(node => node.getAttribute('aria-label') === 'Insert Matrix');
          button.click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 350));
      return evaluate(`
        (() => {
          const math = document.querySelector('.formula__preview math');
          const problem = document.querySelector('.formula__problem');
          return [
            math === null ? 0 : math.querySelectorAll('mtd').length,
            problem.getAttribute('data-shown'),
          ];
        })()
      `);
    })(),
    [4, 'false'],
  );

  check(
    // MEASURED, not read off the attribute. stretchy="true" is a request, and
    // whether it is honoured depends on the font actually having the larger
    // glyph variants - so a bracket can carry the attribute and still render
    // one line tall beside a two-line matrix.
    'the brackets really do grow to the height of the matrix',
    await (async () => {
      await type(table('pmatrix', 'a & b ' + rowBreak + ' c & d'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      return evaluate(`
        (() => {
          const fence = document.querySelector('.formula__preview mo[fence="true"]');
          const table = document.querySelector('.formula__preview mtable');
          const tall = table.getBoundingClientRect().height;
          const bracket = fence.getBoundingClientRect().height;
          return [tall > 20, bracket >= tall * 0.8];
        })()
      `);
    })(),
    [true, true],
  );

  await capture('54-formula-tables');

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
