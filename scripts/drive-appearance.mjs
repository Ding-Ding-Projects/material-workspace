#!/usr/bin/env node
/**
 * Drive Appearance and the colour picker in the built application.
 *
 * The checks lean on the two things that are normally decorative here: that
 * the field is reachable WITHOUT a pointer, and that the translator's rows are
 * real values rather than a static example. Both look identical in a
 * screenshot to versions that do nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const port = process.argv[2] ?? '9333';
const outputDir = process.argv[3] ?? '.tmp/ui-drive';

const findings = [];
function log(message) {
  process.stdout.write('[appearance] ' + message + '\n');
}
function fail(message) {
  process.stderr.write('[appearance] FAILED: ' + message + '\n');
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
        .find(t => (t.textContent ?? '').includes('Appearance'));
      if (tab) { tab.click(); return true; }
      return false;
    })()
  `);
  await waitFor('!!document.querySelector(".picker")', 'the colour picker');

  // ---------------------------------------------------------- translator --

  check(
    'every notation is listed, not a favourite few',
    await evaluate(`document.querySelectorAll('.picker-notation').length`),
    14,
  );

  check(
    'the notations that are not CSS are marked as such',
    await evaluate(`
      [...document.querySelectorAll('.picker-notation')]
        .filter(n => n.querySelector('.picker-not-css'))
        .map(n => n.firstElementChild.textContent)
        .sort()
    `),
    ['cmyk', 'hsv'],
  );

  // A STATIC EXAMPLE WOULD LOOK IDENTICAL IN A SCREENSHOT. So the value is
  // changed and the rows are asserted to follow.
  await evaluate(`
    (() => {
      const entry = document.querySelector('.picker-entry');
      entry.value = 'rebeccapurple';
      entry.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);

  check(
    'entering a named colour resolves it in every notation',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.picker-translation .picker-value')]
          .map(v => v.textContent);
        return [rows[0], rows[1], rows[3]];
      })()
    `),
    ['rebeccapurple', '#663399', 'rgb(102 51 153)'],
  );

  check(
    'the contrast readout names a ratio and a verdict, not a colour alone',
    await evaluate(`
      (() => {
        const row = document.querySelector('.picker-contrast');
        return [
          row.dataset.verdict,
          /\\d+(\\.\\d+)?:1/.test(row.textContent ?? ''),
        ];
      })()
    `),
    ['AAA', true],
  );

  await capture('30-appearance-picker');

  // ------------------------------------------------------------ refusal --

  await evaluate(`
    (() => {
      const entry = document.querySelector('.picker-entry');
      entry.value = 'not a colour at all';
      entry.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);

  check(
    'unreadable input is reported inline rather than guessed at',
    await evaluate(`!document.querySelector('.picker-entry-error').hidden`),
    true,
  );

  check(
    'and what was typed is left alone rather than wiped',
    await evaluate(`document.querySelector('.picker-entry').value`),
    'not a colour at all',
  );

  check(
    'the colour itself did not move because of an unreadable entry',
    await evaluate(
      `[...document.querySelectorAll('.picker-translation .picker-value')][1].textContent`,
    ),
    '#663399',
  );

  await capture('31-appearance-refused');

  // ----------------------------------------------------------- keyboard --

  // THE CHECK THAT MATTERS MOST. A two-dimensional field driven only by a
  // pointer is unreachable for anybody who cannot use one, and it looks
  // completely correct in every screenshot.
  const before = await evaluate(
    `[...document.querySelectorAll('.picker-translation .picker-value')][1].textContent`,
  );

  await evaluate(`
    (() => {
      const field = document.querySelector('.picker-field');
      field.focus();
      for (let i = 0; i < 5; i += 1) {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      }
      return true;
    })()
  `);

  const after = await evaluate(
    `[...document.querySelectorAll('.picker-translation .picker-value')][1].textContent`,
  );

  check('the field responds to the arrow keys', after !== before, true);

  check(
    'the field is focusable and describes itself to a screen reader',
    await evaluate(`
      (() => {
        const field = document.querySelector('.picker-field');
        return [
          field.getAttribute('tabindex'),
          (field.getAttribute('aria-label') ?? '').includes('Arrow keys'),
        ];
      })()
    `),
    ['0', true],
  );

  // ------------------------------------------------------------ rainbow --

  await evaluate(`
    (() => {
      const toggle = document.querySelector('.picker-rainbow-toggle');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);

  // Asks what RENDERS, not what the attribute says. The first version of this
  // check read `.hidden` and passed while the row was permanently on screen,
  // because an explicit `display` in the stylesheet beats the browser's own
  // `[hidden] { display: none }`. Found by looking at a capture.
  check(
    'the speed control is hidden until the rainbow is chosen, and then shown',
    await evaluate(`
      (() => {
        const row = document.querySelector('.picker-speed-row');
        const toggle = document.querySelector('.picker-rainbow-toggle');
        const shown = () => getComputedStyle(row).display !== 'none';

        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        const whenOff = shown();

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        return [whenOff, shown()];
      })()
    `),
    [false, true],
  );

  check(
    'the speed readout states the real duration rather than a bare level',
    await evaluate(
      `/one full cycle every \\d+(\\.\\d+)?s/.test(document.querySelector('.picker-speed-readout').textContent ?? '')`,
    ),
    true,
  );

  check(
    'the accent line says what the rainbow does under reduced motion',
    await evaluate(
      `(document.querySelector('.appearance-current')?.textContent ?? '').includes('settles on a single colour')`,
    ),
    true,
  );

  // MEASURED, NOT ASSUMED, because this environment lies about it.
  //
  // In headless off-screen Electron the style engine resolves
  // `prefers-reduced-motion: reduce` as TRUE while `window.matchMedia` reports
  // FALSE - verified with a probe element the application never styles, which
  // came back clamped to 0.001s and one iteration. So every capture taken this
  // way shows the REDUCED-MOTION presentation, and a check that demanded
  // `infinite` would fail on correct code, for ever, in CI only.
  //
  // What is asserted instead is the thing that must hold either way: the
  // animation is WIRED to the stylesheet rather than repainted by a timer, and
  // the presentation matches whichever state is actually in force.
  const motion = await evaluate(`
    (() => {
      const probe = document.createElement('div');
      probe.style.animation = 'picker-rainbow 9s linear infinite';
      document.body.append(probe);
      const clamped = getComputedStyle(probe).animationIterationCount === '1';
      probe.remove();

      const preview = document.querySelector('.picker-preview');
      const style = getComputedStyle(preview);
      return {
        clamped,
        rainbow: preview.dataset.rainbow,
        name: style.animationName,
        iteration: style.animationIterationCount,
      };
    })()
  `);

  check(
    'the preview is animated by the stylesheet, not repainted by a timer',
    [motion.rainbow, motion.name],
    ['yes', 'picker-rainbow'],
  );

  check(
    motion.clamped
      ? 'under reduced motion it settles rather than cycling'
      : 'with motion allowed it cycles without end',
    motion.iteration,
    motion.clamped ? '1' : 'infinite',
  );

  await capture('32-appearance-rainbow');

  // ------------------------------------------------------ accessibility --

  check(
    'the sliders and the entry all have labels bound to them',
    await evaluate(`
      (() => {
        const ids = ['picker-hue', 'picker-alpha', 'picker-entry', 'picker-rainbow', 'picker-speed'];
        return ids.every(id =>
          !!document.querySelector('label[for="' + id + '"]') && !!document.getElementById(id));
      })()
    `),
    true,
  );

  check(
    'every copy button says which notation it copies',
    await evaluate(`
      [...document.querySelectorAll('.picker-copy')]
        .every(b => /^Copy the \\S+ form$/.test(b.getAttribute('aria-label') ?? ''))
    `),
    true,
  );

  check(
    'nothing on the surface overflows its own container',
    await evaluate(`
      (() => {
        const root = document.querySelector('.appearance');
        const box = root.getBoundingClientRect();
        return [...root.querySelectorAll('.picker-main, .picker-translations, .appearance-current')]
          .every(node => {
            const r = node.getBoundingClientRect();
            return r.right <= box.right + 1 && r.left >= box.left - 1;
          });
      })()
    `),
    true,
  );

  // ---------------------------------------------- per-element appearance --

  // Every rendered element carries its own menu, by delegation from the root.
  // A per-surface menu would be a menu that is missing wherever the surface is
  // newest, so the check picks an ordinary element nobody wired by hand.

  await evaluate(`
    (() => {
      const target = document.querySelector('.tab') || document.querySelector('button');
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
      return true;
    })()
  `);
  await waitFor('!!document.querySelector(".context-menu")', 'the element menu');

  check(
    'the right-click menu names the element and offers the appearance editor',
    await evaluate(`
      (() => {
        const menu = document.querySelector('.context-menu');
        const labels = [...menu.querySelectorAll('.context-menu__label')].map(n => n.textContent);
        return [
          (menu.getAttribute('aria-label') || '').startsWith('Menu for '),
          labels.includes('Edit appearance...'),
          labels.includes('Lock this element...'),
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    // A menu item whose shortcut is hidden is a shortcut nobody learns, and a
    // disabled item with no reason reads as broken rather than as blocked.
    'items show their real shortcut, and a disabled one says exactly why',
    await evaluate(`
      (() => {
        const menu = document.querySelector('.context-menu');
        const edit = menu.querySelector('[data-item="edit-appearance"]');
        const reset = menu.querySelector('[data-item="reset-appearance"]');
        return [
          (edit.querySelector('.context-menu__shortcut')?.textContent || '').length > 0,
          reset.disabled,
          (menu.querySelector('#context-menu-reason-reset-appearance')?.textContent || '')
            .includes('has been customized'),
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    'the menu has its own search field with its own anchored regex builder',
    await evaluate(`
      (() => {
        const menu = document.querySelector('.context-menu');
        return [
          !!menu.querySelector('input[type="search"], .search-field__input'),
          !!menu.querySelector('.search-field__builder-button'),
        ];
      })()
    `),
    [true, true],
  );

  await capture('40-element-menu');

  // Filter it down to nothing, and check it says so rather than going blank.
  await evaluate(`
    (() => {
      const input = document.querySelector('.context-menu input');
      input.value = 'zzzz-no-such-item';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  check(
    'filtering to nothing gives an honest message, never a blank surface',
    await evaluate(`
      (() => {
        const menu = document.querySelector('.context-menu');
        return [
          menu.querySelectorAll('.context-menu__item').length,
          !menu.querySelector('.context-menu__empty').hidden,
        ];
      })()
    `),
    [0, true],
  );

  // Now the editor itself, opened the direct way the contract asks for.
  await evaluate(`
    (() => {
      document.querySelector('.context-menu')?.remove();
      const target = document.querySelector('.tab') || document.querySelector('button');
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, shiftKey: true, clientX: 200, clientY: 200,
      }));
      return true;
    })()
  `);
  await waitFor('!!document.querySelector(".element-appearance")', 'the appearance editor');

  check(
    'shift and a right click open the editor directly, anchored and named',
    await evaluate(`
      (() => {
        const editor = document.querySelector('.element-appearance');
        const title = editor.querySelector('.element-appearance__title').textContent || '';
        return [
          title.startsWith('Appearance of '),
          (editor.getAttribute('aria-label') || '').startsWith('Appearance of '),
          editor.querySelectorAll('.element-appearance__row').length > 15,
        ];
      })()
    `),
    [true, true, true],
  );

  check(
    // Word-depth means the properties are really there, checked by name so a
    // property that disappeared in a refactor fails here.
    'the typography really is Word-depth rather than a token gesture',
    await evaluate(`
      (() => {
        const has = (id) => !!document.querySelector('.element-appearance__row[data-property="' + id + '"]');
        return ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textDecorationLine',
                'textDecorationStyle', 'letterSpacing', 'wordSpacing', 'lineHeight',
                'textTransform', 'verticalAlign'].every(has);
      })()
    `),
    true,
  );

  check(
    'an unsupported property STAYS VISIBLE and explains the limit',
    await evaluate(`
      (() => {
        const row = document.querySelector('.element-appearance__row[data-property="textStroke"]');
        return [!!row, (row?.querySelector('.element-appearance__limit')?.textContent || '').length > 20];
      })()
    `),
    [true, true],
  );

  check(
    'every row says whether the value was set here or comes from the theme',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.element-appearance__row')];
        return rows.every(r => (r.querySelector('.element-appearance__origin')?.textContent || '').length > 10);
      })()
    `),
    true,
  );

  await capture('41-element-appearance');

  // Set a real value and watch the element actually change.
  await evaluate(`
    (() => {
      const input = document.querySelector('.element-appearance__row[data-property="fontSize"] input');
      input.value = '28';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 300));

  check(
    // Measured off the rendered element, not off the stored value. A setting
    // that persists and renders nothing is the defect this project has already
    // met once.
    'setting a property really changes the element on screen',
    await evaluate(`
      (() => {
        const styled = document.querySelector('[data-styled]');
        if (!styled) return null;
        return [
          Math.round(parseFloat(getComputedStyle(styled).fontSize)),
          document.querySelector('.element-appearance__row[data-property="fontSize"]')
            .getAttribute('data-set'),
        ];
      })()
    `),
    [28, 'yes'],
  );

  check(
    'a refused value is reported in words and changes nothing',
    await (async () => {
      await evaluate(`
        (() => {
          const input = document.querySelector('.element-appearance__row[data-property="fontSize"] input');
          input.value = '400';
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return evaluate(`
        (() => {
          const problem = document.querySelector('.element-appearance__problem');
          const styled = document.querySelector('[data-styled]');
          return [
            !problem.hidden,
            (problem.textContent || '').includes('6 to 96'),
            Math.round(parseFloat(getComputedStyle(styled).fontSize)),
          ];
        })()
      `);
    })(),
    [true, true, 28],
  );

  check(
    'resetting one property really returns the element to what shipped',
    await (async () => {
      await evaluate(`
        (() => {
          document.querySelector('.element-appearance__row[data-property="fontSize"] [data-reset-property]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return evaluate(`
        (() => {
          const row = document.querySelector('.element-appearance__row[data-property="fontSize"]');
          return [
            row.getAttribute('data-set'),
            document.querySelectorAll('[data-styled]').length,
            (document.querySelector('.element-appearance__summary').textContent || '')
              .includes('Nothing on this element is customized'),
          ];
        })()
      `);
    })(),
    ['no', 0, true],
  );

  await capture('42-element-appearance-reset');

  // -------------------------------------------------- presets and copying --

  // Set something worth saving, then name it and save it.
  await evaluate(`
    (() => {
      document.querySelector('.element-appearance')?.remove();
      const target = document.querySelector('.tab') || document.querySelector('button');
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, shiftKey: true, clientX: 200, clientY: 200,
      }));
      return true;
    })()
  `);
  await waitFor('!!document.querySelector(".element-appearance")', 'the editor again');

  // Presets persist, so a second run would start with the one the first run
  // saved. Cleared here rather than assumed empty: a check that only passes on
  // a fresh profile is a check that fails for the next person.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const removed = await evaluate(`
      (() => {
        const button = document.querySelector('[data-preset="delete"]');
        if (!button) return false;
        button.click();
        return true;
      })()
    `);
    if (!removed) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  check(
    'with nothing saved the presets row says so rather than showing an empty list',
    await evaluate(`
      (() => {
        const row = document.querySelector('.element-appearance__presets');
        return [
          !row.querySelector('.element-appearance__preset-list'),
          (row.textContent || '').includes('No styles saved yet'),
        ];
      })()
    `),
    [true, true],
  );

  check(
    'saving with nothing customized is refused, and says why',
    await (async () => {
      await evaluate(`
        (() => {
          const row = document.querySelector('.element-appearance__presets');
          row.querySelector('.element-appearance__preset-name').value = 'Loud';
          row.querySelector('[data-preset="save"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return evaluate(`
        (() => {
          const problem = document.querySelector('.element-appearance__problem');
          return [!problem.hidden, (problem.textContent || '').includes('nothing to save')];
        })()
      `);
    })(),
    [true, true],
  );

  check(
    'a saved style appears in the list and can be put back on the element',
    await (async () => {
      await evaluate(`
        (() => {
          const size = document.querySelector('.element-appearance__row[data-property="fontSize"] input');
          size.value = '26';
          size.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await evaluate(`
        (() => {
          const row = document.querySelector('.element-appearance__presets');
          row.querySelector('.element-appearance__preset-name').value = 'Loud';
          row.querySelector('[data-preset="save"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Take it off, then put the preset back on and measure the element.
      await evaluate(`
        (() => {
          document.querySelector('[data-reset="element"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const cleared = await evaluate('document.querySelectorAll("[data-styled]").length');
      await evaluate(`
        (() => {
          document.querySelector('[data-preset="apply"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return evaluate(`
        (() => {
          const styled = document.querySelector('[data-styled]');
          return [
            ${cleared},
            !!document.querySelector('.element-appearance__preset-list option[value="Loud"]'),
            styled ? Math.round(parseFloat(getComputedStyle(styled).fontSize)) : null,
          ];
        })()
      `);
    })(),
    [0, true, 26],
  );

  await capture('43-element-presets');

  // Copy from this element and paste onto another, through the menu.
  check(
    'copy and paste move a look from one element to another',
    await (async () => {
      await evaluate(`
        (() => {
          document.querySelector('.element-appearance')?.remove();
          const target = document.querySelector('[data-styled]');
          target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await evaluate(`
        (() => {
          document.querySelector('[data-item="copy-appearance"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));

      // A different element entirely: the status bar.
      await evaluate(`
        (() => {
          const other = document.querySelector('.status-bar') || document.querySelectorAll('button')[3];
          window.__pasteTarget = other;
          other.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const pasteEnabled = await evaluate(
        '!document.querySelector(`[data-item="paste-appearance"]`).disabled',
      );
      await evaluate(`
        (() => {
          document.querySelector('[data-item="paste-appearance"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 350));
      // Re-queried rather than held. A settings patch rebuilds the tree, so a
      // reference taken before the paste is a DETACHED node afterwards - and a
      // detached node computes empty strings, which reads as the paste having
      // done nothing.
      return evaluate(`
        (() => {
          const styled = [...document.querySelectorAll('[data-styled]')];
          const sizes = styled.map(n => Math.round(parseFloat(getComputedStyle(n).fontSize)));
          return [
            ${pasteEnabled},
            sizes.every(size => size === 26),
            styled.length >= 2,
          ];
        })()
      `);
    })(),
    [true, true, true],
  );

  check(
    'and everything is put back, so the next run starts from the shipped look',
    await (async () => {
      await evaluate(`
        (() => {
          for (const node of document.querySelectorAll('[data-styled]')) {
            node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
            document.querySelector('[data-item="reset-appearance"]')?.click();
          }
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return evaluate('document.querySelectorAll("[data-styled]").length');
    })(),
    0,
  );

  // ---------------------------------------------------------------- layers --

  await evaluate(`
    (() => {
      document.querySelector('.element-appearance')?.remove();
      const target = document.querySelector('.tab') || document.querySelector('button');
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, shiftKey: true, clientX: 200, clientY: 200,
      }));
      return true;
    })()
  `);
  await waitFor('!!document.querySelector(".layer-panel")', 'the layers panel');

  check(
    'with no layers the panel says so rather than showing an empty box',
    await evaluate(`
      (() => {
        const panel = document.querySelector('.layer-panel');
        return [
          panel.querySelectorAll('.layer-panel__layer').length,
          (panel.textContent || '').includes('No layers on this element'),
        ];
      })()
    `),
    [0, true],
  );

  // Add a ring, which is the easiest one to measure off the rendered element.
  await evaluate(`
    (() => {
      const panel = document.querySelector('.layer-panel');
      panel.querySelector('.layer-panel__kind').value = 'ring';
      panel.querySelector('[data-layer-action="add"]').click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 350));

  check(
    // Measured off the rendered element. A layer that persists and paints
    // nothing is the exact defect this project has met before.
    'adding a layer really paints on the element',
    await evaluate(`
      (() => {
        const styled = document.querySelector('[data-styled]');
        if (!styled) return null;
        return [
          document.querySelectorAll('.layer-panel__layer').length,
          getComputedStyle(styled).boxShadow.includes('inset'),
        ];
      })()
    `),
    [1, true],
  );

  // A second layer, so order and visibility have something to act on.
  await evaluate(`
    (() => {
      const panel = document.querySelector('.layer-panel');
      panel.querySelector('.layer-panel__kind').value = 'gradient';
      panel.querySelector('[data-layer-action="add"]').click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 350));

  check(
    'the newest layer sits on top, where the person who pressed the button is looking',
    await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.layer-panel__layer')];
        return [rows.length, rows[0].getAttribute('data-kind'), rows[1].getAttribute('data-kind')];
      })()
    `),
    [2, 'gradient', 'ring'],
  );

  check(
    'the top layer cannot be moved further up, and the control says why',
    await evaluate(`
      (() => {
        const top = document.querySelector('.layer-panel__layer');
        const up = top.querySelector('[data-layer-action="up"]');
        return [up.disabled, (up.getAttribute('title') || '').includes('top')];
      })()
    `),
    [true, true],
  );

  check(
    'hiding a layer stops it painting but leaves it in the list',
    await (async () => {
      await evaluate(`
        (() => {
          const top = document.querySelector('.layer-panel__layer');
          top.querySelector('[data-layer-toggle="visible"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 350));
      return evaluate(`
        (() => {
          const styled = document.querySelector('[data-styled]');
          const rows = [...document.querySelectorAll('.layer-panel__layer')];
          return [
            rows.length,
            rows[0].getAttribute('data-visible'),
            getComputedStyle(styled).backgroundImage.includes('gradient'),
          ];
        })()
      `);
    })(),
    // Still two rows; the hidden one paints nothing, so no gradient remains.
    [2, 'no', false],
  );

  check(
    'a locked layer refuses an edit OUT LOUD rather than swallowing it',
    await (async () => {
      await evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('.layer-panel__layer')];
          rows[1].querySelector('[data-layer-toggle="locked"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('.layer-panel__layer')];
          rows[1].querySelector('[data-layer-action="remove"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return evaluate(`
        (() => {
          const problem = document.querySelector('.element-appearance__problem');
          return [
            document.querySelectorAll('.layer-panel__layer').length,
            !problem.hidden,
            (problem.textContent || '').includes('locked'),
          ];
        })()
      `);
    })(),
    [2, true, true],
  );

  await capture('44-element-layers');

  check(
    'unlocking is always allowed, and the layer then really goes',
    await (async () => {
      await evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('.layer-panel__layer')];
          rows[1].querySelector('[data-layer-toggle="locked"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('.layer-panel__layer')];
          rows[1].querySelector('[data-layer-action="remove"]').click();
          rows[0].querySelector('[data-layer-action="remove"]').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return evaluate(`
        (() => {
          const styled = document.querySelector('[data-styled]');
          return [
            document.querySelectorAll('.layer-panel__layer').length,
            styled === null || !getComputedStyle(styled).boxShadow.includes('inset'),
          ];
        })()
      `);
    })(),
    [0, true],
  );

  socket.close();

  const failed = findings.filter((finding) => !finding.ok);
  log('');
  log(findings.length - failed.length + ' of ' + findings.length + ' checks passed');
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
