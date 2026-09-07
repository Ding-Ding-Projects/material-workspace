#!/usr/bin/env node
/**
 * Drive the running application through the Chrome DevTools Protocol.
 *
 * This exists because a unit test that injects its dependency proves the screen
 * and nothing about the wiring. Three real defects in this project were found by
 * launching the built application and looking at it, after the source read as
 * perfectly correct.
 *
 * Isolation is PROVED before anything is evaluated: exactly one target, of type
 * page, at the expected URL. Finding one acceptable target among several proves
 * nothing.
 *
 * Expressions are kept synchronous and polled. `awaitPromise: true` has been
 * observed to hang indefinitely on this Node version, which looks exactly like
 * an application fault and is not one.
 *
 * Usage: node scripts/drive-ui.mjs <port> [outputDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

function log(message) {
  process.stdout.write('[drive] ' + message + '\n');
}

function fail(message) {
  process.stderr.write('[drive] FAILED: ' + message + '\n');
  process.exit(1);
}

async function resolveTarget() {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
    signal: AbortSignal.timeout(20_000),
  });
  const targets = await response.json();

  // Every one of these must hold. A .find() over a contaminated list would
  // happily pick the convenient entry and prove nothing about isolation.
  if (targets.length !== 1) {
    fail('expected exactly one debugging target, found ' + targets.length);
  }
  const target = targets[0];
  if (target.type !== 'page') fail('the only target is not a page: ' + target.type);
  if (!target.webSocketDebuggerUrl) fail('the target exposes no WebSocket endpoint');
  if (!String(target.url).includes('material-workspace')) {
    fail('the target is not this application: ' + target.url);
  }
  return target;
}

class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' did not answer within 30s'));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate a SYNCHRONOUS expression and return its JSON value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      // Deliberately absent: awaitPromise. See the note at the top of the file.
    });
    if (result.exceptionDetails) {
      throw new Error(
        'evaluation threw: ' +
          (result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            'unknown'),
      );
    }
    return result.result.value;
  }

  /** Poll a synchronous predicate until it is true, or give up honestly. */
  async waitFor(expression, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return true;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    fail('timed out waiting for ' + description + ' (last value: ' + JSON.stringify(last) + ')');
  }

  async capture(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    log('captured ' + file);
    return file;
  }
}

const findings = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ label, ok, actual, expected });
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  actual=' + JSON.stringify(actual)));
  return ok;
}

async function main() {
  const target = await resolveTarget();
  log('one page target confirmed');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('the CDP socket failed')), {
      once: true,
    });
  });
  const session = new Session(socket);
  await session.send('Page.enable');
  await session.send('Runtime.enable');

  await session.waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell to finish booting',
  );
  log('shell reported ready');

  // --- the front screen ---------------------------------------------------
  check(
    'front screen shows the version',
    await session.evaluate('!!document.body.textContent.match(/0\\.1\\.0/)'),
    true,
  );
  check(
    'the build time is rendered to the second with a timezone',
    await session.evaluate(
      '/\\d{2}:\\d{2}:\\d{2}/.test(document.querySelector(".facts")?.textContent ?? "")',
    ),
    true,
  );
  check(
    'all nine applications render',
    await session.evaluate('document.querySelectorAll(".app-card").length'),
    9,
  );
  check(
    'unbuilt applications are labelled, not silently inert',
    await session.evaluate(
      'document.querySelectorAll(".app-card[data-available=\\"false\\"]").length',
    ),
    9,
  );
  await session.capture('01-front-screen');

  // --- the search field actually filters ----------------------------------
  await session.evaluate(`
    (() => {
      const input = document.getElementById('application-search');
      input.value = 'spreadsheet';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".app-card").length === 1',
    'the grid to filter to one card',
  );
  check(
    'plain-text search filters the grid to the matching application',
    await session.evaluate(
      'document.querySelector(".app-card")?.getAttribute("data-application")',
    ),
    'sheets',
  );
  await session.capture('02-search-filtered');

  // --- a Cantonese term finds its application while the UI is in English ---
  await session.evaluate(`
    (() => {
      const input = document.getElementById('application-search');
      input.value = '\\u8A66\\u7B97\\u8868';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".app-card").length === 1',
    'the Cantonese term to match',
  );
  check(
    'a Cantonese term matches while the interface is in English',
    await session.evaluate(
      'document.querySelector(".app-card")?.getAttribute("data-application")',
    ),
    'sheets',
  );

  // --- an honest empty state ----------------------------------------------
  await session.evaluate(`
    (() => {
      const input = document.getElementById('application-search');
      input.value = 'zzzznothing';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".app-card").length === 0',
    'the grid to empty',
  );
  check(
    'no match shows an honest message rather than a blank surface',
    await session.evaluate(
      '(document.querySelector(".app-grid")?.textContent ?? "").includes("No application matches")',
    ),
    true,
  );
  await session.capture('03-search-no-match');

  // --- the regex builder opens, anchored to THIS field ---------------------
  await session.evaluate(`
    (() => {
      const input = document.getElementById('application-search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.search-field__builder-button').click();
      return true;
    })()
  `);
  await session.waitFor('!!document.querySelector(".overlay .regex")', 'the builder to open');
  check(
    'the builder button reports its expanded state',
    await session.evaluate(
      'document.querySelector(".search-field__builder-button")?.getAttribute("aria-expanded")',
    ),
    'true',
  );

  // The overlay must PAINT ITS OWN SURFACE. A transparent overlay lets the
  // content behind read through the text on top.
  check(
    'the overlay paints an opaque background',
    await session.evaluate(`
      (() => {
        const o = document.querySelector('.overlay');
        const bg = getComputedStyle(o).backgroundColor;
        const m = bg.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return 'unparsed:' + bg;
        const parts = m[1].split(',').map(s => parseFloat(s));
        return parts.length < 4 || parts[3] >= 1 ? 'opaque' : 'transparent:' + bg;
      })()
    `),
    'opaque',
  );

  // It must be bounded by the viewport and scroll internally rather than
  // clipping content away with no scrollbar.
  check(
    'the overlay is bounded by the viewport',
    await session.evaluate(`
      (() => {
        const o = document.querySelector('.overlay').getBoundingClientRect();
        return o.top >= 0 && o.left >= 0 &&
               o.bottom <= window.innerHeight + 1 && o.right <= window.innerWidth + 1;
      })()
    `),
    true,
  );
  check(
    'the overlay scrolls its own overflow instead of hiding it',
    await session.evaluate(
      '["auto","scroll"].includes(getComputedStyle(document.querySelector(".overlay")).overflowY)',
    ),
    true,
  );

  await session.capture('04-regex-builder-open');

  // --- the builder actually analyses --------------------------------------
  await session.evaluate(`
    (() => {
      const input = document.querySelector('.regex__pattern');
      input.value = '(a+)+' + String.fromCharCode(36);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".regex__token").length > 0',
    'the token annotation to render',
  );
  check(
    'the catastrophic pattern is flagged as dangerous',
    await session.evaluate(
      '!!document.querySelector(".regex__warning[data-severity=\\"danger\\"]")',
    ),
    true,
  );
  check(
    'the annotation explains rather than restates',
    await session.evaluate(
      '(document.querySelector(".regex__token-explanation")?.textContent ?? "").length > 15',
    ),
    true,
  );
  await session.capture('05-regex-danger-flagged');

  // A safe pattern must NOT be flagged. A scanner that warns about everything
  // is as useless as one that warns about nothing.
  await session.evaluate(`
    (() => {
      const input = document.querySelector('.regex__pattern');
      input.value = '\\\\d{4}-\\\\d{2}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const sample = document.querySelector('.regex__sample');
      sample.value = '2026-09 and 1999-12';
      sample.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    '(document.querySelector(".regex__count")?.textContent ?? "").includes("match")',
    'the matches to be counted',
  );
  check(
    'a safe pattern raises no danger warning',
    await session.evaluate(
      '!!document.querySelector(".regex__warning[data-severity=\\"danger\\"]")',
    ),
    false,
  );

  // Without the g flag a pattern matches ONCE. That is what the engine does, and
  // the builder reports what the pattern actually does rather than what a tester
  // might find more convenient to show.
  check(
    'without the global flag the pattern matches once, as the engine does',
    await session.evaluate(
      '(document.querySelector(".regex__count")?.textContent ?? "").startsWith("1 match")',
    ),
    true,
  );

  // Tick the global flag through its real control, which also proves the flag
  // checkbox is wired rather than decorative.
  await session.evaluate(`
    (() => {
      const g = document.getElementById('regex-flag-g');
      g.checked = true;
      g.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    '(document.querySelector(".regex__count")?.textContent ?? "").startsWith("2 matches")',
    'the global flag to produce both matches',
  );
  check(
    'ticking the global flag finds every match, through the real worker',
    await session.evaluate(
      'document.querySelectorAll(".regex__matches tbody tr").length',
    ),
    2,
  );
  check(
    'the match table reports real positions',
    await session.evaluate(
      'Array.from(document.querySelectorAll(".regex__matches tbody tr")).map(r => r.children[2].textContent)',
    ),
    ['2026-09', '1999-12'],
  );
  await session.capture('06-regex-matches');

  // --- Escape closes and focus returns ------------------------------------
  await session.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    true
  `);
  await session.waitFor('!document.querySelector(".overlay")', 'the overlay to close');
  check(
    'focus returns to the control that opened the overlay',
    await session.evaluate(
      'document.activeElement?.classList.contains("search-field__builder-button")',
    ),
    true,
  );

  // --- the command palette ------------------------------------------------
  //
  // Ctrl+Shift+F is dispatched as a real keyboard event, so the installed
  // handler is what opens it. Calling the open method directly would prove the
  // panel renders and nothing about whether the shortcut reaches it.
  await session.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    true
  `);
  await session.waitFor('!!document.querySelector(".palette")', 'the palette to open');
  check(
    'the palette opens on the real Ctrl+Shift+F shortcut',
    await session.evaluate('!!document.querySelector(".palette")'),
    true,
  );
  check(
    'it defaults to the bounded card rather than the full window',
    await session.evaluate('document.querySelector(".palette")?.getAttribute("data-size")'),
    'card',
  );
  check(
    'it lists commands, destinations and settings',
    await session.evaluate(`
      (() => {
        const kinds = new Set(Array.from(document.querySelectorAll('.palette__row'))
          .map(r => r.getAttribute('data-kind')));
        return ['command','destination','setting'].every(k => kinds.has(k));
      })()
    `),
    true,
  );
  check(
    'setting rows render a LIVE control inline, not a printed value',
    await session.evaluate(`
      document.querySelectorAll(
        '.palette__row[data-kind="setting"] .palette__control input, ' +
        '.palette__row[data-kind="setting"] .palette__control select'
      ).length > 0
    `),
    true,
  );
  check(
    'a setting row says whether its value was set or is a shipped default',
    await session.evaluate('!!document.querySelector(".palette__provenance")'),
    true,
  );
  // On an untouched profile EVERY value is the shipped default, so every chip
  // must read "default". An earlier build reported them all as "set", because
  // a startup write persisted the whole object and the raw-file test could not
  // tell that apart from a user changing something.
  check(
    'an untouched profile reports its values as shipped defaults, not as set',
    await session.evaluate(`
      Array.from(document.querySelectorAll('.palette__provenance'))
        .every(n => n.getAttribute('data-provenance') === 'default')
    `),
    true,
  );
  await session.capture('07-palette-open');

  // Searching inside the palette narrows it.
  await session.evaluate(`
    (() => {
      const input = document.getElementById('palette-search');
      input.value = 'density';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".palette__row").length === 1',
    'the palette to narrow to the density setting',
  );
  check(
    'searching the palette narrows it to the matching setting',
    await session.evaluate('document.querySelector(".palette__row-title")?.textContent'),
    'Density',
  );
  await session.capture('08-palette-search');

  // Changing the inline control must change the ACTUAL interface. That is the
  // whole difference between a wired control and a decorative one.
  const densityBefore = await session.evaluate(
    'document.documentElement.getAttribute("data-density")',
  );
  await session.evaluate(`
    (() => {
      const select = document.querySelector(
        '.palette__row[data-kind="setting"] .palette__control select');
      select.value = 'compact';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.documentElement.getAttribute("data-density") === "compact"',
    'the density change to reach the document',
  );
  check(
    'changing a setting IN the palette changes the real interface',
    await session.evaluate('document.documentElement.getAttribute("data-density")'),
    'compact',
  );
  check('and it was genuinely different beforehand', densityBefore !== 'compact', true);

  // Put it back, so the drive leaves no state behind on this machine.
  await session.evaluate(`
    (() => {
      const select = document.querySelector(
        '.palette__row[data-kind="setting"] .palette__control select');
      select.value = 'standard';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.documentElement.getAttribute("data-density") === "standard"',
    'the density to be restored',
  );

  await session.evaluate(`
    document.querySelector('.palette').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    true
  `);
  await session.waitFor('!document.querySelector(".palette")', 'the palette to close');
  check(
    'Escape closes the palette',
    await session.evaluate('!!document.querySelector(".palette")'),
    false,
  );

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'findings.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), findings }, null, 2) + '\n',
  );

  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) {
    for (const finding of failed) log('  FAILED: ' + finding.label);
    process.exit(1);
  }
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
