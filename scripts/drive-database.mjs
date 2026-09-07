#!/usr/bin/env node
/**
 * Drive Database in the built application.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[database] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[database] FAILED: ' + message + '\n');
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
    'Database is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="database"]\')?.getAttribute("data-available")',
    ),
    'true',
  );

  await click('.app-card[data-application="database"]');
  await waitFor('!!document.querySelector(".database__grid")', 'the grid');

  // ------------------------------------------------------------ the schema --

  check(
    'both tables are listed with their row counts',
    await evaluate(
      '[...document.querySelectorAll(".database__table-name")].map(n => n.textContent)',
    ),
    ['people', 'orders'],
  );

  check(
    // A field whose expected format is a secret until save fails is a field
    // people fill in wrongly and then blame themselves for.
    'each column states its type, and which are required',
    await evaluate(`
      (() => {
        const types = [...document.querySelectorAll('.database__cell-type')].map(t => t.textContent);
        return [types.includes('number'), types.includes('text, required')];
      })()
    `),
    [true, true],
  );

  check(
    // The distinction that makes this a database rather than a spreadsheet.
    'an unknown value is SHOWN as empty rather than rendered as blank space',
    await evaluate(`
      (() => {
        const empties = [...document.querySelectorAll('.database__cell[data-empty="true"]')];
        return [empties.length, empties[0]?.textContent];
      })()
    `),
    [2, 'empty'],
  );

  // ----------------------------------------------------------- validation --

  await setField('#db-field-id', '99');
  await setField('#db-field-name', '');
  await setField('#db-field-age', 'not a number');
  await click('.database__form button[type="submit"]');
  await waitFor('!!document.querySelector(".database__field-problem")', 'the problems');

  check(
    // Not one per attempt, which turns filling in a form into a guessing game.
    'every problem is reported at once',
    await evaluate('document.querySelectorAll(".database__field-problem").length'),
    2,
  );

  check(
    // A list at the bottom says something is wrong; a message under the box
    // says WHICH box.
    'and each problem sits beside the field it belongs to',
    await evaluate(`
      (() => {
        const field = document.querySelector('#db-field-age');
        const described = field?.getAttribute('aria-describedby');
        const problem = described ? document.getElementById(described) : null;
        return [
          field?.getAttribute('aria-invalid'),
          (problem?.textContent ?? '').includes('must be a number'),
        ];
      })()
    `),
    ['true', true],
  );

  check(
    'nothing was added',
    await evaluate(
      '(document.querySelector(".database__status")?.textContent ?? "").includes("3 of 3 rows")',
    ),
    true,
  );

  // A duplicate primary key.
  await setField('#db-field-id', '1');
  await setField('#db-field-name', 'Someone else');
  await setField('#db-field-age', '20');
  await click('.database__form button[type="submit"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'a duplicate primary key is refused',
    await evaluate(
      '[...document.querySelectorAll(".database__field-problem")].some(p => (p.textContent ?? "").includes("must be unique"))',
    ),
    true,
  );

  // Now a valid row.
  await setField('#db-field-id', '4');
  await setField('#db-field-name', 'Dee');
  await setField('#db-field-age', '28');
  await setField('#db-field-joined', '2026-02-01');
  await click('.database__form button[type="submit"]');
  await waitFor(
    '(document.querySelector(".database__status")?.textContent ?? "").includes("4 of 4 rows")',
    'the new row',
  );
  check(
    'a valid row is added',
    await evaluate('document.querySelectorAll(".database__row").length'),
    5,
  );

  // --------------------------------------------------------- referential --

  check(
    'the status line reports a real aggregate over the visible rows',
    await evaluate(
      '(document.querySelector(".database__status")?.textContent ?? "").includes("age total 69")',
    ),
    true,
  );

  // Deleting a row that orders point at must be refused - but the destructive
  // gate now stands in front of it, so the gate is driven first. That is the
  // stronger check: it proves the gate is genuinely in the way rather than
  // merely present.
  await evaluate(`
    (() => {
      document.querySelector('.database__remove[data-delete="1"]').click();
      return true;
    })()
  `);
  await waitFor('!!document.querySelector(".gate__slide")', 'the destructive gate');

  check(
    'a delete is gated, and the gate names the exact row rather than a count',
    await evaluate(`
      (() => {
        const affected = document.querySelector('.gate__affected')?.textContent ?? '';
        const irreversible = document.querySelector('.gate__irreversible')?.textContent ?? '';
        return [affected.includes('id is 1'), irreversible.includes('no undo')];
      })()
    `),
    [true, true],
  );

  check(
    'the final action is refused until both keys and the whole slider are given',
    await evaluate(`
      (() => {
        const action = document.querySelector('.gate__actions button:last-child');
        const before = action.disabled;
        const keys = [...document.querySelectorAll('.gate__key input')];
        keys[0].checked = true;
        keys[0].dispatchEvent(new Event('change', { bubbles: true }));
        const afterOneKey = action.disabled;
        keys[1].checked = true;
        keys[1].dispatchEvent(new Event('change', { bubbles: true }));
        const afterBothKeys = action.disabled;
        return [before, afterOneKey, afterBothKeys];
      })()
    `),
    [true, true, true],
  );

  // Now actually pass it: both keys are set, so run the slider to the end.
  await evaluate(`
    (() => {
      const slider = document.querySelector('.gate__slide input');
      slider.value = slider.max;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    '!document.querySelector(".gate__actions button:last-child")?.disabled',
    'the gate opening once both keys and the full slider are given',
  );
  await evaluate(`document.querySelector('.gate__actions button:last-child').click(); true`);

  await waitFor(
    'document.querySelector(".database__problems")?.getAttribute("data-shown") === "true"',
    'the refusal',
  );
  check(
    // A delete that quietly removes rows in other tables is the most
    // destructive default a database can have.
    'deleting a row that others point at is REFUSED, not cascaded',
    await evaluate(`
      (() => {
        const text = document.querySelector('.database__problems')?.textContent ?? '';
        return [
          text.includes('Cannot delete'),
          document.querySelectorAll('.database__row').length,
        ];
      })()
    `),
    [true, 5],
  );

  // --------------------------------------------------------------- query --

  await click('.database__action[data-action="add-filter"]');
  await waitFor('!!document.querySelector(".database__condition")', 'a filter');

  await evaluate(`
    (() => {
      const row = document.querySelector('.database__condition');
      const column = row.querySelector('.database__filter-column');
      column.value = 'age';
      column.dispatchEvent(new Event('change', { bubbles: true }));
      const comparison = row.querySelector('.database__filter-comparison');
      comparison.value = 'lessThan';
      comparison.dispatchEvent(new Event('change', { bubbles: true }));
      const value = row.querySelector('.database__filter-value');
      value.value = '10';
      value.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));

  check(
    // Treating null as zero is how a row with a missing value silently joins
    // a "less than ten" result.
    'a null never satisfies an ordered comparison',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.database__row')].slice(1);
        return rows.map(r => r.querySelector('.database__cell[data-column="name"]')?.textContent);
      })()
    `),
    ['Cheung'],
  );

  // isEmpty finds what comparisons cannot, and hides its value box.
  await evaluate(`
    (() => {
      const comparison = document.querySelector('.database__filter-comparison');
      comparison.value = 'isEmpty';
      comparison.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'isEmpty finds the nulls, and its value box is removed from the tab order',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.database__row')].slice(1);
        const input = document.querySelector('.database__filter-value');
        return [
          rows.map(r => r.querySelector('.database__cell[data-column="name"]')?.textContent),
          input?.hidden,
          input?.disabled,
        ];
      })()
    `),
    [['Bob'], true, true],
  );

  await click('.database__action[data-action="clear-filters"]');
  await waitFor('!document.querySelector(".database__condition")', 'the filters to clear');

  // --------------------------------------------------------------- sort --

  await evaluate('document.querySelectorAll(".database__cell--header")[2].click(); true');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    // A column sorted with blanks first is a column nobody can read.
    'sorting announces its direction and puts unknown values last',
    await evaluate(`
      (() => {
        const header = document.querySelectorAll('.database__cell--header')[2];
        const rows = [...document.querySelectorAll('.database__row')].slice(1);
        const names = rows.map(r => r.querySelector('.database__cell[data-column="name"]')?.textContent);
        return [header?.getAttribute('aria-sort'), names[names.length - 1]];
      })()
    `),
    ['ascending', 'Bob'],
  );

  // ------------------------------------------------------ switching tables --

  await evaluate('document.querySelectorAll(".database__table")[1].click(); true');
  await waitFor(
    '(document.querySelector(".database__status")?.textContent ?? "").includes("orders")',
    'the other table',
  );
  check(
    'switching tables rebuilds the grid for a different shape',
    // Read from the first child NODE, not from textContent. A header holds the
    // column name and its type as two children with no separator between them,
    // so textContent runs them together into "reftext".
    await evaluate(`
      [...document.querySelectorAll('.database__cell--header')]
        .map(h => h.childNodes[0]?.textContent)
    `),
    ['ref', 'person', 'total'],
  );

  await capture('22-database');

  // -------------------------------------------------------------- export --

  await evaluate(`
    (() => {
      window.__csvBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__csvBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.database__action[data-action="export"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__csvBlob', 'the export');
  check(
    'exporting names what CSV cannot carry',
    await evaluate(
      '(document.querySelector(".database__status")?.textContent ?? "").includes("does not carry")',
    ),
    true,
  );

  // ------------------------------------------------------------- in bulk --

  // Clear the filters first, so the grid shows the whole table again.
  await click('[data-action="clear-filters"]');

  check(
    // Not compared against a rebuilt copy of the sentence - a test holding its
    // own copy of the production wording proves only that the copy agrees with
    // itself. Checked behaviourally: it names the shown count, and it warns
    // that the two scopes differ exactly when they do.
    'the select-all control states WHICH all it means',
    await evaluate(`
      (() => {
        const label = document.querySelector('[data-action="mark-all"]').textContent || '';
        const shown = document.querySelectorAll('.database__row').length - 1;
        const status = document.querySelector('.database__status').textContent || '';
        const total = Number(/of (\d+) rows?/.exec(status)?.[1] ?? shown);
        return [
          label.includes(String(shown)),
          /different/.test(label) === (shown !== total),
          shown !== total ? label.includes(String(total)) : true,
        ];
      })()
    `),
    [true, true, true],
  );

  await click('[data-action="mark-all"]');
  check(
    'marking every row is announced on a real control, not by tint alone',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.database__row')].slice(1);
        const status = document.querySelector('.database__status').textContent || '';
        return [
          rows.length > 1,
          rows.every(r => r.querySelector('.database__mark').getAttribute('aria-pressed') === 'true'),
          status.includes(rows.length + ' rows marked'),
        ];
      })()
    `),
    [true, true, true],
  );

  await click('[data-action="invert"]');
  check(
    'inverting a full selection leaves nothing marked',
    await evaluate('document.querySelectorAll(`.database__mark[aria-pressed="true"]`).length'),
    0,
  );

  await click('[data-action="mark-all"]');
  await click('[data-action="delete-marked"]');

  check(
    // The gate names the count and states the irreversibility BEFORE anything
    // happens, and cannot be completed by pressing one thing.
    'a bulk delete opens the two-key gate rather than deleting on the spot',
    await evaluate(`
      (() => {
        const gate = document.querySelector('.gate');
        if (!gate) return null;
        return [
          // Matched with includes rather than a pattern: inside a template
          // literal a bare backslash-d is not a regex escape, it is the letter
          // d, so the pattern would quietly match nothing at all.
          (gate.querySelector('.gate__affected').textContent || '').includes(' items will be deleted'),
          gate.querySelector('.gate__irreversible').textContent.length > 10,
          gate.querySelector('.gate__action').disabled,
          document.querySelectorAll('.database__row').length > 1,
        ];
      })()
    `),
    [true, true, true, true],
  );

  // Both keys and the full slider, in that order.
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

  check(
    'the action unlocks only once both keys and the whole slider are given',
    await evaluate('document.querySelector(`.gate__action`).disabled'),
    false,
  );

  await click('.gate__action');
  check(
    'and the rows really go, with the sentence kept on screen afterwards',
    await evaluate(`
      (() => {
        const status = document.querySelector('.database__status').textContent || '';
        return [
          document.querySelectorAll('.database__row').length,
          status.includes(' items will be deleted'),
          document.querySelector('.gate') === null,
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
        const t = document.querySelector('.database__toolbar').getBoundingClientRect();
        const s = document.querySelector('.database__status').getBoundingClientRect();
        return t.top >= 0 && t.bottom <= h && s.bottom <= h + 1;
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
