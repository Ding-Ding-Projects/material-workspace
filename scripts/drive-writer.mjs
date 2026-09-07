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
    // Derived, not pinned. This asserted an exact count of eight unbuilt
    // applications, so shipping the SECOND one turned it red — a check that
    // fails because the product got better is a check somebody edits to shut
    // it up rather than reads. The honesty property is what matters: every
    // card carries a verdict, and none is left unlabelled.
    'every other application still carries an honest verdict',
    await evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.app-card')];
        return cards.length === 9 && cards.every((c) => c.hasAttribute('data-available'));
      })()
    `),
    true,
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

  // ------------------------------------------------- a real docx round trip --

  check(
    'every save format is offered, each naming what it would drop',
    await evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.writer__save')];
        return [
          buttons.map(b => b.getAttribute('data-format')).sort(),
          buttons.every(b => (b.getAttribute('title') ?? '').length > 20),
        ];
      })()
    `),
    [['docx', 'md', 'odt', 'txt'], true],
  );

  // Save the document, capturing the bytes instead of downloading them.
  await evaluate(`
    (() => {
      window.__docxBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__docxBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.writer__save[data-format="docx"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__docxBlob', 'the document bytes');

  check(
    'saving reports what the format does or does not carry',
    await evaluate(
      '(document.querySelector(".writer__note")?.textContent ?? "").includes("Word document")',
    ),
    true,
  );

  await evaluate(`
    (() => {
      window.__docxZip = null;
      window.__docxBlob.slice(0, 2).arrayBuffer().then((buffer) => {
        const head = new Uint8Array(buffer);
        window.__docxZip = head[0] === 0x50 && head[1] === 0x4b;
      });
      return true;
    })()
  `);
  await waitFor('window.__docxZip !== null', 'the zip signature check');
  check('the saved document is a real zip archive', await evaluate('window.__docxZip'), true);

  // Reopen those exact bytes through the real file control.
  await evaluate(`
    (() => {
      const file = new File([window.__docxBlob], 'roundtrip.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector('.writer__file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    '(document.querySelector(".writer__note")?.textContent ?? "").includes("Opened")',
    'the document to reopen',
  );

  check(
    'the text survives the document round trip',
    await evaluate('document.querySelector(".writer__page")?.textContent'),
    sentence + cantonese + 'Second paragraph',
  );

  check(
    // Bold was applied to the whole document before saving. If the run
    // properties were dropped, every run comes back unstyled and this is the
    // check that notices.
    'and so does the bold formatting',
    await evaluate(
      '[...document.querySelectorAll(".writer__run")].every(r => getComputedStyle(r).fontWeight === "700")',
    ),
    true,
  );

  check(
    'the paragraph structure survives too, rather than collapsing into one block',
    await evaluate('document.querySelectorAll(".writer__line").length'),
    2,
  );

  await capture('14-writer');

  // ------------------------------------------------- footnotes and contents --

  // Typed into the real editor, through the real toolbar, and MEASURED on the
  // rendered page. A note that is stored and never drawn is the exact
  // wired-at-one-end defect this project has met before.

  await evaluate(`
    (() => {
      const input = document.querySelector('.writer__input');
      input.focus();
      return true;
    })()
  `);

  await evaluate(`
    (() => {
      const note = [...document.querySelectorAll('.writer__command')]
        .find(button => button.getAttribute('data-command') === 'footnote');
      note.click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 400));

  check(
    'a footnote is added, drawn on the page, and numbered',
    await evaluate(`
      (() => {
        const notes = [...document.querySelectorAll('.writer__footnote')];
        const rule = document.querySelector('.writer__footnote-rule');
        return [
          notes.length,
          rule !== null,
          notes[0] ? notes[0].getAttribute('data-number') : null,
          notes[0] ? notes[0].textContent.startsWith('1. ') : false,
        ];
      })()
    `),
    [1, true, '1', true],
  );

  check(
    // The note sits at the FOOT of the page. A note drawn at the top, or
    // overlapping the body, is a note that was positioned from a guess rather
    // than from the space the layout actually reserved for it.
    'the note is at the foot of its page, below every line of body text',
    await evaluate(`
      (() => {
        const page = document.querySelector('.writer__page');
        const note = document.querySelector('.writer__footnote');
        const lines = [...page.querySelectorAll('.writer__line')];
        const pageBox = page.getBoundingClientRect();
        const noteBox = note.getBoundingClientRect();
        const lowestLine = Math.max(...lines.map(line => line.getBoundingClientRect().bottom));
        return [
          noteBox.top > lowestLine,
          noteBox.bottom <= pageBox.bottom + 1,
          // In the lower half of the page, which is what "foot" means.
          noteBox.top > pageBox.top + pageBox.height / 2,
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    'the status says where the note will appear rather than only that it was added',
    await evaluate(
      '(document.querySelector(".writer__note")?.textContent ?? "").includes("foot of")',
    ),
    true,
  );

  // Scrolled to the foot before capturing. An A4 page is taller than the
  // window, so a capture of the top shows a page with no note on it - which is
  // evidence of nothing.
  await evaluate(`
    (() => {
      const note = document.querySelector('.writer__footnote');
      note.scrollIntoView({ block: 'center' });
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 300));

  await capture('48-writer-footnote');

  // The contents. Give the document a heading first, so there is something to
  // list - an empty contents is a separate state and is tested by the engine.
  await evaluate(`
    (() => {
      const select = document.querySelector('.writer__block-kind');
      if (select) {
        select.value = 'heading1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await evaluate(`
    (() => {
      const contents = [...document.querySelectorAll('.writer__command')]
        .find(button => button.getAttribute('data-command') === 'contents');
      contents.click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 500));

  check(
    'a contents is inserted and says so',
    await evaluate(
      '(document.querySelector(".writer__note")?.textContent ?? "").includes("contents")',
    ),
    true,
  );

  check(
    // Refreshing must REPLACE. Three refreshes leaving three contents pages is
    // the failure, and it is invisible on the first one.
    'refreshing three times leaves ONE contents, not three',
    await (async () => {
      const countTitles = `
        (() => {
          const text = document.querySelector('.writer__surface').textContent || '';
          return (text.match(/Contents/g) || []).length;
        })()
      `;
      const first = await evaluate(countTitles);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await evaluate(`
          (() => {
            [...document.querySelectorAll('.writer__command')]
              .find(button => button.getAttribute('data-command') === 'contents').click();
            return true;
          })()
        `);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const third = await evaluate(countTitles);
      return [first > 0, third === first];
    })(),
    [true, true],
  );

  await capture('49-writer-contents');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
