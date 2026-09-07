#!/usr/bin/env node
/**
 * Drive Writer in the built application.
 *
 * Everything here goes through a real user path: the application card is
 * clicked, and text arrives through the same `beforeinput` event a keystroke
 * produces. Calling the editor's methods directly would prove the methods and
 * nothing about whether a key press reaches them.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[writer] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[writer] FAILED: ' + message + '\n');
  process.exit(1);
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ label, ok, actual, expected });
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

  // Start from a known state rather than from wherever a previous run left the
  // window. A drive whose result depends on run order is not a check, it is a
  // coincidence — this one failed outright when it ran straight after the shell
  // drive had left the application on a different tab.
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  check(
    'Writer is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="writer"]\')?.getAttribute("data-available")',
    ),
    'true',
  );
  check(
    'the other eight are still honestly labelled as not built',
    await evaluate(
      'document.querySelectorAll(\'.app-card[data-available="false"]\').length',
    ),
    8,
  );

  // Open it the way a person would.
  await evaluate('document.querySelector(\'.app-card[data-application="writer"]\').click(); true');
  await waitFor('!!document.querySelector(".writer__page")', 'a page to render');

  check('one page is rendered for an empty document', await evaluate('document.querySelectorAll(".writer__page").length'), 1);

  // A4 at 96dpi is 793.7 x 1122.5 CSS pixels. The page must be the geometry the
  // engine computed, not an approximation of it.
  const pageSize = await evaluate(
    '(() => { const r = document.querySelector(".writer__page").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()',
  );
  check('the page is A4 at the real converted size', pageSize, [794, 1123]);

  // Type through the real input event.
  await evaluate('document.querySelector(".writer__input").focus(); true');
  const sentence = 'Hello from Material Workspace.';
  await evaluate(
    '(() => { const input = document.querySelector(".writer__input");' +
      ' for (const ch of ' +
      JSON.stringify(sentence) +
      ') { input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true })); }' +
      ' return true; })()',
  );
  await waitFor('document.querySelectorAll(".writer__run").length > 0', 'typed text to render');

  check(
    'typing through the real input path reaches the page',
    await evaluate('document.querySelector(".writer__page").textContent'),
    sentence,
  );
  check(
    'the word count is real',
    await evaluate(
      '(document.querySelector(".writer__stats")?.textContent ?? "").startsWith("4 words")',
    ),
    true,
  );

  // Cantonese, through the same path. A word processor that cannot take Chinese
  // input is not one.
  const cantonese = '香港茶樓';
  await evaluate(
    '(() => { const input = document.querySelector(".writer__input");' +
      ' for (const ch of ' +
      JSON.stringify(cantonese) +
      ') { input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true })); }' +
      ' return true; })()',
  );
  await waitFor(
    'document.querySelector(".writer__page").textContent.includes("\\u8336")',
    'Cantonese text',
  );
  check(
    'Cantonese text is accepted and laid out',
    await evaluate('document.querySelector(".writer__page").textContent.endsWith("' + cantonese + '")'),
    true,
  );

  // Enter makes a real new block.
  await evaluate(
    '(() => { document.querySelector(".writer__input").dispatchEvent(' +
      'new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()',
  );
  await evaluate(
    '(() => { const input = document.querySelector(".writer__input");' +
      ' for (const ch of "Second paragraph") { input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true })); }' +
      ' return true; })()',
  );
  await waitFor(
    'document.querySelector(".writer__page").textContent.includes("Second paragraph")',
    'the second paragraph',
  );
  check(
    'Enter creates a real second block, laid out on its own line',
    await evaluate('document.querySelectorAll(".writer__line").length'),
    2,
  );

  // Formatting through the real toolbar button.
  await evaluate(
    '(() => { const input = document.querySelector(".writer__input");' +
      ' input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));' +
      ' return true; })()',
  );
  await evaluate('document.querySelector(\'.writer__format[data-format="bold"]\').click(); true');
  await waitFor(
    '[...document.querySelectorAll(".writer__run")].some(r => getComputedStyle(r).fontWeight === "700")',
    'bold to apply',
  );
  check(
    'the toolbar applies real formatting to the real selection',
    await evaluate(
      '[...document.querySelectorAll(".writer__run")].every(r => getComputedStyle(r).fontWeight === "700")',
    ),
    true,
  );
  check(
    'and the toolbar reports its own pressed state',
    await evaluate(
      'document.querySelector(\'.writer__format[data-format="bold"]\')?.getAttribute("aria-pressed")',
    ),
    'true',
  );

  // The caret is visible and positioned.
  check(
    'a caret is drawn on the page',
    await evaluate(
      '(() => { const c = document.querySelector(".writer__caret"); const r = c.getBoundingClientRect(); return r.height > 0; })()',
    ),
    true,
  );

  // The toolbar and the status line must stay in the window while the pages
  // scroll. Measured, because the stats line previously sat at 1,288px in a
  // 942px window: reachable by scrolling the whole workspace, which is not
  // what a document editor should do.
  check(
    'the toolbar and status line stay within the window',
    await evaluate(
      '(() => { const h = window.innerHeight;' +
        ' const t = document.querySelector(".writer__toolbar").getBoundingClientRect();' +
        ' const s = document.querySelector(".writer__stats").getBoundingClientRect();' +
        ' return t.top >= 0 && t.bottom <= h && s.bottom <= h + 1; })()',
    ),
    true,
  );
  check(
    'and it is the pages that scroll, not the whole workspace',
    await evaluate(
      '["auto","scroll"].includes(getComputedStyle(document.querySelector(".writer__surface")).overflowY)',
    ),
    true,
  );

  await capture('14-writer');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
