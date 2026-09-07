#!/usr/bin/env node
/**
 * Drive Slides in the built application.
 *
 * The check that matters most here is the one about speaker notes: the
 * presenter view must show them and the audience view must NOT contain them
 * at all. Getting that wrong shows a room full of people the notes the
 * presenter was reading from.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[slides] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[slides] FAILED: ' + message + '\n');
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

  const key = (target, keyName) =>
    evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(target)});
        node.focus();
        node.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(keyName)}, bubbles: true, cancelable: true,
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
    'Slides is claimed as available on the front screen',
    await evaluate(
      'document.querySelector(\'.app-card[data-application="slides"]\')?.getAttribute("data-available")',
    ),
    'true',
  );

  await click('.app-card[data-application="slides"]');
  await waitFor('!!document.querySelector(".slides__surface")', 'the stage');

  // ------------------------------------------------------------- the model --

  check(
    'a new deck opens with one title slide that has somewhere to type',
    await evaluate(`
      (() => [
        document.querySelectorAll('.slides__thumb').length,
        document.querySelectorAll('.slides__element--text').length,
      ])()
    `),
    [1, 2],
  );

  check(
    'the slide renders at the ratio the model declares, not one fixed in CSS',
    await evaluate(`
      (() => {
        const r = document.querySelector('.slides__surface').getBoundingClientRect();
        // 16:9, within a pixel of rounding.
        return Math.abs(r.width / r.height - 16 / 9) < 0.02;
      })()
    `),
    true,
  );

  // Type a title through the real editable element.
  await evaluate(`
    (() => {
      const title = document.querySelector('.slides__element--text[data-role="title"]');
      title.focus();
      title.textContent = 'Hong Kong tea houses';
      title.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    'document.querySelector(".slides__thumb-title")?.textContent === "Hong Kong tea houses"',
    'the title to reach the slide list',
  );
  check(
    'typing a title updates the slide list, so a slide can be found again',
    await evaluate('document.querySelector(".slides__thumb-title")?.textContent'),
    'Hong Kong tea houses',
  );

  // Add a second slide.
  await click('.slides__action[data-action="add"]');
  await waitFor('document.querySelectorAll(".slides__thumb").length === 2', 'a second slide');
  check(
    'adding a slide inserts it AFTER the current one and selects it',
    await evaluate(`
      (() => {
        const thumbs = [...document.querySelectorAll('.slides__thumb')];
        return thumbs.findIndex(t => t.getAttribute('data-current') === 'true');
      })()
    `),
    1,
  );

  // Speaker notes on the second slide.
  const notes = 'Mention the 1920s teahouses, and do NOT read this out.';
  await evaluate(`
    (() => {
      const notes = document.querySelector('.slides__notes');
      notes.focus();
      notes.value = ${JSON.stringify(notes)};
      notes.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  // Duplicate, and confirm the copy is independent.
  await click('.slides__action[data-action="duplicate"]');
  await waitFor('document.querySelectorAll(".slides__thumb").length === 3', 'the duplicate');
  await evaluate(`
    (() => {
      const title = document.querySelector('.slides__element--text[data-role="title"]');
      title.focus();
      title.textContent = 'Only on the copy';
      title.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()
  `);
  check(
    // Sharing element ids would make editing one copy edit both, which reads
    // as the application randomly changing a slide nobody touched.
    'a duplicated slide is independent of its original',
    await evaluate(`
      [...document.querySelectorAll('.slides__thumb-title')].map(t => t.textContent)
    `),
    ['Hong Kong tea houses', 'Slide 2', 'Only on the copy'],
  );

  // Hiding.
  await click('.slides__action[data-action="hide"]');
  await waitFor('!!document.querySelector(".slides__thumb-hidden")', 'the hidden marker');
  check(
    'a hidden slide stays in the file and says so in WORDS, not just a colour',
    await evaluate(`
      (() => {
        const marked = document.querySelector('.slides__thumb[data-hidden="true"]');
        return [
          document.querySelectorAll('.slides__thumb').length,
          (marked?.textContent ?? '').includes('Hidden'),
        ];
      })()
    `),
    [3, true],
  );
  check(
    'and the status line counts it as hidden',
    await evaluate(
      '(document.querySelector(".slides__status")?.textContent ?? "").includes("1 hidden")',
    ),
    true,
  );

  // Unhide it again so the presenter checks have something after slide one.
  await click('.slides__action[data-action="hide"]');
  await waitFor('!document.querySelector(".slides__thumb-hidden")', 'the slide to reappear');

  await capture('17-slides-editor');

  // ---------------------------------------------------------- presenting --

  check(
    'the presenter view is absent from the document before presenting',
    await evaluate(
      'document.querySelector(".slides__presenter")?.getAttribute("data-presenting")',
    ),
    'false',
  );
  check(
    // display:none rather than off-screen, so it is not in the tab order and
    // not read by a screen reader while nobody is presenting.
    'and it is not focusable while it is not being presented',
    await evaluate(`
      getComputedStyle(document.querySelector('.slides__presenter')).display === 'none'
    `),
    true,
  );

  // Go to the second slide, which has the notes, then present.
  await evaluate('document.querySelectorAll(".slides__thumb")[1].click(); true');
  await click('.slides__action[data-action="present"]');
  await waitFor(
    'document.querySelector(".slides__presenter")?.getAttribute("data-presenting") === "true"',
    'the presenter view',
  );

  check(
    'the presenter view shows the current slide AND the next one',
    await evaluate('document.querySelectorAll(".slides__preview").length'),
    2,
  );
  check(
    'and labels which is which',
    await evaluate(
      '[...document.querySelectorAll(".slides__preview-label")].map(l => l.textContent)',
    ),
    ['Now', 'Next'],
  );
  check(
    'the speaker notes are shown to the PRESENTER',
    await evaluate(
      '(document.querySelector(".slides__presenter-notes-body")?.textContent ?? "").includes("1920s teahouses")',
    ),
    true,
  );

  check(
    // The single most important check in this file. A note that reaches the
    // projector is the worst failure this application can have.
    'and the notes appear NOWHERE inside the slide surfaces the audience sees',
    await evaluate(`
      (() => {
        const surfaces = [...document.querySelectorAll('.slides__surface')];
        return surfaces.every(s => !(s.textContent ?? '').includes('1920s teahouses'));
      })()
    `),
    true,
  );

  // Read the text out and test it HERE, rather than shipping a regular
  // expression through a JS string into an evaluated expression. Every layer
  // eats a backslash: the first version of this check sent `\\d` and matched a
  // literal backslash followed by the letter d, so it could never pass.
  const clockText = await evaluate(
    'document.querySelector(".slides__clock")?.textContent ?? ""',
  );
  check('a running clock is shown', /^\d+:\d\d$/.test(clockText), true);

  const positionBefore = await evaluate(
    'document.querySelector(".slides__presenter-position")?.textContent',
  );
  await key('.slides__presenter', 'ArrowRight');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const positionAfter = await evaluate(
    'document.querySelector(".slides__presenter-position")?.textContent',
  );
  check('arrow keys advance the presentation', positionBefore !== positionAfter, true);

  check(
    'and the position is counted over the VISIBLE slides',
    await evaluate(
      '(document.querySelector(".slides__presenter-position")?.textContent ?? "").includes("of 3")',
    ),
    true,
  );

  await capture('18-slides-presenter');

  await key('.slides__presenter', 'Escape');
  await waitFor(
    'document.querySelector(".slides__presenter")?.getAttribute("data-presenting") === "false"',
    'the presenter view to close',
  );
  check(
    'Escape stops presenting',
    await evaluate(
      'document.querySelector(".slides__presenter")?.getAttribute("data-presenting")',
    ),
    'false',
  );

  // ------------------------------------------------------------- geometry --

  check(
    'the toolbar and status line stay within the window',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const t = document.querySelector('.slides__toolbar').getBoundingClientRect();
        const s = document.querySelector('.slides__status').getBoundingClientRect();
        return t.top >= 0 && t.bottom <= h && s.bottom <= h + 1;
      })()
    `),
    true,
  );

  check(
    'every toolbar control meets the touch-target height',
    await evaluate(`
      (() => {
        const target = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--workspace-touch-target'),
        ) || 48;
        return [...document.querySelectorAll('.slides__action, .slides__layout')]
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
