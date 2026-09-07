#!/usr/bin/env node
/**
 * Drive Forms in the built application.
 *
 * The check that matters most is that Design and Fill agree: the value of a
 * form builder is that what you designed is what people see, and a preview
 * that differs tells you the form is fine right up until somebody uses it.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[forms] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[forms] FAILED: ' + message + '\n');
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

  const setField = (selector, value) =>
    evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        node.focus();
        if (node.type === 'checkbox') node.checked = ${JSON.stringify(value)};
        else node.value = ${JSON.stringify(String(value))};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
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
    'Forms is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="forms"]\')?.getAttribute("data-available")',
    ),
    'true',
  );

  await click('.app-card[data-application="forms"]');
  await waitFor('!!document.querySelector(".forms__panel")', 'the designer');

  check(
    'the three modes are real tabs and Design is the current one',
    await evaluate(`
      (() => {
        const modes = [...document.querySelectorAll('.forms__mode')];
        return [
          modes.map(m => m.getAttribute('data-mode')),
          modes.find(m => m.getAttribute('aria-selected') === 'true')?.getAttribute('data-mode'),
        ];
      })()
    `),
    [['design', 'fill', 'results'], 'design'],
  );

  check(
    'the sample form opens with three fields',
    await evaluate('document.querySelectorAll(".forms__field-card").length'),
    3,
  );

  // ------------------------------------------------ design and fill agree --

  await click('.forms__mode[data-mode="fill"]');
  await waitFor('!!document.querySelector(".forms__fill")', 'the fill view');

  check(
    // The whole value of a form builder is that what you designed is what
    // people see. A preview that differs tells you the form is fine right up
    // until somebody uses it.
    'every designed field appears in Fill, in the same order',
    await evaluate(`
      [...document.querySelectorAll('.forms__fill-label')]
        .map(l => l.childNodes[0]?.textContent)
    `),
    ['Your name', 'Rating out of five', 'Best dish'],
  );

  check(
    // Somebody who does not know what a field wants fills it in wrongly and
    // then blames themselves.
    'help text is always rendered, and referenced by the field',
    await evaluate(`
      (() => {
        const input = document.querySelector('[data-answer="rating"]');
        const described = input?.getAttribute('aria-describedby') ?? '';
        const help = document.getElementById(described.split(' ')[0]);
        return [(help?.textContent ?? '').includes('whole number from 1 to 5'), described.length > 0];
      })()
    `),
    [true, true],
  );

  check(
    // An asterisk means nothing until somebody finds the legend, and a screen
    // reader announces it as "star".
    'required is stated as a WORD, not an asterisk',
    await evaluate(`
      (() => {
        const marks = [...document.querySelectorAll('.forms__required')].map(m => m.textContent);
        const input = document.querySelector('[data-answer="rating"]');
        return [marks, input?.getAttribute('aria-required')];
      })()
    `),
    [['required'], 'true'],
  );

  check(
    // Without it the first option is silently pre-selected and becomes an
    // answer nobody gave.
    'an optional choice offers an explicit no-answer option',
    await evaluate(`
      (() => {
        const select = document.querySelector('[data-answer="dish"]');
        return [select?.options[0]?.value, select?.options[0]?.textContent, select?.value];
      })()
    `),
    ['', 'No answer', ''],
  );

  // ----------------------------------------------------------- validation --

  await setField('[data-answer="rating"]', '9');
  await click('.forms__fill button[type="submit"]');
  await waitFor('!!document.querySelector(".forms__problem")', 'the problem');

  check(
    'a value outside the range is refused, saying the bound',
    await evaluate(
      '(document.querySelector(".forms__problem")?.textContent ?? "").includes("at most 5")',
    ),
    true,
  );

  check(
    'the problem is tied to its field for assistive technology',
    await evaluate(`
      (() => {
        const input = document.querySelector('[data-answer="rating"]');
        const described = (input?.getAttribute('aria-describedby') ?? '').split(' ');
        const problem = described.map(id => document.getElementById(id)).find(n => n?.classList.contains('forms__problem'));
        return [input?.getAttribute('aria-invalid'), problem !== undefined];
      })()
    `),
    ['true', true],
  );

  check(
    'and nothing was submitted',
    await evaluate(
      '(document.querySelector(".forms__status")?.textContent ?? "").includes("0 responses")',
    ),
    true,
  );

  // A required field left blank.
  await setField('[data-answer="rating"]', '');
  await click('.forms__fill button[type="submit"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'a required field left blank is refused',
    await evaluate(
      '(document.querySelector(".forms__problem")?.textContent ?? "").includes("is required")',
    ),
    true,
  );

  // A valid submission.
  await setField('[data-answer="name"]', 'Ada');
  await setField('[data-answer="rating"]', '5');
  await setField('[data-answer="dish"]', 'Har gow');
  await click('.forms__fill button[type="submit"]');
  await waitFor(
    '(document.querySelector(".forms__status")?.textContent ?? "").includes("1 response")',
    'the submission',
  );

  check(
    'a valid answer is submitted and the form is cleared for the next one',
    await evaluate(`
      [
        document.querySelectorAll('.forms__problem').length,
        document.querySelector('[data-answer="name"]')?.value,
      ]
    `),
    [0, ''],
  );

  // One more, with the optional fields skipped.
  await setField('[data-answer="rating"]', '3');
  await click('.forms__fill button[type="submit"]');
  await waitFor(
    '(document.querySelector(".forms__status")?.textContent ?? "").includes("2 responses")',
    'the second submission',
  );

  // -------------------------------------------------------------- results --

  await click('.forms__mode[data-mode="results"]');
  await waitFor('!!document.querySelector(".forms__results")', 'the results');

  check(
    // A blank cell and a cell somebody deliberately left blank are different
    // facts, and a table that renders both as nothing loses the difference.
    'a skipped answer is SHOWN as not answered rather than left blank',
    await evaluate(`
      (() => {
        const skipped = [...document.querySelectorAll('[data-skipped="true"]')];
        return [skipped.length, skipped[0]?.textContent];
      })()
    `),
    [2, 'not answered'],
  );

  check(
    'the summary says how many answered each field',
    await evaluate(
      '[...document.querySelectorAll(".forms__summary-count")].map(c => c.textContent?.split("  ")[0])',
    ),
    ['1 of 2', '2 of 2', '1 of 2'],
  );

  // -------------------------------------------------------------- export --

  await evaluate(`
    (() => {
      window.__formsBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__formsBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.forms__action[data-action="export"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__formsBlob', 'the export');

  await evaluate(`
    (() => {
      window.__formsText = null;
      window.__formsBlob.text().then((text) => { window.__formsText = text; });
      return true;
    })()
  `);
  await waitFor('window.__formsText !== null', 'the exported text');
  check(
    // Internal identifiers would produce a file nobody can interpret without
    // the form beside it.
    'the export uses the field LABELS as its header',
    await evaluate(`
      (() => {
        const text = window.__formsText;
        return [
          text.split('\\r\\n')[0],
          text.includes('Ada,5,Har gow'),
        ];
      })()
    `),
    ['Submitted at,Your name,Rating out of five,Best dish', true],
  );

  // ---------------------------------------------------- designing changes --

  await click('.forms__mode[data-mode="design"]');
  await waitFor('!!document.querySelector(".forms__field-card")', 'the designer');

  await click('.forms__action[data-action="add:choice"]');
  await waitFor('document.querySelectorAll(".forms__field-card").length === 4', 'the new field');

  // A choice with no options cannot be answered, and that is the FORM's fault.
  await evaluate(`
    (() => {
      const cards = [...document.querySelectorAll('.forms__field-card')];
      const last = cards[cards.length - 1];
      const options = last.querySelector('[data-property="options"]');
      options.value = '';
      options.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    'document.querySelector(".forms__warnings")?.getAttribute("data-shown") === "true"',
    'the definition warning',
  );
  check(
    'a choice with no options is reported to whoever is BUILDING the form',
    await evaluate(
      '(document.querySelector(".forms__warnings")?.textContent ?? "").includes("no options")',
    ),
    true,
  );

  // Two fields with the same label are indistinguishable in the results.
  await evaluate(`
    (() => {
      const cards = [...document.querySelectorAll('.forms__field-card')];
      const last = cards[cards.length - 1];
      const label = last.querySelector('[data-property="label"]');
      label.value = 'Your name';
      label.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'two fields with the same label are reported',
    await evaluate(
      '(document.querySelector(".forms__warnings")?.textContent ?? "").includes("both labelled")',
    ),
    true,
  );

  // ------------------------------------------------------------- in bulk --

  // Back to the designer: bulk work on fields belongs where the fields are.
  await click('.forms__mode[data-mode="design"]');
  await click('[data-action="mark-all"]');
  check(
    'marking every field is carried by a pressed control and counted in words',
    await evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.forms__field-card')];
        const status = document.querySelector('.forms__status').textContent || '';
        return [
          cards.length > 1,
          cards.every(c => c.querySelector('.forms__mark').getAttribute('aria-pressed') === 'true'),
          status.includes(cards.length + ' fields marked'),
        ];
      })()
    `),
    [true, true, true],
  );

  await click('[data-action="invert"]');
  check(
    'inverting a full selection leaves nothing marked',
    await evaluate('document.querySelectorAll(`.forms__mark[aria-pressed="true"]`).length'),
    0,
  );

  check(
    'removing nothing says so rather than opening a gate over an empty set',
    await (async () => {
      await click('[data-action="remove-marked"]');
      await new Promise((resolve) => setTimeout(resolve, 200));
      return evaluate(`
        [
          document.querySelector('.gate') === null,
          (document.querySelector('.forms__status').textContent || '').includes('Nothing is selected'),
        ]
      `);
    })(),
    [true, true],
  );

  // Mark one field by clicking its own control, then take it out.
  await evaluate(`
    (() => {
      document.querySelector('.forms__field-card .forms__mark').click();
      return true;
    })()
  `);
  await click('[data-action="remove-marked"]');
  check(
    'removing marked fields opens the two-key gate and names what goes',
    await evaluate(`
      (() => {
        const gate = document.querySelector('.gate');
        if (!gate) return null;
        return [
          (gate.querySelector('.gate__affected').textContent || '').includes('1 item will be removed'),
          gate.querySelector('.gate__irreversible').textContent.includes('Answers'),
          gate.querySelector('.gate__action').disabled,
        ];
      })()
    `),
    [true, true, true],
  );

  const before = await evaluate('document.querySelectorAll(`.forms__field-card`).length');
  await evaluate(`
    (() => {
      for (const box of document.querySelectorAll('.gate__key input')) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const slider = document.querySelector('.gate__slider');
      slider.value = slider.max;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await click('.gate__action');
  check(
    'and the field really goes',
    await evaluate('document.querySelectorAll(`.forms__field-card`).length'),
    before - 1,
  );

  await capture('23-forms');

  // ------------------------------------------------------------ geometry --

  check(
    'the mode bar and status line stay within the window',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const m = document.querySelector('.forms__modes').getBoundingClientRect();
        const s = document.querySelector('.forms__status').getBoundingClientRect();
        return m.top >= 0 && m.bottom <= h && s.bottom <= h + 1;
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
        return [...document.querySelectorAll('.forms__mode, .forms__action')]
          .every(b => b.getBoundingClientRect().height >= target - 1);
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
