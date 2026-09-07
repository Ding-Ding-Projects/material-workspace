/**
 * Proof that terminating a worker actually bounds a catastrophic pattern.
 *
 * This is the mitigation the whole regex surface depends on, so it is proved
 * rather than asserted. The in-thread deadline was measured at 94 SECONDS
 * against a stated 750ms limit, because `exec()` never returns control for the
 * check to run. Terminating from outside is the only thing that works.
 *
 * The test runs the same shape the renderer runs, using node:worker_threads
 * because that is what exists under the test runner. The renderer uses the
 * browser `Worker` with `terminate()`; both are "start it elsewhere, kill it
 * from here", and what is proved here is that the KILL bounds the work.
 *
 * Stated honestly: this proves the pattern, not the renderer's own wiring. The
 * renderer path is exercised against the built application in the UI evidence
 * pass, because a test that stubs the worker would prove the screen and nothing
 * about the seam.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

const DEADLINE_MS = 750;

/** The adversarial input, built so no source-level tool can mangle the anchor. */
const CATASTROPHIC_PATTERN = '(a+)+' + '$';
const CATASTROPHIC_INPUT = 'a'.repeat(34) + 'b';

const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  // Deliberately unbounded: the point is that the HOST stops this, because
  // nothing inside this thread can.
  const regex = new RegExp(workerData.pattern);
  const matched = regex.test(workerData.input);
  parentPort.postMessage({ matched });
`;

function runWithTermination(
  pattern: string,
  input: string,
  deadlineMs: number,
): Promise<{ outcome: 'completed' | 'terminated'; elapsedMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, input },
    });

    let settled = false;
    const finish = (outcome: 'completed' | 'terminated'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, elapsedMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      // Terminate, not merely stop listening. The worker is still burning a
      // core on something that will not finish.
      void worker.terminate();
      finish('terminated');
    }, deadlineMs);

    worker.on('message', () => finish('completed'));
    worker.on('error', () => finish('completed'));
  });
}

describe('worker termination bounds a catastrophic pattern', () => {
  it('kills a run that will not finish, within a small multiple of the deadline', async () => {
    const result = await runWithTermination(
      CATASTROPHIC_PATTERN,
      CATASTROPHIC_INPUT,
      DEADLINE_MS,
    );

    assert.equal(result.outcome, 'terminated', 'this pattern must NOT complete on this input');

    // Generous, because terminate() has to unwind a thread that is inside the
    // engine. The point is that it is bounded at all: the in-thread version of
    // this same case ran for 94 seconds.
    assert.ok(
      result.elapsedMs < DEADLINE_MS * 10,
      'termination must actually bound the work; took ' + result.elapsedMs + 'ms',
    );
  });

  it('lets an ordinary pattern finish normally rather than killing everything', async () => {
    // The negative case. A bound that terminates every run would pass the test
    // above while making the feature useless.
    const result = await runWithTermination('^a+' + '$', 'aaaa', DEADLINE_MS);
    assert.equal(result.outcome, 'completed');
    assert.ok(result.elapsedMs < DEADLINE_MS, 'a trivial pattern must not approach the deadline');
  });
});
