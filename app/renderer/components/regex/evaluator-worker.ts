/**
 * The regular-expression evaluation worker.
 *
 * Evaluation happens HERE, off the main thread, for one reason that is not
 * negotiable: a catastrophic pattern blocks inside a single `exec()` call, and
 * JavaScript cannot interrupt that. A deadline checked between matches never
 * runs, because control never comes back between matches.
 *
 * Measured in this project's own test suite before the worker existed: a
 * `(a+)+$` pattern against 31 characters ran for 94 SECONDS against a stated
 * 750ms bound. The bound was not merely exceeded, it was unreachable.
 *
 * A worker can be terminated from the outside. That is the whole point of
 * putting the work here, and it is why the deadline belongs to the host rather
 * than to this file.
 */

import { compile } from './tokenize.js';
import { runMatches, runReplacement } from './safety.js';

export interface EvaluationRequest {
  id: number;
  pattern: string;
  flags: string;
  sample: string;
  replacement: string | null;
}

export interface EvaluationResponse {
  id: number;
  ok: boolean;
  error: string | null;
  matches: ReturnType<typeof runMatches> | null;
  replacement: { output: string; error: string | null } | null;
}

export function evaluate(request: EvaluationRequest): EvaluationResponse {
  const compiled = compile(request.pattern, request.flags);
  if (compiled.error !== null) {
    return {
      id: request.id,
      ok: false,
      error: compiled.error,
      matches: null,
      replacement: null,
    };
  }

  const matches = runMatches(compiled.regex, request.sample);
  const replacement =
    request.replacement === null
      ? null
      : runReplacement(compiled.regex, request.sample, request.replacement);

  return { id: request.id, ok: true, error: null, matches, replacement };
}

// Browser worker entry. Guarded so the module can also be imported directly by
// tests and by the Node host without a DedicatedWorkerGlobalScope present.
declare const self: {
  onmessage?: (event: { data: EvaluationRequest }) => void;
  postMessage?: (message: EvaluationResponse) => void;
} | undefined;

if (typeof self !== 'undefined' && typeof self?.postMessage === 'function') {
  self.onmessage = (event) => {
    self.postMessage?.(evaluate(event.data));
  };
}
