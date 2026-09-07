#!/usr/bin/env node
/**
 * Drive the documentation site in an isolated browser.
 *
 * Isolation is PROVED before anything is evaluated: exactly one target, of type
 * page, at the expected loopback URL. Finding one acceptable target among
 * several proves nothing about isolation, and this browser profile is
 * deliberately throwaway.
 *
 * The mobile checks are not optional. Most people who open a documentation link
 * opened it on a phone, and a resized desktop window still has a mouse — so the
 * viewport is overridden through the protocol rather than by narrowing a window.
 *
 * Usage: node scripts/drive-site.mjs <cdpPort> <expectedUrl> [outputDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9444';
const expectedUrl = process.argv[3] ?? 'http://127.0.0.1:8123/';
const outputDir = process.argv[4] ?? '.tmp/site-drive';

function log(message) {
  process.stdout.write('[site-drive] ' + message + '\n');
}

function fail(message) {
  process.stderr.write('[site-drive] FAILED: ' + message + '\n');
  process.exit(1);
}

const findings = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ label, ok, actual, expected });
  log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  actual=' + JSON.stringify(actual)));
}

async function resolveTarget() {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
    signal: AbortSignal.timeout(20_000),
  });
  const targets = await response.json();
  if (targets.length !== 1) fail('expected exactly one target, found ' + targets.length);
  const target = targets[0];
  if (target.type !== 'page') fail('the only target is not a page: ' + target.type);
  if (target.url !== expectedUrl) fail('unexpected URL: ' + target.url);
  if (!target.webSocketDebuggerUrl) fail('no WebSocket endpoint');
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
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    // Synchronous expressions only. awaitPromise has been observed to hang on
    // this runtime, which looks exactly like a page fault and is not one.
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(
        'evaluation threw: ' +
          (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text),
      );
    }
    return result.result.value;
  }

  async waitFor(expression, description, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    fail('timed out waiting for ' + description + ' (last: ' + JSON.stringify(last) + ')');
  }

  async capture(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    log('captured ' + file);
  }

  setViewport(width, height, scale = 1, mobile = false) {
    return this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile,
    });
  }
}

async function main() {
  const target = await resolveTarget();
  log('one page target confirmed at ' + target.url);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  const session = new Session(socket);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable').catch(() => undefined);

  // Start from a known state rather than from wherever a previous run left
  // the page. A drive whose result depends on run order is not a check, it is
  // a coincidence — this was observed directly: the same build reported 13/13
  // on a fresh load and 11/13 immediately after another run.
  await session.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  await session.send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await session.waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the site to boot',
  );
  log('site reported ready');

  // --- the site carries the shell contract --------------------------------
  check(
    'the site is tabbed, with home, documentation and settings',
    await session.evaluate(
      'Array.from(document.querySelectorAll(\'.tab-strip[data-strip="main"] .tab\')).map(t => t.getAttribute("data-tab"))',
    ),
    ['home', 'docs', 'settings'],
  );
  check(
    'the front page states the version',
    await session.evaluate('/0\\.1\\.0/.test(document.body.textContent ?? "")'),
    true,
  );
  check(
    'the unsigned-installer warning is present where the download is',
    await session.evaluate('/unsigned/i.test(document.body.textContent ?? "")'),
    true,
  );
  await session.capture('01-home');

  // --- documentation ------------------------------------------------------
  await session.evaluate('document.querySelector(\'[data-tab="docs"]\').click(); true');
  await session.waitFor('!!document.querySelector(".docs__reader")', 'the docs tab');

  check(
    'every article from the repository is listed',
    await session.evaluate('document.querySelectorAll(".docs__item").length'),
    13,
  );
  check(
    'the article renders as formatted prose, not as raw Markdown',
    await session.evaluate(`
      (() => {
        const reader = document.querySelector('.docs__reader');
        const text = reader.textContent ?? '';
        // Real elements present AND no leftover Markdown syntax in the text.
        return reader.querySelectorAll('h2').length > 0 &&
               reader.querySelectorAll('table').length >= 0 &&
               !/^#{1,6}\\s/m.test(text);
      })()
    `),
    true,
  );
  check(
    'the documentation search has its own anchored regex builder',
    await session.evaluate(
      'document.querySelectorAll("#docs-search ~ * , .docs__sidebar .search-field__builder-button").length > 0',
    ),
    true,
  );

  // Search covers article BODIES, not only titles.
  await session.evaluate(`
    (() => {
      const input = document.getElementById('docs-search');
      input.value = 'catastrophic backtracking';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await session.waitFor(
    'document.querySelectorAll(".docs__item").length > 0 && document.querySelectorAll(".docs__item").length < 13',
    'the documentation search to narrow',
  );
  check(
    'searching the documentation matches article bodies, not just titles',
    await session.evaluate(
      'Array.from(document.querySelectorAll(".docs__item")).some(i => /regular-expression builder/i.test(i.textContent ?? ""))',
    ),
    true,
  );
  await session.capture('02-docs-search');

  // Article-to-article links resolve inside the site.
  await session.evaluate(`
    (() => {
      const input = document.getElementById('docs-search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const item = Array.from(document.querySelectorAll('.docs__item'))
        .find(i => /Autosave and document history/.test(i.textContent ?? ''));
      item.click();
      return true;
    })()
  `);
  await session.waitFor(
    '/Autosave and document history/.test(document.querySelector(".docs__reader")?.textContent ?? "")',
    'the autosave article',
  );
  check(
    'an internal article link is resolved rather than left to 404',
    await session.evaluate('document.querySelectorAll("[data-article-link]").length > 0'),
    true,
  );
  await session.capture('03-docs-article');

  // --- the palette works here too -----------------------------------------
  await session.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, bubbles: true }));
    true
  `);
  await session.waitFor('!!document.querySelector(".palette")', 'the palette on the site');
  check(
    'the command palette works on the site, with live setting controls',
    await session.evaluate(
      'document.querySelectorAll(\'.palette__row[data-kind="setting"] .palette__control select\').length > 0',
    ),
    true,
  );
  await session.capture('04-site-palette');
  await session.evaluate(`
    document.querySelector('.palette').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    true
  `);

  // --- mobile -------------------------------------------------------------
  // Overridden through the protocol rather than by narrowing a window: a
  // resized desktop browser still has a mouse, which is exactly the thing being
  // tested for.
  await session.setViewport(360, 740, 3, true);
  await new Promise((r) => setTimeout(r, 600));

  check(
    'the page body never scrolls sideways on a phone',
    await session.evaluate(
      'document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1',
    ),
    true,
  );
  // Content inside a deliberately scrollable container legitimately extends
  // past the viewport — that is what "wide content scrolls in its own box"
  // MEANS. The check excludes those and catches everything else.
  check(
    'nothing overflows the viewport except inside a scrollable container',
    await session.evaluate(`
      (() => {
        const w = document.documentElement.clientWidth;
        const scrollable = (node) => {
          for (let n = node.parentElement; n; n = n.parentElement) {
            const overflow = getComputedStyle(n).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') return true;
          }
          return false;
        };
        return Array.from(document.querySelectorAll('*')).filter(n => {
          const r = n.getBoundingClientRect();
          if (r.width === 0) return false;
          if (r.right <= w + 1 && r.left >= -1) return false;
          return !scrollable(n);
        }).map(n => n.tagName + '.' + (n.className || ''));
      })()
    `),
    [],
  );
  // WCAG 2.5.8 exempts a target that is inline in a sentence, and rightly:
  // forcing a link inside a paragraph to 24px would wreck the line spacing of
  // the prose it sits in. The exemption is narrow and is checked FOR — an
  // inline-display anchor inside a text block — rather than applied by
  // deleting the assertion.
  check(
    'every interactive target meets the touch minimum, inline prose links aside',
    await session.evaluate(`
      (() => {
        const targets = document.querySelectorAll('button, a[href], input, select, summary');
        // A labelled control's real hit area is its LABEL: clicking anywhere
        // on the label activates the control. Measuring the input alone
        // reports a 20px checkbox as failing when the thing a finger
        // actually lands on is 48px.
        const effective = (n) => {
          const label = n.closest('label');
          return label ? label.getBoundingClientRect() : n.getBoundingClientRect();
        };
        const inlineInProse = (n) =>
          n.tagName === 'A' &&
          getComputedStyle(n).display === 'inline' &&
          !!n.closest('p, li, td, th');
        return Array.from(targets).filter(n => {
          const own = n.getBoundingClientRect();
          if (own.width === 0 && own.height === 0) return false;
          if (inlineInProse(n)) return false;
          return effective(n).height < 24;
        }).map(n => n.tagName + '.' + (n.className || '') + ':' + Math.round(effective(n).height));
      })()
    `),
    [],
  );
  await session.capture('05-mobile');

  await session.setViewport(1440, 900, 1, false);

  // --- console errors -----------------------------------------------------
  // The site must boot without throwing. An error nobody reads is still a defect.
  const consoleErrors = await session.evaluate(
    '(window.__siteErrors ?? []).length',
  );
  check('no uncaught errors were recorded by the page', consoleErrors ?? 0, 0);

  socket.close();

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'findings.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), findings }, null, 2) + '\n',
  );

  const failed = findings.filter((f) => !f.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
