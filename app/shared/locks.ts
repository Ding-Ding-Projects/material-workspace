/**
 * Toy locks: a self-imposed speed bump on any element.
 *
 * IT IS JUST FOR FUN, and every surface says so. Not encryption, not
 * protection from anyone else with this computer, and never fit for guarding
 * anything sensitive. Describing it otherwise would be the dishonest part;
 * offering it is not.
 *
 * The rule that does the work: EACH LOCK HAS ITS OWN CREDENTIAL. There is no
 * master, and no inheritance. Unlocking one surface never unlocks another,
 * locking a group does not relock its members under the group's credential,
 * and a locked property inside a locked tab is two locks with two independent
 * answers. Somebody who wants one credential everywhere gets there by
 * deliberately reusing it, never by the application assuming it.
 */

export const POLICIES = [
  'pin',
  'password',
  'pin+password',
  'password+totp',
  'pin+totp',
  'password+pin+totp',
] as const;

export type Policy = (typeof POLICIES)[number];

export type Factor = 'pin' | 'password' | 'totp';

/**
 * The factors a policy asks for, in the order they are asked.
 *
 * Derived from the policy name rather than listed separately, so a policy
 * cannot exist with no factors or with factors nobody wrote down.
 */
export function factorsOf(policy: Policy): Factor[] {
  return policy.split('+') as Factor[];
}

export interface LockRecord {
  /** The exact element this lock belongs to. Never shared. */
  readonly target: string;
  readonly policy: Policy;
  /**
   * How long an unlock lasts.
   *
   * `surface` means this element until it is left, `minutes` a fixed span,
   * `session` until the application closes.
   */
  readonly duration: { readonly kind: 'surface' } | { readonly kind: 'minutes'; readonly minutes: number } | { readonly kind: 'session' };
  /** Whether it starts locked on every launch. */
  readonly lockedOnLaunch: boolean;
}

export interface Attempt {
  readonly factor: Factor;
  readonly matched: boolean;
}

export type Progress =
  | { readonly kind: 'need'; readonly factor: Factor; readonly step: number; readonly of: number }
  | { readonly kind: 'unlocked' }
  | { readonly kind: 'refused'; readonly message: string; readonly recovery: string };

/**
 * Where an unlock has got to.
 *
 * A verified factor is kept only for the CURRENT attempt. Carrying it across
 * attempts would mean somebody who got the PIN right once never has to give it
 * again, which quietly turns a two-factor policy into a one-factor one.
 */
export function progress(
  policy: Policy,
  attempts: readonly Attempt[],
  dataFolder: string,
): Progress {
  const wanted = factorsOf(policy);

  for (let index = 0; index < wanted.length; index += 1) {
    const factor = wanted[index] as Factor;
    const attempt = attempts[index];

    if (attempt === undefined) {
      return { kind: 'need', factor, step: index + 1, of: wanted.length };
    }
    if (attempt.factor !== factor || !attempt.matched) {
      return {
        kind: 'refused',
        // Says nothing about the real value: not its length, not how close the
        // attempt was, not a prefix. The refusal rules apply to a toy lock
        // exactly as they apply to a real credential.
        message: 'That does not match.',
        recovery: recoveryAdvice(dataFolder),
      };
    }
  }

  return { kind: 'unlocked' };
}

export function recoveryAdvice(dataFolder: string): string {
  return (
    'Forgotten it? Delete this folder and every lock resets: ' +
    dataFolder +
    '. This is a lock for concentration, not security - anybody with this ' +
    'computer can undo it that way, and it is meant to be undoable.'
  );
}

/**
 * The attempt budget.
 *
 * Rate limited so a wrong answer costs a moment, and DELIBERATELY not
 * escalating: a toy lock that locks somebody out harder each time has become
 * the obstacle it was pretending to be. Nothing is ever wiped.
 */
export class AttemptBudget {
  private readonly wrong = new Map<string, number>();

  constructor(
    private readonly allowed = 5,
    private readonly cooldownMs = 15_000,
  ) {}

  /** Wrong attempts recorded for a target. */
  count(target: string): number {
    return this.wrong.get(target) ?? 0;
  }

  record(target: string): void {
    this.wrong.set(target, this.count(target) + 1);
  }

  /** Reset on success, so a correct answer clears the slate. */
  clear(target: string): void {
    this.wrong.delete(target);
  }

  /** How long to wait, in milliseconds. Zero when there is nothing to wait for. */
  waitFor(target: string): number {
    const over = this.count(target) - this.allowed;
    return over <= 0 ? 0 : this.cooldownMs;
  }

  describe(target: string): string {
    const wait = this.waitFor(target);
    if (wait === 0) return '';
    return (
      'Too many tries just now. Wait ' +
      Math.round(wait / 1000) +
      ' seconds and try again - nothing has been locked out permanently and nothing was deleted.'
    );
  }
}

/**
 * Whether an unlock is still in force.
 *
 * `surface` unlocks end when the element is left, which is why the caller
 * passes whether it still has focus. Guessing here instead would mean an
 * unlock that outlives its surface or dies while somebody is still using it.
 */
export function stillUnlocked(
  record: LockRecord,
  unlockedAt: number,
  now: number,
  onSurface: boolean,
): boolean {
  switch (record.duration.kind) {
    case 'surface':
      return onSurface;
    case 'minutes':
      return now - unlockedAt < record.duration.minutes * 60_000;
    case 'session':
      return true;
  }
}

/**
 * A locked element is DISABLED but still an unlock target.
 *
 * The distinction matters: a plainly disabled control swallows every event, so
 * clicking a locked thing would do nothing at all and leave somebody with no
 * way in. The caller wraps it so activation opens the prompt without ever
 * running the protected action.
 */
export interface LockedElementState {
  readonly locked: boolean;
  /** What assistive technology should read. */
  readonly accessibleSuffix: string;
  /** Whether the protected action may run. */
  readonly actionAllowed: boolean;
}

export function elementState(locked: boolean, name: string): LockedElementState {
  return {
    locked,
    accessibleSuffix: locked ? name + ', locked. Activate to unlock.' : name,
    actionAllowed: !locked,
  };
}

/**
 * How a locked item appears in a search or the command palette.
 *
 * Still listed, and labelled as locked. Hiding it would mean somebody
 * searching for a thing they locked concludes it is gone; teleporting past the
 * lock would make the lock decorative.
 */
export interface SearchAppearance {
  readonly listed: boolean;
  readonly label: string;
  readonly action: 'prompt-to-unlock' | 'activate';
}

export function searchAppearance(
  name: string,
  locked: boolean,
  excludeLocked: boolean,
): SearchAppearance {
  if (locked && excludeLocked) {
    return { listed: false, label: name, action: 'prompt-to-unlock' };
  }
  return {
    listed: true,
    label: locked ? name + ' (locked)' : name,
    action: locked ? 'prompt-to-unlock' : 'activate',
  };
}
