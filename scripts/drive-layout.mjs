/**
 * The layout matrix: clipping, overflow and target size, measured.
 *
 * Every surface, at four display scales, at the minimum supported width and a
 * standard one, in all three language modes, in both themes. Not a gallery of
 * pictures somebody has to look at - a MEASUREMENT, because a human eye
 * scanning ninety-six screenshots finds the obvious ones and misses the
 * three-pixel truncation on the longest bilingual label, which is the one that
 * matters.
 *
 * WHAT IT MEASURES, AND WHY EACH ONE IS A REAL DEFECT RATHER THAN A NUMBER.
 *
 *   Document overflow - the page scrolls sideways. Content is off the edge and
 *   there is no way to know what.
 *
 *   Clipped text - an element whose content is wider or taller than its box
 *   while its overflow is hidden. The words are gone with no scrollbar to say
 *   so, which is the failure a screenshot shows as a perfectly tidy label that
 *   happens to end early.
 *
 *   Off-viewport controls - something interactive whose box sits outside the
 *   window. It cannot be clicked and, on a narrow window, often cannot be
 *   reached at all.
 *
 *   Undersized targets - an interactive control below the touch-target size the
 *   application itself declares.
 *
 * A container that scrolls on purpose is NOT clipping, so anything with a real
 * scrollbar is excluded. Reporting those would bury the genuine findings under
 * every list in the application, which is how a matrix like this stops being
 * read.
 */

import fs from 'node:fs';
import path from 'node:path';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/layout';
const only = process.argv[4] ?? '';

const findings = [];
const log = (message) => process.stdout.write('[layout] ' + message + '\n');
const fail = (message) => {
  process.stderr.write('[layout] FAILED: ' + message + '\n');
  process.exit(1);
};

/** The tuple every finding is bound to. Reported with each one. */
const SCALES = [1, 1.25, 1.5, 2];
const WIDTHS = [
  { name: 'minimum', width: 900, height: 640 },
  { name: 'standard', width: 1440, height: 900 },
];
const LANGUAGES = ['en', 'yue', 'bilingual'];
const THEMES = ['light', 'dark'];

async function main() {
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const pages = targets.filter((target) => target.type === 'page');
  if (pages.length !== 1) {
    fail('expected exactly one page target, saw ' + pages.length);
  }
  log('one page target confirmed');

  const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not connect')), { once: true });
  });

  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        socket.removeEventListener('message', listener);
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

  const waitFor = async (expression, description, timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      last = await evaluate(expression);
      if (last) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error('timed out waiting for ' + description + ' (last value: ' + last + ')');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  fs.mkdirSync(outputDir, { recursive: true });

  // The measurement itself, run inside the page. Kept as one expression so a
  // whole tuple costs one round trip rather than one per element.
  const MEASURE = `
    (() => {
      const target = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--workspace-touch-target'),
      ) || 48;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const problems = [];

      /** The nearest ancestor that genuinely scrolls, or the document. */
      const scrollerFor = (node) => {
        let current = node.parentElement;
        while (current !== null) {
          const style = getComputedStyle(current);
          const scrollsY =
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            current.scrollHeight > current.clientHeight + 1;
          const scrollsX =
            (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
            current.scrollWidth > current.clientWidth + 1;
          if (scrollsY || scrollsX) return current;
          current = current.parentElement;
        }
        return document.documentElement;
      };

      /** Whether the node sits inside what that scroller can actually reach. */
      const reachable = (node, box, scroller) => {
        const frame = scroller.getBoundingClientRect();
        const top = box.top - frame.top + scroller.scrollTop;
        const left = box.left - frame.left + scroller.scrollLeft;
        return (
          box.bottom - frame.top + scroller.scrollTop > -1 &&
          top < scroller.scrollHeight + 1 &&
          box.right - frame.left + scroller.scrollLeft > -1 &&
          left < scroller.scrollWidth + 1
        );
      };

      const name = (node) => {
        const label = node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 40);
        return node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(' ')[0] : '')
          + (label ? ' "' + label + '"' : '');
      };

      // The document itself must not scroll sideways.
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) {
        problems.push({
          kind: 'document-overflow',
          element: 'document',
          detail: root.scrollWidth + ' wide in a ' + root.clientWidth + ' viewport',
        });
      }

      for (const node of document.querySelectorAll('*')) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;

        // Deliberately not visible: a screen-reader-only label, or a capture
        // surface painted at zero opacity. Both are one pixel with far more
        // content than that BY DESIGN, so reporting them as clipped would put
        // three permanent findings at the top of every run.
        const invisible =
          Number(style.opacity) === 0 ||
          node.classList.contains('visually-hidden') ||
          style.clipPath === 'inset(50%)';
        if (invisible) continue;

        // A frame that clips ON PURPOSE, declared by the surface itself rather
        // than guessed at from its shape. The spreadsheet's column and row
        // headers are the case: an absolutely positioned track slides behind a
        // fixed window so the headers stay locked to the grid, and every one of
        // those headers is reachable by scrolling the grid.
        //
        // Declared rather than inferred, so a surface that starts clipping by
        // accident cannot quietly inherit the exemption.
        if (node.dataset.clip === 'viewport') continue;

        // Clipped content: bigger than its box, with the overflow hidden and no
        // scrollbar. A container that scrolls on purpose is not clipping, and
        // neither is text that ends in an ellipsis - that truncation is
        // DISCLOSED, which is the whole difference between a defect and a
        // design decision.
        const hiddenX = style.overflowX === 'hidden' || style.overflowX === 'clip';
        const hiddenY = style.overflowY === 'hidden' || style.overflowY === 'clip';
        // An ellipsis discloses truncated TEXT. It says nothing about a child
        // element that is being cut off, so the exemption only holds while
        // every child still fits. Watched failing: without this second half the
        // exemption excused a tab whose ICON was a quarter clipped, and the
        // matrix reported clean on a defect that was plainly there.
        const childrenFit = [...node.children].every((child) => {
          const childBox = child.getBoundingClientRect();
          return childBox.right <= box.right + 1 && childBox.bottom <= box.bottom + 1;
        });
        const disclosed = style.textOverflow === 'ellipsis' && childrenFit;
        const overX = !disclosed && node.scrollWidth - node.clientWidth > 1;
        const overY = node.scrollHeight - node.clientHeight > 1;
        // The page itself is covered by the document-overflow check above and by
        // reachability below. Measured as an ELEMENT it reports a phantom: a
        // scroll container's overflowing children inflate body.scrollHeight in
        // this engine even though the container clips them properly and every
        // one of them is reachable by scrolling - which the out-of-reach check
        // proves separately, at zero.
        const isPage = node === document.body || node === root;
        if (!isPage && ((hiddenX && overX) || (hiddenY && overY))) {
          problems.push({
            kind: 'clipped',
            element: name(node),
            detail:
              (hiddenX && overX ? 'content ' + node.scrollWidth + ' in ' + node.clientWidth + ' across' : '') +
              (hiddenY && overY ? ' content ' + node.scrollHeight + ' in ' + node.clientHeight + ' down' : ''),
          });
        }

        const interactive =
          node.matches('button, a[href], input, select, textarea, [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])');
        if (!interactive) continue;
        if (node.disabled === true) continue;

        // Out of reach: outside the scrollable extent of whatever actually
        // scrolls around it.
        //
        // NOT simply below the fold, and NOT measured against the document.
        // The shell's scroller is a panel, not the page, so testing the
        // document's own scrollHeight reports every card below the first row as
        // unreachable when scrolling the panel reaches all of them - which
        // buries every real finding and is how a report like this stops being
        // read.
        const scroller = scrollerFor(node);
        const outOfReach = !reachable(node, box, scroller);
        if (outOfReach) {
          problems.push({
            kind: 'out-of-reach',
            element: name(node),
            detail:
              Math.round(box.left) + ',' + Math.round(box.top) +
              ' with ' + width + 'x' + height + ', scroller ' +
              (scroller === root ? 'document' : (String(scroller.className).split(' ')[0] || scroller.tagName)) +
              ' ' + scroller.scrollHeight + ' tall',
          });
          continue;
        }

        // Below the size the application itself declares. A checkbox or radio
        // is measured through whatever label is genuinely associated with it,
        // wrapping OR by id, because clicking that label is what actually
        // toggles it. With no associated label the box really is the target.
        const isBoxed = node.matches('input[type="checkbox"], input[type="radio"]');
        const associated =
          node.id === ''
            ? null
            : document.querySelector('label[for="' + CSS.escape(node.id) + '"]');
        const owner = isBoxed ? (node.closest('label') ?? associated ?? node) : node;
        const measured = owner.getBoundingClientRect();
        if (measured.height + 1 < target) {
          problems.push({
            kind: 'small-target',
            element: name(node),
            detail: Math.round(measured.height) + 'px against a ' + target + 'px target',
          });
        }
      }

      return problems;
    })()
  `;

  const tabs = await evaluate(`
    [...document.querySelectorAll('[role="tab"]')].map(t => t.getAttribute('data-tab') || t.textContent.trim())
  `);
  log('surfaces: ' + tabs.join(', '));

  const rows = [];
  let measured = 0;

  for (const scale of SCALES) {
    for (const viewport of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: scale,
        mobile: false,
      });

      for (const language of LANGUAGES) {
        for (const theme of THEMES) {
          // Set through the real settings bridge, not by poking a class onto
          // the root: a class set by hand proves the stylesheet works and says
          // nothing about whether the application would ever set it.
          await evaluate(`
            window.__layoutDone = false;
            (async () => {
              await window.workspace.settings.update({
                languageMode: '${language}',
                appearance: { theme: '${theme}' },
              });
              window.__layoutDone = true;
            })(); true
          `);
          await waitFor('window.__layoutDone === true', 'the settings write');
          await new Promise((resolve) => setTimeout(resolve, 220));

          for (const tab of tabs) {
            if (only !== '' && tab !== only) continue;
            await evaluate(`
              (() => {
                const tab = [...document.querySelectorAll('[role="tab"]')]
                  .find(t => (t.getAttribute('data-tab') || t.textContent.trim()) === ${JSON.stringify(tab)});
                if (tab) tab.click();
                return true;
              })()
            `);
            await new Promise((resolve) => setTimeout(resolve, 200));

            const problems = await evaluate(MEASURE);
            measured += 1;
            for (const problem of problems) {
              rows.push({
                ...problem,
                surface: tab,
                scale,
                viewport: viewport.name,
                width: viewport.width,
                language,
                theme,
              });
            }
          }
        }
      }
    }
  }

  await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  // Put the profile back, so the next driver does not start in Cantonese dark.
  await evaluate(`
    window.__layoutDone = false;
    (async () => {
      await window.workspace.settings.update({
        languageMode: 'en',
        appearance: { theme: 'system' },
      });
      window.__layoutDone = true;
    })(); true
  `);
  await waitFor('window.__layoutDone === true', 'the profile reset');

  // Collapsed: one line per distinct defect rather than one per tuple, with the
  // tuples it occurred at. Ninety-six copies of one finding is a report nobody
  // reads to the end.
  const byDefect = new Map();
  for (const row of rows) {
    const key = row.kind + '|' + row.surface + '|' + row.element;
    const entry = byDefect.get(key) ?? { ...row, occurrences: [] };
    entry.occurrences.push(
      row.scale + 'x ' + row.viewport + ' ' + row.language + ' ' + row.theme,
    );
    byDefect.set(key, entry);
  }

  const report = {
    measuredTuples: measured,
    surfaces: tabs,
    scales: SCALES,
    widths: WIDTHS.map((entry) => entry.name + ' (' + entry.width + ')'),
    languages: LANGUAGES,
    themes: THEMES,
    findings: [...byDefect.values()].map((entry) => ({
      kind: entry.kind,
      surface: entry.surface,
      element: entry.element,
      detail: entry.detail,
      occurrences: entry.occurrences.length,
      firstAt: entry.occurrences[0],
    })),
  };

  fs.writeFileSync(
    path.join(outputDir, 'layout-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );

  log('');
  log(measured + ' tuples measured');
  for (const finding of report.findings) {
    log(
      finding.kind.padEnd(18) +
        finding.surface.padEnd(12) +
        finding.element +
        '  (' + finding.detail.trim() + ', ' + finding.occurrences + ' tuples, first at ' + finding.firstAt + ')',
    );
  }
  log('');
  log(report.findings.length + ' distinct findings across ' + measured + ' tuples');
  log('written to ' + path.join(outputDir, 'layout-report.json'));

  socket.close();
  if (report.findings.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
