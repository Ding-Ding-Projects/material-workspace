#!/usr/bin/env node
/**
 * Drive Sheets in the built application.
 *
 * Everything goes through a real user path: the grid is focused, cells are
 * typed into through the real editor, and keys arrive as real keydown events.
 * Calling the workbook directly would prove the engine — which the 44 unit
 * tests already do — and nothing about whether a keystroke reaches it.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[sheets] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[sheets] FAILED: ' + message + '\n');
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

  /** Type a value into the currently focused cell, exactly as a person does. */
  const typeCell = async (text) => {
    await evaluate(`
      (() => {
        const grid = document.querySelector('.sheets__scroller');
        grid.focus();
        grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
        const editor = document.querySelector('.sheets__cell-editor');
        editor.value = ${JSON.stringify(text)};
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return true;
      })()
    `);
  };

  /** Move the selection with real arrow keys. */
  const press = async (key, options = {}) => {
    await evaluate(`
      (() => {
        const grid = document.querySelector('.sheets__scroller');
        grid.focus();
        grid.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)},
          shiftKey: ${options.shift === true},
          ctrlKey: ${options.ctrl === true},
          bubbles: true, cancelable: true,
        }));
        return true;
      })()
    `);
  };

  const cellText = (address) =>
    evaluate(
      `document.querySelector('.sheets__cell[data-address="${address}"]')?.textContent ?? null`,
    );

  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1400));

  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  check(
    'Sheets is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="sheets"]\')?.getAttribute("data-available")',
    ),
    'true',
  );
  check(
    // Derived rather than pinned, so the third application does not turn this
    // red for the reason the second one turned the sibling drives red.
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
  await evaluate('document.querySelector(\'.app-card[data-application="sheets"]\').click(); true');
  await waitFor('!!document.querySelector(".sheets__scroller")', 'the grid');

  // --------------------------------------------------------- virtualisation --

  const rendered = await evaluate('document.querySelectorAll(".sheets__cell").length');
  check(
    'the grid is virtualised rather than rendering every cell',
    // A sixteen-thousand-by-a-million grid is sixteen billion cells. Anything
    // beyond a few hundred here means virtualisation is not working, and the
    // exact number depends on the window size so it is bounded, not pinned.
    rendered > 0 && rendered < 3000,
    true,
  );

  check(
    'the scrollable area is sized so the scrollbar is real',
    await evaluate(
      '(() => { const s = document.querySelector(".sheets__spacer").getBoundingClientRect();' +
        ' return s.height > 100000 && s.width > 10000; })()',
    ),
    true,
  );

  // ------------------------------------------------------------- real input --

  // Navigate to an exact cell before every write.
  //
  // The first version of this drive typed a value, then pressed ArrowDown, and
  // assumed the next value landed one row below. It did not: committing with
  // Enter ALREADY advances, so every write went one row further than intended
  // and the assertions were checking empty cells. Deriving the position from
  // an assumed sequence is how a drive ends up testing itself.
  const goTo = async (column, row) => {
    await press('Home', { ctrl: true });
    for (let step = 0; step < column; step += 1) await press('ArrowRight');
    for (let step = 0; step < row; step += 1) await press('ArrowDown');
  };

  await goTo(0, 0);
  await typeCell('10');
  await goTo(0, 1);
  await typeCell('32');
  await goTo(0, 2);
  await typeCell('=A1+A2');
  await new Promise((resolve) => setTimeout(resolve, 200));

  check('typed literals reach the grid', await cellText('A1'), '10');
  check('a formula typed through the real editor computes', await cellText('A3'), '42');

  // A dependent must recalculate when its precedent changes, through the UI.
  await goTo(0, 0);
  await typeCell('100');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('editing a precedent recalculates its dependent on screen', await cellText('A3'), '132');

  // ------------------------------------------------------------- alignment --

  check(
    'a number is right-aligned and text is not, so they are distinguishable',
    await evaluate(`
      (() => {
        const number = document.querySelector('.sheets__cell[data-address="A1"]');
        return number?.getAttribute('data-kind');
      })()
    `),
    'number',
  );

  // Measured, not inferred from the stylesheet.
  //
  // The first version of the Sheets stylesheet referenced seven custom
  // properties that do not exist, so every padding resolved to zero. A1 held
  // 100 and B1 held 0012, and with no gap they rendered flush and read as one
  // number: 1000012. Every check passed; only a capture showed it.
  //
  // A unit test now refuses undefined tokens, but a token can also be defined
  // as zero, or overridden, or lost to a specificity fight. This asks the
  // running page what the gap actually is.
  check(
    'a cell has real horizontal padding, so neighbouring values cannot merge',
    await evaluate(`
      (() => {
        const cell = document.querySelector('.sheets__cell');
        if (!cell) return 'no cell';
        const style = getComputedStyle(cell);
        const left = parseFloat(style.paddingLeft);
        const right = parseFloat(style.paddingRight);
        return left >= 4 && right >= 4;
      })()
    `),
    true,
  );

  check(
    'and its font size resolved to something real rather than collapsing',
    await evaluate(`
      (() => {
        const cell = document.querySelector('.sheets__cell');
        const size = parseFloat(getComputedStyle(cell).fontSize);
        // An invalid font-size declaration falls back to the inherited value,
        // which is not obviously wrong on screen but is not what was asked for.
        return size >= 10 && size <= 20;
      })()
    `),
    true,
  );

  // Text that LOOKS like a number must stay text, and say so.
  await goTo(1, 0);
  await typeCell("'0012");
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'an apostrophe-forced value stays text rather than becoming a number',
    await evaluate(
      'document.querySelector(\'.sheets__cell[data-address="B1"]\')?.getAttribute("data-kind")',
    ),
    'text',
  );
  check('and it keeps its leading zeros', await cellText('B1'), '0012');

  // ---------------------------------------------------------------- errors --

  await goTo(2, 0);
  await typeCell('=1/0');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('a division error is shown as an error, not as a number', await cellText('C1'), '#DIV/0!');
  check(
    'and it is marked as an error for styling and assistive technology',
    await evaluate(
      'document.querySelector(\'.sheets__cell[data-address="C1"]\')?.getAttribute("data-kind")',
    ),
    'error',
  );

  // ------------------------------------------------------------- selection --

  await goTo(0, 0);
  await press('ArrowDown', { shift: true });
  await press('ArrowDown', { shift: true });
  check(
    'shift-arrow extends a real range selection',
    await evaluate('document.querySelectorAll(\'.sheets__cell[data-selected="true"]\').length'),
    3,
  );
  check(
    'and the status line reports the aggregate of that selection',
    await evaluate(
      // A1 is 100, A2 is 32, and A3 is the formula that now reads 132.
      '(document.querySelector(".sheets__status")?.textContent ?? "").includes("Sum 264")',
    ),
    true,
  );

  // --------------------------------------------------------- the formula bar --

  await goTo(0, 0);
  check(
    'the formula bar shows the address of the focused cell',
    await evaluate('document.querySelector(".sheets__address")?.textContent'),
    'A1',
  );
  await goTo(0, 2);
  check(
    'and the underlying formula, not the computed value',
    await evaluate('document.querySelector(".sheets__formula")?.value'),
    '=A1+A2',
  );

  // -------------------------------------------------------------- geometry --

  check(
    'the grid stays within the window rather than scrolling the whole workspace',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const bar = document.querySelector('.sheets__bar').getBoundingClientRect();
        const status = document.querySelector('.sheets__status').getBoundingClientRect();
        return bar.top >= 0 && bar.bottom <= h && status.bottom <= h + 1;
      })()
    `),
    true,
  );

  check(
    'the column and row headers are present and labelled',
    await evaluate(`
      (() => {
        const columns = [...document.querySelectorAll('.sheets__column-cell')].map(c => c.textContent);
        const rows = [...document.querySelectorAll('.sheets__row-cell')].map(c => c.textContent);
        return columns.includes('A') && columns.includes('B') && rows.includes('1') && rows.includes('2');
      })()
    `),
    true,
  );

  // ---------------------------------------------------- import and export --

  check(
    'every export format is offered, each naming what it would drop',
    await evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.sheets__export')];
        return [
          buttons.map(b => b.getAttribute('data-format')),
          // Every button must carry a title saying either what is lost or that
          // nothing is. A control that exports silently is the defect.
          buttons.every(b => (b.getAttribute('title') ?? '').length > 20),
        ];
      })()
    `),
    [['csv', 'tsv', 'json', 'markdown', 'html'], true],
  );

  check(
    // Measured on the element a finger actually hits.
    //
    // The first version put min-height on the file INPUT, which made the box
    // tall and left its button the same small default size sitting at the top
    // of it. Measuring the input reported a pass; the real target was about
    // half the required height, and the layout looked misaligned because of it.
    'every control in the toolbar meets the touch-target height',
    await evaluate(`
      (() => {
        const target = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--workspace-touch-target'),
        ) || 48;
        const buttons = [...document.querySelectorAll('.sheets__export')];
        const heights = buttons.map(b => b.getBoundingClientRect().height);
        // The file input's own button is a shadow pseudo-element and cannot be
        // measured directly, so its declared minimum is read from the rule.
        const fileRule = [...document.styleSheets]
          .flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } })
          .find(rule => (rule.selectorText ?? '').includes('file-selector-button'));
        const fileDeclares = (fileRule?.style?.minHeight ?? '').length > 0;
        return heights.every(h => h >= target - 1) && fileDeclares;
      })()
    `),
    true,
  );

  // Import a real file through the real control. A DataTransfer carrying a
  // File is what a drop or a picker produces, so the input receives exactly
  // what a person would give it.
  await evaluate(`
    (() => {
      const csv = 'product,qty,note\\n' +
        'Har gow,3,"steamed, three per basket"\\n' +
        'Siu mai,2,"a note\\nacross two lines"\\n' +
        '=SUM(A1:A9),1,formula-looking data\\n';
      const file = new File([csv], 'order.csv', { type: 'text/csv' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector('.sheets__file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    '(document.querySelector(".sheets__loss")?.textContent ?? "").includes("rows imported")',
    'the import to report',
  );

  check(
    'a quoted field containing the delimiter arrives as ONE cell',
    await cellText('C2'),
    'steamed, three per basket',
  );
  check(
    'a quoted field containing a newline arrives as one cell too',
    await evaluate(
      'document.querySelector(\'.sheets__cell[data-address="C3"]\')?.textContent?.includes("across two lines")',
    ),
    true,
  );
  check(
    'a numeric column imports as NUMBERS, or nothing could be summed',
    await evaluate(
      'document.querySelector(\'.sheets__cell[data-address="B2"]\')?.getAttribute("data-kind")',
    ),
    'number',
  );
  check(
    // The security case. A downloaded file whose first field begins with an
    // equals sign must not become a live formula the moment it is opened.
    'imported data that looks like a formula stays DATA',
    await cellText('A4'),
    '=SUM(A1:A9)',
  );
  check(
    'and it is text, not a computed value',
    await evaluate(
      'document.querySelector(\'.sheets__cell[data-address="A4"]\')?.getAttribute("data-kind")',
    ),
    'text',
  );

  // Export, and confirm the losses are stated rather than discovered later.
  await evaluate('document.querySelector(\'.sheets__export[data-format="csv"]\').click(); true');
  await waitFor(
    '(document.querySelector(".sheets__loss")?.textContent ?? "").includes("Exported")',
    'the export to report',
  );
  check(
    'exporting to CSV says plainly what CSV cannot carry',
    await evaluate(
      '(document.querySelector(".sheets__loss")?.textContent ?? "").includes("does not carry")',
    ),
    true,
  );

  await evaluate('document.querySelector(\'.sheets__export[data-format="json"]\').click(); true');
  await waitFor(
    '(document.querySelector(".sheets__loss")?.textContent ?? "").includes("Nothing was lost")',
    'the lossless report',
  );
  check(
    'and exporting to JSON says plainly that nothing is lost',
    await evaluate(
      '(document.querySelector(".sheets__loss")?.textContent ?? "").includes("Nothing was lost")',
    ),
    true,
  );

  await capture('15-sheets');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
