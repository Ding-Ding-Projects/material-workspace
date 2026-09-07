#!/usr/bin/env node
/**
 * Drive Governance in the built application.
 *
 * These are the rules where getting it wrong is not a bug report but a
 * disclosure or a destroyed record, so the checks assert the case each rule
 * exists to prevent rather than the happy path.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[governance] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[governance] FAILED: ' + message + '\n');
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

  // Governance is a shell surface, reachable from the tab strip.
  await evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('[role="tab"], .tab')]
        .find(t => (t.textContent ?? '').includes('Governance'));
      if (tab) { tab.click(); return true; }
      return false;
    })()
  `);
  await waitFor('!!document.querySelector(".governance")', 'the governance surface');

  // ------------------------------------------------------- classification --

  check(
    // Treating "nobody looked" as "least sensitive" is how a gap in process
    // becomes a disclosure.
    'an unlabelled document reads as UNKNOWN and says that is not public',
    await evaluate(`
      (() => {
        const current = document.querySelector('.governance__current');
        return [
          current?.getAttribute('data-sensitivity'),
          (current?.textContent ?? '').includes('not the same as public'),
        ];
      })()
    `),
    ['unknown', true],
  );

  await click('.governance__action[data-set-label="restricted"]');
  await waitFor(
    'document.querySelector(".governance__current")?.getAttribute("data-sensitivity") === "restricted"',
    'the raised label',
  );
  check(
    'raising a label needs no authority and no reason',
    await evaluate(
      '(document.querySelector(".governance__status")?.textContent ?? "").includes("Raising never needs authority")',
    ),
    true,
  );

  // Lowering without authority.
  await click('.governance__action[data-set-label="public"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    'lowering without authority is refused, and the label does not move',
    await evaluate(`
      (() => {
        const status = document.querySelector('.governance__status')?.textContent ?? '';
        const current = document.querySelector('.governance__current')?.getAttribute('data-sensitivity');
        return [status.includes('needs authority'), current];
      })()
    `),
    [true, 'restricted'],
  );

  // With authority.
  await click('#governance-may-lower');
  await new Promise((resolve) => setTimeout(resolve, 150));
  await click('.governance__action[data-set-label="internal"]');
  await waitFor(
    'document.querySelector(".governance__current")?.getAttribute("data-sensitivity") === "internal"',
    'the lowered label',
  );
  check(
    'lowering WITH authority records the justification',
    await evaluate(
      '(document.querySelector(".governance__justification")?.textContent ?? "").includes("Recorded justification")',
    ),
    true,
  );

  // Inheritance.
  await click('.governance__action[data-inherit]');
  await waitFor(
    'document.querySelector(".governance__current")?.getAttribute("data-sensitivity") === "restricted"',
    'the inherited label',
  );
  check(
    // Pasting from a restricted document into an unlabelled one and keeping
    // the unlabelled label is the most common way classified material escapes.
    'a derived document inherits the HIGHEST of its sources',
    await evaluate(
      '(document.querySelector(".governance__status")?.textContent ?? "").includes("inherits the HIGHEST")',
    ),
    true,
  );

  // ------------------------------------------------------------- export --

  check(
    // A warning that can be clicked past is a warning that will be.
    'a restricted document is REFUSED to a public destination, not warned',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.governance__destination')];
        const site = rows.find(r => r.getAttribute('data-destination') === 'public-site');
        const vault = rows.find(r => r.getAttribute('data-destination') === 'secure');
        return [
          site?.getAttribute('data-allowed'),
          (site?.textContent ?? '').includes('Refused'),
          vault?.getAttribute('data-allowed'),
        ];
      })()
    `),
    ['false', true, 'true'],
  );

  // --------------------------------------------------------------- scan --

  await evaluate(`
    (() => {
      const input = document.querySelector('.governance__scan-input');
      input.focus();
      input.value = [
        'card 4111 1111 1111 1111',
        'reference 1234567812345678',
        'hash 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a',
        '-----BEGIN RSA PRIVATE KEY-----',
      ].join(String.fromCharCode(10));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor('!!document.querySelector(".governance__finding")', 'the findings');

  check(
    // Without the Luhn check any sixteen digits look like a card number, and
    // a long hash looks like a token. A scanner that cries wolf gets switched
    // off, which is worse than not having one.
    'a real card is found, and an arbitrary digit run and a hash are not',
    await evaluate(`
      (() => {
        const labels = [...document.querySelectorAll('.governance__finding-label')]
          .map(l => l.textContent);
        return [
          labels.filter(l => l === 'Payment card number').length,
          labels.filter(l => l === 'API token').length,
          labels.includes('Private key'),
        ];
      })()
    `),
    [1, 0, true],
  );

  check(
    // The whole point is that the matched text is sensitive. A preview that
    // shows it moves the secret somewhere with weaker protection.
    'the preview never discloses the match',
    await evaluate(`
      (() => {
        const previews = [...document.querySelectorAll('.governance__finding-preview')]
          .map(p => p.textContent ?? '');
        return [
          previews.length > 0,
          previews.every(p => !p.includes('1111111111')),
          previews.some(p => p.includes('\\u00b7')),
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    'every finding that can be a false positive says so',
    await evaluate(`
      (() => {
        const card = [...document.querySelectorAll('.governance__finding')]
          .find(f => (f.textContent ?? '').includes('Payment card number'));
        return (card?.textContent ?? '').includes('test number');
      })()
    `),
    true,
  );

  check(
    'and the surface says plainly what the scanner cannot do',
    await evaluate(`
      [...document.querySelectorAll('.governance__caveat')]
        .some(c => (c.textContent ?? '').includes('patterns, not secrets'))
    `),
    true,
  );

  // ---------------------------------------------------------- retention --

  check(
    // A colour alone is invisible to a screen reader and ambiguous to
    // everybody else.
    'every record states its state in WORDS',
    await evaluate(`
      (() => {
        const states = [...document.querySelectorAll('.governance__record-state')]
          .map(s => s.textContent);
        return [
          states.includes('Legal hold'),
          states.includes('Overdue') || states.includes('Due'),
          states.includes('Clock not started'),
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    // A hold outranks every policy, and saying so saves somebody an afternoon
    // wondering why the policy is not working.
    'a held record says the hold outranks the policy',
    await evaluate(`
      (() => {
        const held = [...document.querySelectorAll('.governance__record')]
          .find(r => r.getAttribute('data-state') === 'held');
        return (held?.textContent ?? '').includes('outranks every retention policy');
      })()
    `),
    true,
  );

  check(
    // Treating a missing start date as "now" would make an open contract
    // instantly expired.
    'a record whose clock has not started is kept, not due',
    await evaluate(`
      (() => {
        const notStarted = [...document.querySelectorAll('.governance__record')]
          .find(r => r.getAttribute('data-state') === 'noStart');
        return (notStarted?.textContent ?? '').includes('has not happened yet');
      })()
    `),
    true,
  );

  check(
    'a due record names the action and says nothing was done automatically',
    await evaluate(`
      (() => {
        const due = [...document.querySelectorAll('.governance__record')]
          .find(r => ['due', 'overdue'].includes(r.getAttribute('data-state') ?? ''));
        return (due?.textContent ?? '').includes('Nothing has been done automatically');
      })()
    `),
    true,
  );

  check(
    // They are not actionable, and putting them in a list of things to do is
    // how somebody deletes one.
    'held records are excluded from the list of things to decide',
    await evaluate(`
      (() => {
        const notes = [...document.querySelectorAll('.governance__note')].map(n => n.textContent ?? '');
        const todo = notes.find(n => n.includes('needs a decision') || n.includes('need a decision'));
        return [
          todo !== undefined,
          (todo ?? '').includes('CON-2011-02'),
          (todo ?? '').includes('Held records are not listed'),
        ];
      })()
    `),
    [true, false, true],
  );

  check(
    'and the surface says plainly that nothing is deleted automatically',
    await evaluate(`
      [...document.querySelectorAll('.governance__caveat')]
        .some(c => (c.textContent ?? '').includes('Nothing here deletes anything'))
    `),
    true,
  );

  // ------------------------------------------------------------ geometry --

  check(
    'the status line stays within the window',
    await evaluate(`
      (() => {
        const h = window.innerHeight;
        const s = document.querySelector('.governance__status').getBoundingClientRect();
        return s.bottom <= h + 1;
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
        return [...document.querySelectorAll('.governance__action')]
          .every(b => b.getBoundingClientRect().height >= target - 1);
      })()
    `),
    true,
  );

  await capture('25-governance');

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
