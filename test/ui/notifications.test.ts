/**
 * The notification stores own logic.
 *
 * Unit-tested here rather than driven through the window, because driving every
 * severity from the interface would have needed a debug hook in shipped code:
 * a backdoor for the convenience of a test is a worse trade than testing the
 * class directly and driving ONE real path in the built application.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Imported FIRST, for its side effect. The store builds its host element at
// construction, so document must exist before the module below is evaluated,
// and ESM evaluates imports in order.
import './fake-dom.js';
import { Notifications } from '../../app/renderer/components/notifications.js';
describe('notification store', () => {
  it('never auto-dismisses a warning or an error', async () => {
    const notifications = new Notifications();
    notifications.push({ severity: 'error', title: 'A failure', timeoutMs: 5 });
    notifications.push({ severity: 'warning', title: 'A caution', timeoutMs: 5 });

    // Well past the timeout that was ASKED for. The severity overrides it,
    // because a message that disappears before it is read was never delivered.
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(notifications.visible().length, 2, 'neither may auto-dismiss');

    notifications.dispose();
  });

  it('does auto-dismiss the merely informative', async () => {
    // The negative case. A store that never dismissed anything would pass the
    // test above while making the feature useless.
    const notifications = new Notifications();
    notifications.push({ severity: 'info', title: 'Just so you know', timeoutMs: 20 });
    assert.equal(notifications.visible().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notifications.visible().length, 0, 'an info toast must clear itself');

    notifications.dispose();
  });

  it('replaces a keyed notification rather than stacking a second copy', () => {
    const notifications = new Notifications();
    const first = notifications.push({ title: 'Copying 1 of 40', key: 'copy', severity: 'progress' });
    const second = notifications.push({ title: 'Copying 2 of 40', key: 'copy', severity: 'progress' });

    assert.equal(first, second, 'the same record must be reused');
    assert.equal(notifications.visible().length, 1, 'progress must not become forty toasts');
    assert.equal(notifications.visible()[0]?.title, 'Copying 2 of 40');

    notifications.dispose();
  });

  it('keeps dismissed notifications reviewable', () => {
    const notifications = new Notifications();
    const id = notifications.push({ title: 'Something happened', severity: 'success' });
    notifications.dismiss(id);

    assert.equal(notifications.visible().length, 0, 'it leaves the screen');
    assert.equal(notifications.all().length, 1, 'and stays in the centre');
    assert.equal(notifications.all()[0]?.dismissed, true);

    notifications.dispose();
  });

  it('reports what a bulk dismiss actually did, not what was selected', () => {
    const notifications = new Notifications();
    const a = notifications.push({ title: 'One', severity: 'warning' });
    const b = notifications.push({ title: 'Two', severity: 'warning' });
    notifications.dismiss(a);

    const outcome = notifications.dismissMany([a, b, 'does-not-exist']);

    // Three ids were passed. One was already dismissed and one does not exist,
    // so reporting "3 dismissed" would be a false statement about what changed.
    assert.deepEqual(outcome, { dismissed: 1, alreadyDismissed: 1 });

    notifications.dispose();
  });

  it('bounds retention without discarding anything still on screen', () => {
    const notifications = new Notifications();
    // Far more than the retention limit, all dismissed except the last few.
    for (let index = 0; index < 520; index += 1) {
      const id = notifications.push({ title: 'Entry ' + index, severity: 'info', timeoutMs: 0 });
      if (index < 500) notifications.dismiss(id);
    }
    assert.ok(notifications.all().length <= 500, 'retention must be bounded');
    assert.ok(
      notifications.visible().length > 0,
      'nothing still visible may be discarded to make room',
    );

    notifications.dispose();
  });
});
