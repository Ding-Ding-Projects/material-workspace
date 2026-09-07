/**
 * The unlock ladder: play your way out of a lockout.
 *
 * A lockout is the one moment an application has nothing to offer - a
 * countdown, and a person watching it. The ladder replaces the watching with
 * something to do, escalating as it goes:
 *
 *   1. Dim sum. One dish, four choices.
 *   2. Ten easy sums, after five wrong dishes.
 *   3. Whack-a-mole, after a single wrong sum.
 *   4. The clock, after a lost round.
 *
 * Falling to the bottom leaves somebody exactly where they started, so the
 * ladder can only ever improve a locked-out afternoon.
 *
 * THE FIVE RULES BELOW ARE THE WHOLE SAFETY OF IT. An implementation that
 * keeps the games and drops any one of them has built a second, far weaker
 * password.
 */

export type Rung = 'dimsum' | 'sums' | 'moles' | 'clock';

export const RUNGS: readonly Rung[] = ['dimsum', 'sums', 'moles', 'clock'];

/** Wrong dishes before the sums. */
export const DISHES_BEFORE_SUMS = 5;
/** How many sums, all of which must be right. */
export const SUM_COUNT = 10;
/** Skips allowed per rolling hour, across every lockout. */
export const SKIP_BUDGET = 3;
export const BUDGET_WINDOW_MS = 60 * 60 * 1000;

export interface LadderState {
  readonly rung: Rung;
  /** Wrong dishes so far, at rung one. */
  readonly wrongDishes: number;
  /** Whether this lockout has already used its ladder. */
  readonly spent: boolean;
}

/**
 * Where the ladder starts.
 *
 * SCHOOL MODE STARTS AT THE SUMS. Rung one is a dim sum question, and School
 * mode requires every dim sum capability to behave as though it is not
 * installed - so the rung is ABSENT rather than skipped with a message,
 * because a message naming the hidden thing is exactly what School mode
 * forbids. One function decides this so no surface can get it wrong locally.
 */
export function startingRung(schoolMode: boolean): Rung {
  return schoolMode ? 'sums' : 'dimsum';
}

export function initialState(schoolMode: boolean): LadderState {
  return { rung: startingRung(schoolMode), wrongDishes: 0, spent: false };
}

/** The next rung down, or null at the bottom. */
export function fallTo(rung: Rung): Rung | null {
  const at = RUNGS.indexOf(rung);
  return at < 0 || at >= RUNGS.length - 1 ? null : (RUNGS[at + 1] as Rung);
}

// ------------------------------------------------------------- the budget --

export interface SkipRecord {
  /** Millisecond clock readings of skips already granted. */
  readonly grantedAt: readonly number[];
}

/**
 * Whether another skip may be granted.
 *
 * THIS IS WHAT MAKES THE LADDER SAFE RATHER THAN CLEVER. Four choices is
 * one-in-four, ten small sums are trivial to compute, and a mole schedule is
 * arithmetic - so a machine can play it. Without a cap, solving beats waiting
 * and brute force gets cheaper, which is the single thing a lockout exists to
 * prevent. An implementation without this has quietly removed the lockout.
 */
export function skipsRemaining(record: SkipRecord, now: number): number {
  const live = record.grantedAt.filter((at) => now - at < BUDGET_WINDOW_MS);
  return Math.max(0, SKIP_BUDGET - live.length);
}

export function grantSkip(record: SkipRecord, now: number): SkipRecord {
  const live = record.grantedAt.filter((at) => now - at < BUDGET_WINDOW_MS);
  return { grantedAt: [...live, now] };
}

// ------------------------------------------------------------ challenges --

export interface Challenge {
  readonly rung: Rung;
  /** Single-use. Consumed before grading, so a wrong answer cannot be retried. */
  readonly nonce: string;
  readonly expiresAt: number;
  readonly payload: DishChallenge | SumsChallenge | MolesChallenge;
}

export interface DishChallenge {
  readonly kind: 'dimsum';
  readonly imageId: string;
  readonly choices: readonly string[];
  readonly answerIndex: number;
}

export interface SumsChallenge {
  readonly kind: 'sums';
  readonly questions: readonly { readonly a: number; readonly b: number; readonly op: '+' | '-' }[];
}

export interface MolesChallenge {
  readonly kind: 'moles';
  /** Which cell, when, and for how long. */
  readonly schedule: readonly { readonly cell: number; readonly atMs: number; readonly forMs: number }[];
  readonly durationMs: number;
  readonly needed: number;
}

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Grade an answer.
 *
 * Every rule here exists because the obvious implementation is exploitable:
 *
 *   - The NONCE is consumed by the caller before this runs, so a wrong answer
 *     cannot be retried against the same question and a right one cannot be
 *     replayed.
 *   - EXPIRY is checked, so a challenge cannot be banked.
 *   - A TIMED GAME CANNOT BE WON FASTER THAN IT LASTS. Rejecting an early
 *     submission is what stops a script returning a perfect score the instant
 *     it receives the schedule.
 *   - EACH MOLE IS GRADED ONCE, against a mole that was genuinely visible in
 *     that cell at that moment, or "hit the moles" degrades into "send enough
 *     taps".
 */
export function grade(
  challenge: Challenge,
  answer: unknown,
  now: number,
): Verdict {
  if (now > challenge.expiresAt) {
    return { ok: false, reason: 'That challenge expired. Here is a new one.' };
  }

  switch (challenge.payload.kind) {
    case 'dimsum': {
      if (typeof answer !== 'number') return { ok: false, reason: 'Pick one of the dishes.' };
      return answer === challenge.payload.answerIndex
        ? { ok: true }
        : { ok: false, reason: 'Not that one.' };
    }

    case 'sums': {
      const payload = challenge.payload;
      if (!Array.isArray(answer) || answer.length !== payload.questions.length) {
        return { ok: false, reason: 'Answer all of them.' };
      }
      for (let index = 0; index < payload.questions.length; index += 1) {
        const question = payload.questions[index] as SumsChallenge['questions'][number];
        const expected = question.op === '+' ? question.a + question.b : question.a - question.b;
        if (answer[index] !== expected) {
          // Which one was wrong is deliberately not said. It would turn ten
          // questions into ten independent one-question challenges.
          return { ok: false, reason: 'One of those is not right.' };
        }
      }
      return { ok: true };
    }

    case 'moles': {
      const payload = challenge.payload;
      if (!Array.isArray(answer)) return { ok: false, reason: 'No hits were sent.' };

      const startedAt = challenge.expiresAt - payload.durationMs;
      if (now < startedAt + payload.durationMs) {
        // A round that has not finished cannot have been won. Without this a
        // script returns a perfect score the instant it receives the schedule.
        return { ok: false, reason: 'That round has not finished yet.' };
      }

      const used = new Set<number>();
      let hits = 0;
      for (const raw of answer as unknown[]) {
        // Narrowed into real numbers first. Reading the fields off an `unknown`
        // inside the comparison below leaves the compiler unable to prove they
        // are numbers, and a `>=` against an unknown is a comparison whose
        // answer nobody can predict.
        const entry = raw as { cell?: unknown; atMs?: unknown } | null;
        if (typeof entry?.cell !== 'number' || typeof entry?.atMs !== 'number') continue;
        const cell = entry.cell;
        const atMs = entry.atMs;

        const at = payload.schedule.findIndex(
          (mole, index) =>
            !used.has(index) &&
            mole.cell === cell &&
            atMs >= mole.atMs &&
            atMs <= mole.atMs + mole.forMs,
        );
        // Each mole counts once, and only against a mole that was genuinely
        // visible in that cell at that moment.
        if (at >= 0) {
          used.add(at);
          hits += 1;
        }
      }

      return hits >= payload.needed
        ? { ok: true }
        : { ok: false, reason: 'Not quite - ' + hits + ' of ' + payload.needed + '.' };
    }
  }
}

/**
 * What clearing the ladder actually does.
 *
 * IT CLEARS THE WAITING, NEVER THE CREDENTIAL. Winning does not sign anybody
 * in, does not mint a session, and does not set a cookie: the person is
 * returned to the ordinary prompt and still has to know their password.
 * "Guess a dumpling" is not an authentication factor and must never be
 * reachable as one.
 *
 * IT ALSO NEVER REFUNDS THE ATTEMPT BUDGET. Serving the clock returns some
 * number of attempts; the ladder returns exactly the same number and not one
 * more. The moment solving beats waiting, brute force gets cheaper.
 */
export interface LadderReward {
  readonly clearsWait: true;
  readonly grantsSession: false;
  readonly extraAttempts: 0;
  /** The underlying escalation is untouched. */
  readonly resetsEscalation: false;
}

export const REWARD: LadderReward = {
  clearsWait: true,
  grantsSession: false,
  extraAttempts: 0,
  resetsEscalation: false,
};

/**
 * The lockout wait, which the ladder never shortens for the next time.
 *
 * Exponential and capped. Somebody who spends their whole ladder budget still
 * walks into an exponentially longer wall.
 */
export function lockoutWaitMs(consecutiveLockouts: number, capMs = 30 * 60_000): number {
  const base = 30_000 * 2 ** Math.max(0, consecutiveLockouts - 1);
  return Math.min(base, capMs);
}
