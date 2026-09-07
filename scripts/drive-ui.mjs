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

  // Start from a known state rather than from wherever a previous run left the
  // window. A drive whose result depends on run order is not a check, it is a
  // coincidence — this one failed outright when it happened to run after the
  // Writer drive had left the application on a different tab.
  await session.send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await session.waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell to finish booting',
  );
  log('shell reported ready');

  // Reset through the REAL control, so later assertions about an untouched
  // profile hold regardless of what an earlier run left behind. Driving the
  // button rather than deleting a file also exercises the path a person takes.
  await session.evaluate(`
    (() => {
      const tab = document.querySelector('[data-tab="settings"]');
      if (tab) tab.click();
      return true;
    })()
  `);
  await session.waitFor('!!document.querySelector(".settings__reset-all")', 'the settings tab');
  await session.evaluate('document.querySelector(".settings__reset-all").click(); true');

  // The destructive gate stands in front of this now, so it is driven here
  // too. Waiting a fixed 600ms instead left the gate open and the reset never
  // happened - so the profile stayed dirty and the untouched-profile check
  // failed later, in a completely different section, blaming the wrong thing.
  await session.waitFor('!!document.querySelector(".gate__slide")', 'the destructive gate');
  await session.evaluate(`
    (() => {
      for (const key of document.querySelectorAll('.gate__key input')) {
        key.checked = true;
        key.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const slider = document.querySelector('.gate__slide input');
      slider.value = slider.max;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    '!document.querySelector(".gate__actions button:last-child")?.disabled',
    'the gate opening',
  );
  await session.evaluate(`document.querySelector('.gate__actions button:last-child').click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 600));

  await session.evaluate(`
    (() => {
      const tab = document.querySelector('[data-tab="home"]');
      if (tab) tab.click();
      return true;
    })()
  `);
  await session.waitFor('!!document.getElementById("application-search")', 'the home tab');
  log('profile reset to shipped defaults through the real control');

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
    'every application is honestly labelled: built ones openable, the rest not',
    // Derived, not pinned. The first version asserted the exact split of one
    // built against eight unbuilt, so shipping the SECOND application turned
    // this red — a check failing because the product got better is a check
    // that will be edited to shut it up rather than read.
    //
    // What actually matters is the honesty property: every card carries a
    // verdict, the verdicts add up to the full set of nine, at least one is
    // built, and nothing is left unlabelled.
    await session.evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.app-card')];
        const built = cards.filter(c => c.getAttribute('data-available') === 'true');
        const notBuilt = cards.filter(c => c.getAttribute('data-available') === 'false');
        return [
          cards.length === 9,
          built.length + notBuilt.length === cards.length,
          built.length >= 1,
          notBuilt.every(c => (c.textContent ?? '').toLowerCase().includes('not built')),
        ];
      })()
    `),
    [true, true, true, true],
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

  // --- the settings surface ------------------------------------------------
  await session.evaluate(`
    document.querySelector('[data-tab="settings"]').click();
    true
  `);
  await session.waitFor('!!document.querySelector(".settings")', 'the settings tab to open');

  check(
    'the settings surface is itself tabbed, with real sections',
    await session.evaluate(
      'Array.from(document.querySelectorAll(".settings__tabs .tab")).map(t => t.getAttribute("data-tab"))',
    ),
    ['language', 'appearance', 'attention', 'saving', 'navigation'],
  );

  // MEASURED, not inferred from the stylesheet. A nested strip previously
  // inherited the main strip's vertical layout because :root[data-tab-edge]
  // outranked the override written for it — the override was a silent no-op,
  // and only the real geometry showed it.
  check(
    'the nested strip lays out horizontally, whatever the main strip does',
    await session.evaluate(
      'getComputedStyle(document.querySelector(\'.tab-strip[data-strip="nested"]\')).flexDirection',
    ),
    'row',
  );
  check(
    'the main strip is unaffected and stays vertical on its default edge',
    await session.evaluate(
      'getComputedStyle(document.querySelector(\'.tab-strip[data-strip="main"]\')).flexDirection',
    ),
    'column',
  );
  check(
    'every section tab sits on one row rather than stacking',
    await session.evaluate(`
      (() => {
        const tops = new Set([...document.querySelectorAll('.settings__tabs .tab')]
          .map(t => Math.round(t.getBoundingClientRect().top)));
        return tops.size === 1;
      })()
    `),
    true,
  );

  check(
    'each settings section carries its own search field',
    await session.evaluate('document.querySelectorAll(".settings__section .search-field").length'),
    1,
  );
  check(
    'that search field has its own anchored regex builder',
    await session.evaluate(
      'document.querySelectorAll(".settings__section .search-field__builder-button").length',
    ),
    1,
  );
  check(
    'every setting row explains what it does, behind progressive disclosure',
    await session.evaluate(`
      (() => {
        const rows = document.querySelectorAll('.settings__row');
        const withExplanation = document.querySelectorAll('.settings__row .settings__explanation');
        return rows.length > 0 && rows.length === withExplanation.length;
      })()
    `),
    true,
  );
  check(
    'every setting row states its provenance and NAMES the shipped value',
    await session.evaluate(`
      (() => {
        const lines = [...document.querySelectorAll('.settings__provenance')];
        return lines.length > 0 && lines.every(n => /\\(.+\\)/.test(n.textContent ?? ''));
      })()
    `),
    true,
  );
  await session.capture('09-settings');

  // Searching a settings section filters it, and says when the match is on a
  // different tab rather than letting the user conclude it does not exist.
  await session.evaluate(`
    (() => {
      const input = document.getElementById('settings-search-language');
      input.value = 'density';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".settings__row").length === 0',
    'the language section to report no local match',
  );
  check(
    'a match on another tab is named rather than reported as missing',
    await session.evaluate(
      '(document.querySelector(".settings__empty")?.textContent ?? "").includes("another tab")',
    ),
    true,
  );
  await session.capture('10-settings-cross-tab');

  // --- notifications ------------------------------------------------------
  await session.evaluate(`
    document.querySelector('[data-tab="notifications"]').click();
    true
  `);
  await session.waitFor('!!document.querySelector(".centre")', 'the notification centre');

  check(
    'the notification centre has its own search with an anchored regex builder',
    await session.evaluate(
      'document.querySelectorAll(".centre .search-field__builder-button").length',
    ),
    1,
  );
  // Matched structurally. The select-all label carries a live count, so pinning
  // its exact text would assert a fact about how many notifications this drive
  // happens to have produced rather than about the feature.
  check(
    'it offers real bulk actions, not just a list',
    await session.evaluate(`
      Array.from(document.querySelectorAll('.centre__bulk'))
        .map(b => (b.textContent ?? '').replace(/\\d+/g, 'N'))
    `),
    ['Select all N', 'Invert selection', 'Clear selection', 'Dismiss selected', 'Copy all'],
  );
  check(
    'a bulk action that cannot act names the condition that is unmet',
    await session.evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('.centre__bulk'))
          .find(x => x.textContent === 'Dismiss selected');
        return b.hasAttribute('disabled') && /Select one or more/.test(b.getAttribute('title') ?? '');
      })()
    `),
    true,
  );

  // Everything below goes through a REAL user path.
  //
  // An earlier draft of this reached for a window.__shell hook to push test
  // notifications of each severity. That would have put a debug backdoor into
  // shipped code for the convenience of a test — a worse trade than driving one
  // real path here and unit-testing the class's own logic separately, which is
  // what happens instead.
  await session.evaluate(`
    document.querySelector('[data-tab="settings"]').click();
    true
  `);
  await session.waitFor('!!document.querySelector(".settings__reset-all")', 'the settings tab');

  // Counted RELATIVE to what is already there. This drive resets the profile at
  // the start, which itself reports, so asserting an absolute count here would
  // be asserting a fact about the drive rather than about the feature.
  const toastsBefore = await session.evaluate('document.querySelectorAll(".toast").length');
  await session.evaluate('document.querySelector(".settings__reset-all").click(); true');

  // The destructive gate now stands in front of resetting every setting, so it
  // is driven rather than worked around. That makes this the stronger check:
  // it proves the gate is genuinely in the way of the real button, not merely
  // present somewhere in the source.
  await session.waitFor('!!document.querySelector(".gate__slide")', 'the destructive gate');
  await session.evaluate(`
    (() => {
      const keys = [...document.querySelectorAll('.gate__key input')];
      for (const key of keys) {
        key.checked = true;
        key.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const slider = document.querySelector('.gate__slide input');
      slider.value = slider.max;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    '!document.querySelector(".gate__actions button:last-child")?.disabled',
    'the gate opening once both keys and the full slider are given',
  );
  await session.evaluate(`document.querySelector('.gate__actions button:last-child').click(); true`);

  await session.waitFor(
    'document.querySelectorAll(".toast").length > ' + toastsBefore,
    'the reset to report',
  );

  check(
    'a real action produces a real non-blocking toast',
    (await session.evaluate('document.querySelectorAll(".toast").length')) > toastsBefore,
    true,
  );
  check(
    'an informational toast does not interrupt a screen reader',
    await session.evaluate('document.querySelector(".toast")?.getAttribute("role")'),
    'status',
  );
  check(
    'its dismiss control is a real touch target, not a tiny cross',
    await session.evaluate(`
      (() => {
        const r = document.querySelector('.toast__dismiss').getBoundingClientRect();
        return Math.round(Math.min(r.width, r.height));
      })()
    `),
    36,
  );
  await session.capture('11-notifications');

  await session.evaluate(`
    document.querySelector('[data-tab="notifications"]').click();
    true
  `);
  await session.waitFor(
    'document.querySelectorAll(".centre__row").length > 0',
    'the notification to appear in the centre',
  );
  const centreRows = await session.evaluate('document.querySelectorAll(".centre__row").length');
  check(
    'severity is carried as a WORD, not only as a colour',
    await session.evaluate('document.querySelector(".centre__severity")?.textContent'),
    'success',
  );

  await session.evaluate(`
    (() => {
      Array.from(document.querySelectorAll('.centre__bulk'))
        .find(b => /^Select all/.test(b.textContent ?? '')).click();
      return true;
    })()
  `);
  await session.waitFor(
    '/' + centreRows + ' selected/.test(document.querySelector(".centre__summary")?.textContent ?? "")',
    'the selection to register',
  );
  await session.evaluate(`
    (() => {
      Array.from(document.querySelectorAll('.centre__bulk'))
        .find(b => b.textContent === 'Dismiss selected').click();
      return true;
    })()
  `);
  await session.waitFor(
    '/dismissed/.test(document.querySelector(".centre__summary")?.textContent ?? "")',
    'the bulk dismiss to report',
  );
  check(
    'the bulk action reports what HAPPENED, not what was selected',
    await session.evaluate('document.querySelector(".centre__summary")?.textContent'),
    centreRows + ' dismissed.',
  );
  check(
    'dismissed is not deleted: the centre still lists them',
    await session.evaluate('document.querySelectorAll(".centre__row").length'),
    centreRows,
  );
  check(
    'and every one is now marked dismissed',
    await session.evaluate(
      'document.querySelectorAll(\'.centre__row[data-dismissed="true"]\').length',
    ),
    centreRows,
  );
  check(
    'the toast is gone from the screen',
    await session.evaluate('document.querySelectorAll(".toast").length'),
    0,
  );
  await session.capture('12-notifications-dismissed');

  // --- the attention modes actually do something ---------------------------
  //
  // These five switches persisted a value and changed nothing at all before
  // this check existed. A setting with no reader is a decorative control, and no
  // capture reveals it — only measuring the running interface does. So each
  // assertion below compares a REAL computed value before and after.
  await session.evaluate(`
    document.querySelector('[data-tab="settings"]').click();
    true
  `);
  await session.waitFor('!!document.querySelector(".settings__tabs")', 'the settings tab');
  await session.evaluate(`
    document.querySelector('.settings__tabs [data-tab="attention"]').click();
    true
  `);
  await session.waitFor(
    'document.querySelectorAll(".settings__row").length === 5',
    'the five attention settings',
  );

  const focusBefore = await session.evaluate(
    'getComputedStyle(document.querySelector(".status-bar")).opacity',
  );
  await session.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('.settings__row'))
        .find(r => r.getAttribute('data-path') === 'adhd.focus');
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()
  `);
  await session.waitFor(
    'document.documentElement.getAttribute("data-focus-mode") === "on"',
    'focus mode to reach the document',
  );
  const focusAfter = await session.evaluate(
    'getComputedStyle(document.querySelector(".status-bar")).opacity',
  );
  check('Focus mode changes what is actually rendered', focusBefore !== focusAfter, true);
  check(
    'Focus mode DIMS rather than hides: everything stays present',
    await session.evaluate(
      'document.querySelector(".status-bar") !== null && getComputedStyle(document.querySelector(".status-bar")).display !== "none"',
    ),
    true,
  );

  // Time awareness must put a real readout where the work is.
  await session.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('.settings__row'))
        .find(r => r.getAttribute('data-path') === 'adhd.timeAwareness');
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()
  `);
  await session.waitFor('!!document.querySelector(".attention__time")', 'the elapsed readout');
  check(
    'Time awareness shows elapsed time in the status bar, not buried in settings',
    await session.evaluate(
      '!!document.querySelector(".status-bar .attention__time")',
    ),
    true,
  );
  check(
    'and it states a number rather than nagging about one',
    await session.evaluate(
      '/(under a minute|\\d+\\s*[hm])/.test(document.querySelector(".attention__value")?.textContent ?? "")',
    ),
    true,
  );

  // One thing at a time gives a real, user-chosen field.
  await session.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('.settings__row'))
        .find(r => r.getAttribute('data-path') === 'adhd.oneThingAtATime');
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()
  `);
  await session.waitFor('!!document.querySelector("#attention-next-action")', 'the next-action field');
  check(
    'One thing at a time offers a field the user fills, not a guessed next step',
    await session.evaluate(
      'document.querySelector("#attention-next-action")?.getAttribute("placeholder")',
    ),
    'The one thing you are doing next',
  );

  // Low stimulation must visibly quieten the interface.
  const saturationBefore = await session.evaluate('getComputedStyle(document.body).filter');
  await session.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('.settings__row'))
        .find(r => r.getAttribute('data-path') === 'adhd.lowStimulation');
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()
  `);
  await session.waitFor(
    'document.documentElement.getAttribute("data-low-stimulation") === "on"',
    'low stimulation to reach the document',
  );
  const saturationAfter = await session.evaluate('getComputedStyle(document.body).filter');
  check(
    'Low stimulation genuinely quietens the interface',
    saturationBefore !== saturationAfter && /saturate/.test(String(saturationAfter)),
    true,
  );
  await session.capture('13-attention-modes');

  // Each is independent: turning one off must leave the others alone.
  await session.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('.settings__row'))
        .find(r => r.getAttribute('data-path') === 'adhd.focus');
      row.querySelector('input[type=checkbox]').click();
      return true;
    })()
  `);
  await session.waitFor(
    'document.documentElement.getAttribute("data-focus-mode") === "off"',
    'focus mode to turn off',
  );
  check(
    'the modes are independent: turning one off leaves the others on',
    await session.evaluate(`
      [
        document.documentElement.getAttribute('data-focus-mode'),
        document.documentElement.getAttribute('data-low-stimulation'),
        document.documentElement.getAttribute('data-time-awareness'),
        document.documentElement.getAttribute('data-one-thing'),
      ]
    `),
    ['off', 'on', 'on', 'on'],
  );

  // ------------------------------------------------- the rest of the shell --

  // Every remaining surface gets its own capture, so the README shows the whole
  // application rather than the parts somebody happened to script a check for.
  // A surface with no picture is a surface a reader has to imagine.

  const SURFACES = [
    { tab: 'narrator', name: '33-narrator' },
    { tab: 'find-a-tab', name: '34-tab-search' },
    { tab: 'locks', name: '35-locks' },
    { tab: 'history', name: '38-history' },
    { tab: 'changelog', name: '39-changelog' },
  ];

  const reached = [];
  for (const surface of SURFACES) {
    const found = await session.evaluate(`
      (() => {
        const tab = [...document.querySelectorAll('[role="tab"]')]
          .find(t => t.getAttribute('data-tab') === ${JSON.stringify(surface.tab)});
        if (!tab) return false;
        tab.click();
        return true;
      })()
    `);
    if (!found) continue;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await session.capture(surface.name);
    reached.push(surface.tab);
  }

  check(
    // Named, so a surface that quietly stopped being reachable fails here
    // rather than silently dropping out of the gallery. A capture harness that
    // records a gap instead of failing lets a real defect through a green run.
    'every remaining shell surface was reached and captured',
    reached,
    SURFACES.map((surface) => surface.tab),
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
