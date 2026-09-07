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
    // Pages ARE drawn now. What the surface must still say is which parts of
    // the file reach the picture and which do not - somebody who sees a page
    // with no images needs to know whether the file has none or whether this
    // does not draw them.
    //
    // This check used to assert the opposite sentence, and it went red the
    // moment the copy changed. That is the guard working: a surface that
    // silently keeps an obsolete disclaimer is the defect, not the test.
    'the text panel says what it is, and distinguishes itself from the drawing',
    await evaluate(`
      (() => {
        const caveat = document.querySelector('.pdf__caveat')?.textContent ?? '';
        return [
          caveat.includes('text STORED in the file'),
          caveat.includes('drawn from the same file'),
        ];
      })()
    `),
    [true, true],
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

  // ------------------------------------------------------ compressed streams --

  // The gap this closes is the worst shape a gap takes. The reader skipped
  // every compressed stream, returned an empty page, and reported success -
  // and nearly every PDF produced by anything deflates its content, so "no
  // readable text" was the answer for almost every real file.

  const loadPdf = async (build) => {
    await evaluate(`
      (async () => {
        const bytes = await (${build})();
        window.__probe = bytes;
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await evaluate(`
      (() => {
        const app = document.querySelector('.pdf');
        const file = new File([window.__probe], 'probe.pdf', { type: 'application/pdf' });
        const input = app.querySelector('input[type="file"]');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  // Built in the page, so the bytes are real rather than a fixture that could
  // drift from what a producer actually writes.
  const builder = (filter, body) => `
    async () => {
      const bytesOf = (text) =>
        Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
      const content = bytesOf(${JSON.stringify(body)});
      const packed = ${
        filter === 'FlateDecode'
          ? `new Uint8Array(await new Response(
               new Blob([content]).stream().pipeThrough(new CompressionStream('deflate')),
             ).arrayBuffer())`
          : 'content'
      };
      const head = '%PDF-1.7' + String.fromCharCode(10)
        + '1 0 obj' + String.fromCharCode(10)
        + '<< /Filter /${filter} /Length ' + packed.length + ' >>' + String.fromCharCode(10)
        + 'stream' + String.fromCharCode(10);
      const tail = String.fromCharCode(10) + 'endstream' + String.fromCharCode(10)
        + 'endobj' + String.fromCharCode(10)
        + 'trailer' + String.fromCharCode(10) + '<< /Root 1 0 R >>' + String.fromCharCode(10)
        + '%%EOF' + String.fromCharCode(10);
      const out = new Uint8Array(head.length + packed.length + tail.length);
      out.set(bytesOf(head), 0);
      out.set(packed, head.length);
      out.set(bytesOf(tail), head.length + packed.length);
      return out;
    }
  `;

  await loadPdf(builder('FlateDecode', 'BT /F1 12 Tf (Deflated and readable) Tj ET'));

  check(
    'a deflated stream gives up its text, where the old path gave nothing at all',
    await evaluate(`
      (() => {
        const pages = [...document.querySelectorAll('.pdf__page-text')]
          .map(node => node.textContent || '');
        return [pages.length, pages.join(' ').includes('Deflated and readable')];
      })()
    `),
    [1, true],
  );

  check(
    'and it says nothing about problems, because there were none',
    await evaluate('document.querySelector(".pdf__problems") === null'),
    true,
  );

  check(
    // Reading a document you cannot show is half a reader. The two paths are
    // separate, and fixing one leaves the other exactly as broken.
    'the deflated page is DRAWN as well as read, on a canvas with real pixels',
    await evaluate(`
      (() => {
        const canvas = document.querySelector('.pdf__canvas');
        const note = document.querySelector('.pdf__page-note');
        const text = note?.textContent || '';
        // The note carries the honest per-page caveat when a page IS drawn, so
        // the test is that it does not carry the failure sentence - asserting
        // an empty note would fail on a perfectly good rendering.
        return [canvas.width > 10, canvas.height > 10, text.includes('No page could be drawn')];
      })()
    `),
    [true, true, false],
  );

  await capture('55-pdf-compressed');

  await loadPdf(builder('Crypt', 'anything at all'));

  check(
    // "No readable text" on its own is indistinguishable from a document that
    // genuinely has none. Naming the filter is the difference between a gap a
    // reader can act on and one that looks like an empty file.
    'an unsupported filter is NAMED on the surface, not silently absent',
    await evaluate(`
      (() => {
        const problems = document.querySelector('.pdf__problems');
        const text = (problems?.textContent || '');
        return [problems !== null, text.includes('Crypt'), text.includes('could not be read')];
      })()
    `),
    [true, true, true],
  );

  await loadPdf(builder('DCTDecode', 'jpegbytes'));

  check(
    // Calling a JPEG an error makes a perfectly ordinary scanned document look
    // broken. It is reported as what it is.
    'an image stream is reported as an image, not as a fault',
    await evaluate(`
      (() => {
        const caveats = [...document.querySelectorAll('.pdf__caveat')]
          .map(node => node.textContent || '').join(' ');
        return [
          document.querySelector('.pdf__problems') === null,
          caveats.includes('image'),
          caveats.includes('Scanned pages'),
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    // A file that stores no text and a file whose text is behind a filter are
    // different situations, and the empty state must not describe them both
    // the same way.
    'an empty result says WHY it is empty',
    await evaluate(`
      (() => {
        const empty = document.querySelector('.pdf__empty');
        return (empty?.textContent || '').includes('for the reasons above');
      })()
    `),
    true,
  );

  await capture('56-pdf-unreadable');

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

  // ----------------------------------------------------- drawing a page --

  // A REAL PDF from the conformance corpus, opened through the real file input
  // and drawn on the real canvas. The pixels are read back off that canvas:
  // a display list that is correct and a canvas that never got drawn on look
  // identical from the outside, and only the pixels tell them apart.

  const RECT_BASE64 = 'JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NSA+PgpzdHJlYW0KMSAwIDAgcmcKNzIgNzIgMTQ0IDcyIHJlCmYKMCAwIDEgcmcKNzIgNjQ4IDE0NCA3MiByZQpmCgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0NiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo=';

  await evaluate(`
    (() => {
      const binary = atob(${JSON.stringify(RECT_BASE64)});
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
      const file = new File([bytes], 'rectangles.pdf', { type: 'application/pdf' });
      const input = document.querySelector('.pdf__file');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 900));

  check(
    'a real PDF is drawn on a canvas with real dimensions',
    await evaluate(`
      (() => {
        const canvas = document.querySelector('.pdf__canvas');
        return [
          canvas.width > 100,
          canvas.height > canvas.width,
          Math.abs(canvas.height / canvas.width - 792 / 612) < 0.02,
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    // The fixture puts RED low on the page and BLUE high. A renderer that
    // forgets PDF's upward Y axis swaps them, and on a page of centred content
    // that is nearly invisible - so the fixture is built so it is not.
    'the page is the right way up, read from the canvas pixels themselves',
    await evaluate(`
      (() => {
        const canvas = document.querySelector('.pdf__canvas');
        const context = canvas.getContext('2d');
        const at = (fx, fy) => {
          const data = context.getImageData(
            Math.round(canvas.width * fx), Math.round(canvas.height * fy), 1, 1,
          ).data;
          return [data[0], data[1], data[2]];
        };
        return {
          // Red box: x 72..216 of 612, y 72..144 from the BOTTOM.
          low: at(0.23, 0.865),
          // Blue box: same across, y 648..720 from the bottom.
          high: at(0.23, 0.135),
          paper: at(0.8, 0.5),
        };
      })()
    `),
    { low: [255, 0, 0], high: [0, 0, 255], paper: [255, 255, 255] },
  );

  check(
    // A canvas is invisible to a screen reader without one, and a note that
    // does not say what was NOT drawn lets somebody believe a page with no
    // images simply had none.
    'the drawing says what it drew, and what it does not draw at all',
    await evaluate(`
      (() => {
        const canvas = document.querySelector('.pdf__canvas');
        const note = document.querySelector('.pdf__page-note').textContent || '';
        return [
          (canvas.getAttribute('aria-label') || '').includes('Preview of page 1'),
          note.includes('shapes'),
          note.includes('Images, shading and transparency are not drawn'),
        ];
      })()
    `),
    [true, true, true],
  );

  await capture('47-pdf-rendered');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
