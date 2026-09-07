/**
 * The host side of regular-expression evaluation.
 *
 * It owns the deadline, and it enforces the deadline by TERMINATING the worker.
 * That is the only mechanism that actually works: a pattern stuck inside a
 * single `exec()` never yields, so nothing running in the same thread as the
 * regex can stop it — not a timer, not a check between iterations, not a
 * try/catch.
 *
 * When a run is killed the result says so, in words, and reports how long it was
 * given. Silence here would be indistinguishable from "no matches", which is the
 * wrong answer rather than a missing one.
 */

import { EVALUATION_LIMITS } from './safety.js';
import type { EvaluationRequest, EvaluationResponse } from './evaluator-worker.js';

export interface EvaluationOutcome {
  status: 'ok' | 'invalid-pattern' | 'timed-out' | 'unavailable';
  response: EvaluationResponse | null;
  /** Plain-language explanation, safe to render directly. */
  message: string | null;
  elapsedMs: number;
}

/** The worker script, emitted beside the renderer bundle by the build. */
const WORKER_URL = './regex-worker.js';

export class RegexEvaluator {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: {
    id: number;
    resolve: (outcome: EvaluationOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
    startedAt: number;
  } | null = null;

  private spawn(): Worker | null {
    try {
      return new Worker(new URL(WORKER_URL, import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    if (!worker) return null;

    worker.onmessage = (event: MessageEvent<EvaluationResponse>) => {
      const pending = this.pending;
      if (!pending || event.data.id !== pending.id) return;
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve({
        status: event.data.ok ? 'ok' : 'invalid-pattern',
        response: event.data,
        message: event.data.ok ? null : event.data.error,
        elapsedMs: performance.now() - pending.startedAt,
      });
    };

    worker.onerror = () => {
      const pending = this.pending;
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve({
        status: 'unavailable',
        response: null,
        message: 'The evaluation worker stopped unexpectedly. Nothing was matched.',
        elapsedMs: performance.now() - pending.startedAt,
      });
    };

    this.worker = worker;
    return worker;
  }

  /**
   * Evaluate, or give up and say so. Only ever one run in flight: a superseded
   * request is replaced rather than queued, because the user has already typed
   * past it.
   */
  evaluate(
    pattern: string,
    flags: string,
    sample: string,
    replacement: string | null = null,
    deadlineMs: number = EVALUATION_LIMITS.deadlineMs,
  ): Promise<EvaluationOutcome> {
    this.cancelPending();

    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({
        status: 'unavailable',
        response: null,
        message:
          'Workers are unavailable in this context, so patterns cannot be evaluated safely here. ' +
          'Nothing was run: evaluating on the main thread risks freezing the window on a slow pattern.',
        elapsedMs: 0,
      });
    }

    const id = this.nextId++;
    const request: EvaluationRequest = { id, pattern, flags, sample, replacement };

    return new Promise<EvaluationOutcome>((resolve) => {
      const startedAt = performance.now();
      const timer = setTimeout(() => {
        // Terminate, do not merely stop listening. The worker is still burning a
        // core on a pattern that will not finish.
        this.terminate();
        this.pending = null;
        resolve({
          status: 'timed-out',
          response: null,
          message:
            'This pattern did not finish within ' +
            deadlineMs +
            'ms and was stopped. That almost always means catastrophic backtracking — ' +
            'check the safety warnings above the pattern.',
          elapsedMs: performance.now() - startedAt,
        });
      }, deadlineMs);

      this.pending = { id, resolve, timer, startedAt };
      worker.postMessage(request);
    });
  }

  private cancelPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.resolve({
      status: 'ok',
      response: null,
      message: null,
      elapsedMs: 0,
    });
    this.pending = null;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  dispose(): void {
    this.cancelPending();
    this.terminate();
  }
}
