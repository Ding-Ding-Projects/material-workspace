#!/usr/bin/env node
/**
 * Drive PDF in the built application.
 *
 * The redaction checks are the point. A redaction verified by looking at the
 * rendered page is not verified at all — that is exactly the mistake that has
 * exposed real secrets in real published documents. These search the BYTES.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[pdf] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[pdf] FAILED: ' + message + '\n');
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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1400));

  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  check(
    // The ninth and last.
    'every one of the nine applications is now built',
    await evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.app-card')];
        return [
          cards.length,
          cards.filter(c => c.getAttribute('data-available') === 'true').length,
        ];
      })()
    `),
    [9, 9],
  );

  await click('.app-card[data-application="pdf"]');
  await waitFor('!!document.querySelector(".pdf__toolbar")', 'the toolbar');

  check(
    'the empty state says what to do',
    await evaluate('document.querySelector(".pdf__empty")?.textContent'),
    'No file open. Choose a PDF, or make a sample to try redaction on.',
  );

  // ---------------------------------------------------------- writing one --

  await click('.pdf__action[data-action="sample"]');
  await waitFor('!!document.querySelector(".pdf__page-text")', 'the sample');

  check(
    'a real PDF is written and read back, with its own metadata',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.pdf__summary-row')];
        const value = (label) => rows
          .find(r => r.querySelector('.pdf__summary-label')?.textContent === label)
          ?.querySelector('.pdf__summary-value')?.textContent;
        return [value('Pages'), value('Version'), value('Producer')];
      })()
    `),
    ['2', 'PDF 1.7', 'Material Workspace'],
  );

  check(
    'the text is extracted per page, including the wrapped paragraph',
    await evaluate(`
      (() => {
        const pages = [...document.querySelectorAll('.pdf__page-text')].map(p => p.textContent ?? '');
        return [
          pages.length,
          pages[0].includes('Quarterly summary'),
          pages[1].includes('4417-9982-0031'),
        ];
      })()
    `),
    [2, true, true],
  );

  check(
    // Somebody who expects a page view and gets a text dump needs to know why
    // before concluding the file is broken.
    'the surface says plainly that it does not render pages',
    await evaluate(
      '(document.querySelector(".pdf__caveat")?.textContent ?? "").includes("not a rendering of the page")',
    ),
    true,
  );

  // ---------------------------------------------------------------- search --

  await evaluate(`
    (() => {
      const search = document.querySelector('.pdf__search');
      search.focus();
      search.value = 'account';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor('document.querySelectorAll(".pdf__page-text").length === 1', 'the filtered page');
  check(
    'search narrows to the page containing the term',
    await evaluate(
      '(document.querySelector(".pdf__page-text")?.textContent ?? "").includes("4417")',
    ),
    true,
  );

  await evaluate(`
    (() => {
      const search = document.querySelector('.pdf__search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor('document.querySelectorAll(".pdf__page-text").length === 2', 'both pages');

  // ------------------------------------------------------------- redaction --

  check(
    'redaction refuses politely when nothing is selected',
    await (async () => {
      await click('.pdf__action[data-action="redact"]');
      await new Promise((resolve) => setTimeout(resolve, 150));
      return evaluate(
        '(document.querySelector(".pdf__status")?.textContent ?? "").includes("Select the objects")',
      );
    })(),
    true,
  );

  // Select the content stream holding the secret.
  const selected = await evaluate(`
    (() => {
      const objects = [...document.querySelectorAll('.pdf__object')];
      // The second content stream is the appendix page.
      const streams = objects.filter(o =>
        (o.querySelector('.pdf__object-kind')?.textContent ?? '').includes('with text'));
      const target = streams[streams.length - 1];
      target.click();
      return target?.getAttribute('data-object');
    })()
  `);
  check('an object can be selected for removal', typeof selected === 'string', true);

  check(
    // Colour alone carries no meaning to a screen reader.
    'and the selection is announced, not only coloured',
    await evaluate(
      'document.querySelector(\'.pdf__object[data-selected="true"]\')?.getAttribute("aria-selected")',
    ),
    'true',
  );

  await click('.pdf__action[data-action="redact"]');
  await waitFor(
    '(document.querySelector(".pdf__status")?.textContent ?? "").includes("Verified")',
    'the redaction',
  );

  check(
    // The check that matters. A redaction verified by looking at the page is
    // not verified at all.
    'redaction reports that it VERIFIED the bytes are gone',
    await evaluate(
      '(document.querySelector(".pdf__status")?.textContent ?? "").includes("none of them remain in the bytes")',
    ),
    true,
  );

  check(
    'and the secret is genuinely gone from the extracted text',
    await evaluate(`
      (() => {
        const text = [...document.querySelectorAll('.pdf__page-text')].map(p => p.textContent ?? '').join(' ');
        return [text.includes('4417-9982-0031'), text.includes('Quarterly summary')];
      })()
    `),
    [false, true],
  );

  check(
    'the file still parses after redaction, with one page of text left',
    await evaluate('document.querySelectorAll(".pdf__page-text").length'),
    1,
  );

  // ---------------------------------------------------------------- save --

  await evaluate(`
    (() => {
      window.__pdfBlob = null;
      const originalCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        window.__pdfBlob = blob;
        return originalCreate.call(URL, blob);
      };
      document.querySelector('.pdf__action[data-action="save"]').click();
      URL.createObjectURL = originalCreate;
      return true;
    })()
  `);
  await waitFor('!!window.__pdfBlob', 'the save');

  await evaluate(`
    (() => {
      window.__pdfCheck = null;
      window.__pdfBlob.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        const text = new TextDecoder('latin1').decode(bytes);
        window.__pdfCheck = {
          header: text.startsWith('%PDF-'),
          endsProperly: text.trimEnd().endsWith('%%EOF'),
          // The redacted bytes must not be in the saved file either.
          secretGone: !text.includes('4417-9982-0031'),
        };
      });
      return true;
    })()
  `);
  await waitFor('window.__pdfCheck !== null', 'the saved bytes');
  check(
    'the saved file is a real PDF, and the secret is not in it',
    await evaluate('[window.__pdfCheck.header, window.__pdfCheck.endsProperly, window.__pdfCheck.secretGone]'),
    [true, true, true],
  );

  // ------------------------------------------------------------- reopening --

  await evaluate(`
    (() => {
      const file = new File([window.__pdfBlob], 'redacted.pdf', { type: 'application/pdf' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector('.pdf__file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor(
    '(document.querySelector(".pdf__status")?.textContent ?? "").includes("redacted.pdf")',
    'the reopened file',
  );
  check(
    'the redacted file reopens and still reads correctly',
    await evaluate(`
      (() => {
        const text = [...document.querySelectorAll('.pdf__page-text')].map(p => p.textContent ?? '').join(' ');
        return [text.includes('Quarterly summary'), text.includes('4417')];
      })()
    `),
    [true, false],
  );

  // ------------------------------------------------------------ geometry --

  check(
    'the toolbar and status line stay within the window',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const t = document.querySelector('.pdf__toolbar').getBoundingClientRect();
        const s = document.querySelector('.pdf__status').getBoundingClientRect();
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
        return [...document.querySelectorAll('.pdf__action, .pdf__search')]
          .every(b => b.getBoundingClientRect().height >= target - 1);
      })()
    `),
    true,
  );

  await capture('24-pdf');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
