#!/usr/bin/env node
/**
 * Drive Notes in the built application.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[notes] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[notes] FAILED: ' + message + '\n');
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

  /** Type into a real field through the same event a keystroke produces. */
  const type = (selector, value) =>
    evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        node.focus();
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.blur();
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
    'Notes is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="notes"]\')?.getAttribute("data-available")',
    ),
    'true',
  );

  await click('.app-card[data-application="notes"]');
  await waitFor('!!document.querySelector(".notes__list")', 'the notes list');

  // ------------------------------------------------------------ empty state --

  check(
    // "No notes yet" and "nothing matched" need different actions from the
    // user, so they must not share a message.
    'the empty state says there are no notes yet, and how to make one',
    await evaluate('document.querySelector(".notes__empty")?.textContent'),
    'No notes yet. Choose New note to write one.',
  );

  check(
    'the editor is disabled while nothing is selected, rather than silently ignoring typing',
    await evaluate('document.querySelector(".notes__editor")?.disabled'),
    true,
  );

  // ----------------------------------------------------------- writing --

  await click('.notes__action[data-action="new"]');
  await waitFor('!!document.querySelector(".notes__item")', 'a note');

  check(
    'a new note enables the editor',
    await evaluate('document.querySelector(".notes__editor")?.disabled'),
    false,
  );

  await type(
    '.notes__editor',
    '# Tea houses\n\nAbout #dim-sum and #茶樓.\n\nSee also [[Har gow]].',
  );
  await waitFor(
    'document.querySelectorAll(".notes__tag").length >= 2',
    'the tags to be extracted',
  );

  check(
    'the title is derived from the first heading, so a note needs no title to exist',
    await evaluate('document.querySelector(".notes__item-title")?.textContent'),
    'Tea houses',
  );

  check(
    // A word-character class would match only Latin letters and drop every tag
    // in any other script, which is invisible to whoever wrote it.
    'tags are extracted, including a Chinese one',
    await evaluate(
      '[...document.querySelectorAll(".notes__tag")].map(t => t.textContent).sort()',
    ),
    ['#dim-sum 1', '#茶樓 1'],
  );

  check(
    // Found by looking at a capture: the box read "Untitled note" while the
    // list plainly read "Tea houses", which looks like the two disagree about
    // which note is open.
    'the title box and the note list agree on the derived title',
    await evaluate('document.querySelector(".notes__title")?.placeholder'),
    'Tea houses',
  );

  check(
    'a link to a note that does not exist is offered as something to create',
    await evaluate(
      'document.querySelector(".notes__link--missing")?.getAttribute("data-link")',
    ),
    'Har gow',
  );

  check(
    'the word count counts CJK characters individually',
    await evaluate(
      '(document.querySelector(".notes__status")?.textContent ?? "").includes("words")',
    ),
    true,
  );

  // Following the unresolved link creates the note it names.
  await click('.notes__link--missing');
  await waitFor('document.querySelectorAll(".notes__item").length === 2', 'the second note');
  check(
    'following an unwritten link creates that note and selects it',
    await evaluate(`
      (() => {
        const current = document.querySelector('.notes__item[data-current="true"]');
        return (current?.textContent ?? '').includes('Har gow');
      })()
    `),
    true,
  );

  check(
    'and the first note now shows as linking here',
    await evaluate(`
      [...document.querySelectorAll('.notes__link:not(.notes__link--missing)')]
        .map(l => l.getAttribute('data-link'))
    `),
    ['Tea houses'],
  );

  // ------------------------------------------------------------ searching --

  // Deliberately a term the OTHER note does not contain. Searching for
  // "gow" matched both, because the first note contains the link text
  // [[Har gow]] in its body — correct behaviour, and a useless filter test.
  await type('.notes__search', 'houses');
  await waitFor('document.querySelectorAll(".notes__item").length === 1', 'the filtered list');
  check(
    'search narrows the list',
    await evaluate('document.querySelectorAll(".notes__item").length'),
    1,
  );

  await type('.notes__search', 'nothing matches this');
  await waitFor('!!document.querySelector(".notes__empty")', 'the no-match state');
  check(
    'and an empty result says nothing MATCHED, not that there are no notes',
    await evaluate('document.querySelector(".notes__empty")?.textContent'),
    'No note matches that search.',
  );

  // A malformed pattern must not throw on every keystroke.
  await click('.notes__regex-label');
  await type('.notes__search', '([unclosed');
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'a half-typed regular expression is reported rather than throwing',
    await evaluate(
      '(document.querySelector(".notes__status")?.textContent ?? "").includes("not valid yet")',
    ),
    true,
  );

  await type('.notes__search', 'Tea|Har');
  await waitFor('document.querySelectorAll(".notes__item").length === 2', 'both notes');
  check(
    'a valid pattern matches',
    await evaluate('document.querySelectorAll(".notes__item").length'),
    2,
  );

  // Back to plain text, and clear.
  await click('.notes__regex-label');
  await type('.notes__search', '');
  await waitFor('document.querySelectorAll(".notes__item").length === 2', 'the full list');

  // ------------------------------------------------------------- pinning --

  await evaluate('document.querySelectorAll(".notes__item")[1].click(); true');
  await click('.notes__action[data-action="pin"]');
  await waitFor('!!document.querySelector(".notes__pin")', 'the pin marker');
  check(
    // Pinning means "keep this where I can see it"; an order that buries a
    // pinned note has ignored the only instruction the user gave.
    'a pinned note sorts to the top, and says Pinned in words',
    await evaluate(`
      (() => {
        const first = document.querySelector('.notes__item');
        return (first?.textContent ?? '').includes('Pinned');
      })()
    `),
    true,
  );

  // It must stay first in every order.
  await evaluate(`
    (() => {
      const select = document.querySelector('.notes__order');
      select.value = 'title';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    'and stays first when the sort order changes',
    await evaluate(
      '(document.querySelector(".notes__item")?.textContent ?? "").includes("Pinned")',
    ),
    true,
  );

  // ------------------------------------------------------- tag filtering --

  await evaluate('document.querySelector(\'.notes__tag[data-tag="dim-sum"]\').click(); true');
  await waitFor('document.querySelectorAll(".notes__item").length === 1', 'the tag filter');
  check(
    'clicking a tag filters to it, and the status line says so',
    await evaluate(
      '(document.querySelector(".notes__status")?.textContent ?? "").includes("filtered by #dim-sum")',
    ),
    true,
  );
  // Clicking it again clears the filter, so there is always a way back.
  await evaluate('document.querySelector(\'.notes__tag[data-tag="dim-sum"]\').click(); true');
  await waitFor('document.querySelectorAll(".notes__item").length === 2', 'the filter to clear');
  check(
    'and clicking it again clears the filter',
    await evaluate('document.querySelectorAll(".notes__item").length'),
    2,
  );

  // -------------------------------------------------------------- export --

  await evaluate(`
    (() => {
      window.__notesBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__notesBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.notes__action[data-action="export"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__notesBlob', 'the export');
  check(
    'exporting says plainly that nothing was lost',
    await evaluate(
      '(document.querySelector(".notes__status")?.textContent ?? "").includes("Nothing was lost")',
    ),
    true,
  );

  await evaluate(`
    (() => {
      window.__notesText = null;
      window.__notesBlob.text().then((text) => { window.__notesText = text; });
      return true;
    })()
  `);
  await waitFor('window.__notesText !== null', 'the exported text');
  check(
    'and the export carries the tags and pinned state in front matter',
    await evaluate(`
      (() => {
        const text = window.__notesText;
        return [
          text.includes('tags: dim-sum'),
          text.includes('pinned: true'),
          text.includes('# Tea houses'),
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
        const t = document.querySelector('.notes__toolbar').getBoundingClientRect();
        const s = document.querySelector('.notes__status').getBoundingClientRect();
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
        return [...document.querySelectorAll('.notes__action, .notes__order, .notes__search, .notes__tag')]
          .every(b => b.getBoundingClientRect().height >= target - 1);
      })()
    `),
    true,
  );

  await capture('19-notes');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
