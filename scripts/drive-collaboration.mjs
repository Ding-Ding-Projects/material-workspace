#!/usr/bin/env node
/**
 * Drive Collaboration in the built application.
 *
 * The checks are weighted towards the OFFLINE state, deliberately. That is the
 * state most people will meet this surface in — no server configured, nothing
 * to connect to — and it is the state a collaborative editor normally handles
 * worst: a row of avatars when things work, and silence when they do not.
 *
 * So what is asserted here is that typing works with nothing connected, that
 * the queue depth is stated in words rather than implied, and that the status
 * never carries its meaning in colour alone.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[collab] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[collab] FAILED: ' + message + '\n');
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
    // Deliberately without awaitPromise: on this Node build it hangs even for
    // synchronous expressions. Anything asynchronous is parked on a global and
    // polled instead.
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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1400));

  await waitFor(
    'document.getElementById("root")?.getAttribute("data-state") === "ready"',
    'the shell',
  );

  await evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('[role="tab"], .tab')]
        .find(t => (t.textContent ?? '').includes('Collaboration'));
      if (tab) { tab.click(); return true; }
      return false;
    })()
  `);
  await waitFor('!!document.querySelector(".collab")', 'the collaboration surface');

  // ------------------------------------------------------------- offline --

  check(
    'it opens offline and says so in words, not only a colour',
    await evaluate(`
      (() => {
        const row = document.querySelector('.collab-status');
        return [
          row?.dataset.tone,
          (row?.querySelector('.collab-state-label')?.textContent ?? '').trim(),
        ];
      })()
    `),
    ['idle', 'Working offline'],
  );

  check(
    'the queue reports plainly that nothing is waiting',
    await evaluate(
      `(document.querySelector('.collab-queue')?.textContent ?? '').includes('Nothing is waiting')`,
    ),
    true,
  );

  // THE CHECK THIS SURFACE EXISTS FOR: typing must never depend on a server.
  await evaluate(`
    (() => {
      const editor = document.querySelector('.collab-editor');
      editor.focus();
      editor.value = 'written with nothing connected';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  check(
    'typing works with nothing connected and the text is kept',
    await evaluate(`document.querySelector('.collab-editor').value`),
    'written with nothing connected',
  );

  check(
    'the peer list says why it is empty rather than being blank',
    await evaluate(
      `(document.querySelector('.collab-peer-empty')?.textContent ?? '').includes('Not connected')`,
    ),
    true,
  );

  await capture('26-collaboration-offline');

  // ----------------------------------------------------------- connecting --

  // Pointed at a port nothing is listening on, on purpose. A collaborative
  // editor's real failure mode is a server that is not there, and it must
  // report that rather than going quiet.
  await evaluate(`
    (() => {
      document.querySelector('#collab-server').value = 'ws://127.0.0.1:9/sync';
      document.querySelector('.collab-connect').click();
      return true;
    })()
  `);

  await waitFor(
    `['connecting','reconnecting'].includes(document.querySelector('.collab-status')?.dataset.tone === 'working' ? 'connecting' : '')`,
    'the connecting state',
    8000,
  );

  check(
    'a connection attempt is reported while it is in flight',
    await evaluate(`document.querySelector('.collab-status')?.dataset.tone`),
    'working',
  );

  check(
    'the button becomes the way out rather than staying Connect',
    await evaluate(`(document.querySelector('.collab-connect')?.textContent ?? '').trim()`),
    'Disconnect',
  );

  await capture('27-collaboration-connecting');

  // ------------------------------------------------- queue survives failure --

  await evaluate(`
    (() => {
      const editor = document.querySelector('.collab-editor');
      editor.value = editor.value + ' plus more while it cannot connect';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  check(
    'work typed while unreachable is counted as waiting, not lost',
    await evaluate(
      `/\\d+ changes? waiting to be sent/.test(document.querySelector('.collab-queue')?.textContent ?? '')`,
    ),
    true,
  );

  check(
    'and the local text still holds every character',
    await evaluate(
      `document.querySelector('.collab-editor').value.endsWith('plus more while it cannot connect')`,
    ),
    true,
  );

  await capture('28-collaboration-queued');

  // ------------------------------------------------------- accessibility --

  check(
    'the status region is announced rather than only drawn',
    await evaluate(`
      (() => {
        const row = document.querySelector('.collab-status');
        return [row?.getAttribute('role'), row?.getAttribute('aria-live')];
      })()
    `),
    ['status', 'polite'],
  );

  check(
    'every field has a label bound to it',
    await evaluate(`
      (() => {
        const ids = ['collab-server','collab-room','collab-name','collab-editor'];
        return ids.every(id =>
          !!document.querySelector('label[for="' + id + '"]') && !!document.getElementById(id));
      })()
    `),
    true,
  );

  check(
    'the connect button meets the touch target',
    await evaluate(`
      (() => {
        const target = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--workspace-touch-target'),
        ) || 48;
        return document.querySelector('.collab-connect').getBoundingClientRect().height >= target - 1;
      })()
    `),
    true,
  );

  check(
    'nothing on the surface is clipped by its own container',
    await evaluate(`
      (() => {
        const root = document.querySelector('.collab');
        const box = root.getBoundingClientRect();
        return [...root.querySelectorAll('.collab-status, .collab-connect-row, .collab-body')]
          .every(node => {
            const r = node.getBoundingClientRect();
            return r.right <= box.right + 1 && r.left >= box.left - 1;
          });
      })()
    `),
    true,
  );

  // Disconnect, so the surface is left in the state it opened in.
  await evaluate(`document.querySelector('.collab-connect').click(); true`);
  await waitFor(
    `document.querySelector('.collab-status')?.dataset.tone === 'idle'`,
    'the return to offline',
  );

  check(
    'disconnecting returns it to working offline rather than to an error',
    await evaluate(`
      [
        document.querySelector('.collab-status')?.dataset.tone,
        (document.querySelector('.collab-connect')?.textContent ?? '').trim(),
      ]
    `),
    ['idle', 'Connect'],
  );

  await capture('29-collaboration-disconnected');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
