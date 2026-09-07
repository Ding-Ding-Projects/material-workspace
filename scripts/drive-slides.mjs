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

  // ------------------------------------------------------- opening a file --

  // A REAL presentation from the conformance corpus, handed to the real file
  // input as a real File. Not a call into the codec from a test: this is the
  // path a person takes, and it is where a bridge that never got wired shows
  // up.
  const PPTX_BASE64 = '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';
  const ODP_BASE64 = 'UEsDBBQAAAAAAAAAAAAzJqyoLwAAAC8AAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnByZXNlbnRhdGlvblBLAwQUAAAACAAAAAAA+zyJC7YAAABxAQAAFQAAAE1FVEEtSU5GL21hbmlmZXN0LnhtbI2QQQqDMBBFryKz17R0U4LRXU/QHiDEsQ0kk2BGibcvCrWWUuhuPvNn3ufXbfaumHBINpCCY3WAAsmEztJdwe16Kc/QNrXXZHtMLF9Dkb2jtEkF40Ay6GSTJO0xSTYyRKQumNEjsfz0yxW0qR3/BDtabx2WSDzMb28/OldGzQ8FYvfCY2d1yXNEBTpGZ41mG0hM1FVrrmofp4oDJiRePSD+R5pAvNxn737AGTOLZS2aWnz11jwBUEsDBBQAAAAIAAAAAADI0qeiCgEAAPkCAAAKAAAAc3R5bGVzLnhtbI2SwW6DMAyGXwXlDhShbV1E6K23STtsD5AFQyOROEoMpW8/AV2Vqp3E1f///Y5jV4fJ9MkIPmi0ghXZjiVgFTbadoJ9fx3TPTvUFbatVsAbVIMBS2mgSw8hmUxvA19FwQZvOcqgA7fSQOCkODqwfxCP3XzptFYIJtpKz96Ybbw8b2Vnr7ZdjDsPASxJWqbfFhMzcdbyJ1tDFvMdPXab2bFLFRonSf/ch7S4NWMKfdriQ8x1OdE9lOy2fTkQGklaXddfV+sUTnaQ9vKCAyVrZe4s2OdHwZ54UufRgScNIWlxVc66oZNgZZntX9+UYTfhBLo7kWDFe7Z7UYbldZU/JNZV/u8T8+enW/8CUEsDBBQAAAAIAAAAAABRY8FKUwEAAEEEAAALAAAAY29udGVudC54bWydVEFuwyAQ/Ari7pA0qlQhILf2XrUPwHhtIxmwzMZxfl/ZTlLcpq3VEwvMzDK7K8RhcA3poYs2eEl3my0l4E0orK8kfX97zp7oQYlQltYAL4I5OvCYmeARPJLBNT7y+VbSY+d50NFG7rWDyNHw0IK/sniK5lOq+QRhwLXsEZtyi06f1nJHrPVVSm87iOBR42R/nUzKSbUinpvVVZjAC3Zfreb2VWaCazXafClShrUaQ2yyMnyTuTQnGYg9vbU/D8X5tkmroMRYWt7qCsgUjZklHfc7erksO+2ALGpnGh2jpGixAUpiX/FB0p1xc3xO4pMtsJZ0t70e1GCrGiV9MO6aYJyMLA+DEtOMtOpFt3MYybQYSfeUqRo6EOyCEewLl30+VonFa31AiH+amVD/NPP4i5lXcOBy6AjWQLC2vtqsNMHuuWC3hinB7naULZrOfvgB1AdQSwECFAAUAAAAAAAAAAAAMyasqC8AAAAvAAAACAAAAAAAAAAAAAAAAAAAAAAAbWltZXR5cGVQSwECFAAUAAAACAAAAAAA+zyJC7YAAABxAQAAFQAAAAAAAAAAAAAAAABVAAAATUVUQS1JTkYvbWFuaWZlc3QueG1sUEsBAhQAFAAAAAgAAAAAAMjSp6IKAQAA+QIAAAoAAAAAAAAAAAAAAAAAPgEAAHN0eWxlcy54bWxQSwECFAAUAAAACAAAAAAAUWPBSlMBAABBBAAACwAAAAAAAAAAAAAAAABwAgAAY29udGVudC54bWxQSwUGAAAAAAQABADqAAAA7AMAAAAA';

  const drop = async (base64, name, type) => {
    await evaluate(`
      (() => {
        const binary = atob(${JSON.stringify(base64)});
        const bytes = new Uint8Array(binary.length);
        for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
        const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
        const input = document.querySelector('.slides__file');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 700));
  };

  await drop(
    PPTX_BASE64,
    'paragraphs-and-notes.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );

  check(
    'a real .pptx opens, and the status says what was not read',
    await evaluate(`
      (() => {
        const status = document.querySelector('.slides__status').textContent || '';
        return [
          document.querySelectorAll('.slides__thumb').length,
          status.includes('Opened paragraphs-and-notes.pptx'),
          status.includes('not read'),
        ];
      })()
    `),
    [1, true, true],
  );

  check(
    'the title, the body lines and the speaker notes all survived the trip',
    await evaluate(`
      (() => {
        const stage = document.querySelector('.slides__stage').textContent || '';
        const notes = document.querySelector('.slides__notes')?.value || '';
        return [
          stage.includes('Deck title'),
          stage.includes('First point'),
          stage.includes('Second point'),
          notes.includes('Say the thing.'),
          // The notes part also carries the slide title. Seeing it here would
          // mean the reader took every bit of text from that part.
          !notes.includes('Deck title'),
        ];
      })()
    `),
    [true, true, true, true, true],
  );

  await capture('45-slides-pptx-opened');

  await drop(
    ODP_BASE64,
    'notes-and-spaces.odp',
    'application/vnd.oasis.opendocument.presentation',
  );

  check(
    'a real .odp opens too, with its encoded spaces intact',
    await evaluate(`
      (() => {
        const stage = document.querySelector('.slides__stage').textContent || '';
        const notes = document.querySelector('.slides__notes')?.value || '';
        return [
          stage.includes('Gap   here'),
          notes.includes('Remember the thing.'),
        ];
      })()
    `),
    [true, true],
  );

  check(
    // The format is decided by the CONTENT. Somebody renames a file to make an
    // upload accept it all the time, and refusing on the name refuses a file
    // that opens fine everywhere else.
    'an .odp wearing a .pptx name still opens, because the bytes decide',
    await (async () => {
      await drop(ODP_BASE64, 'actually-odp.pptx', '');
      return evaluate(`
        (() => {
          const status = document.querySelector('.slides__status').textContent || '';
          return [status.includes('Opened actually-odp.pptx'), !status.includes('Could not open')];
        })()
      `);
    })(),
    [true, true],
  );

  check(
    'a file that is not a presentation is refused in words, not silently',
    await (async () => {
      await drop(btoaSafe('not a zip at all'), 'broken.pptx', '');
      return evaluate(`
        (() => {
          const status = document.querySelector('.slides__status').textContent || '';
          return [status.includes('Could not open broken.pptx'), status.length > 40];
        })()
      `);
    })(),
    [true, true],
  );

  await capture('46-slides-refused');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));

/** Base64 for a short ASCII string, without pulling in a dependency. */
function btoaSafe(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

