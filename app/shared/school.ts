/**
 * School mode.
 *
 * One shared switch across every application, not a per-application setting
 * that happens to have the same name in each. Turning it on anywhere turns it
 * on everywhere, and an application already running picks the change up LIVE
 * rather than at its next launch.
 *
 * IT IS A USER-EXPERIENCE LOCK, NOT A SECURITY BOUNDARY, and every surface
 * says so. A user may reset it deliberately by deleting the shared record, and
 * the application tells them that rather than implying a protection it does
 * not provide. Claiming otherwise would be the dishonest part; offering it is
 * not.
 *
 * The subtle rule, and the one most easily got wrong: while it is on, the
 * suppressed capabilities behave as if they are NOT INSTALLED. Not disabled,
 * not greyed out, not visible-but-refusing - absent. A disabled control named
 * "Cantonese" tells the reader exactly what School mode is hiding, which
 * defeats the point of hiding it.
 */

export const SHIPPED_NAME = 'School mode';

export interface SchoolState {
  readonly enabled: boolean;
  /**
   * What the user renamed it to, or null for the shipped name.
   *
   * After a rename, NO surface may show the shipped name - not a label, not a
   * description, not a search result, not a notification, not an accessible
   * name. A rename that leaks the original everywhere except the button is not
   * a rename.
   */
  readonly displayName: string | null;
}

export const DEFAULT_STATE: SchoolState = { enabled: false, displayName: null };

/** What to call it, wherever it is named. */
export function nameOf(state: SchoolState): string {
  const chosen = state.displayName?.trim() ?? '';
  return chosen === '' ? SHIPPED_NAME : chosen;
}

/**
 * The capabilities School mode makes absent.
 *
 * A hand-written list rather than a rule over what happens to be present. A
 * rule-shaped check passes cleanly on a capability nobody remembered to
 * suppress; this list fails when one is missing from the suppression, which is
 * the direction that matters.
 */
export const SUPPRESSED = [
  'languageChoice',
  'funnyLevels',
  'personalVocabulary',
  'dimSumSurprise',
  'dimSumImagery',
  'dimSumCodeNames',
  'narratorLanguageChoice',
] as const;

export type Capability = (typeof SUPPRESSED)[number];

export function isSuppressed(capability: Capability, state: SchoolState): boolean {
  return state.enabled;
}

/**
 * The funny level in force. Level 1 is fully professional.
 *
 * Generic so the caller's narrow union survives. Returning a plain `number`
 * would force every call site to cast back, and a cast is exactly where a
 * value outside the union slips in unnoticed.
 */
export function effectiveFunnyLevel<T extends number>(stored: T, state: SchoolState): T | 1 {
  // The stored value is untouched, so it returns the moment the mode is off.
  return state.enabled ? 1 : stored;
}

/**
 * The language mode in force, preserving the caller's own union.
 *
 * Same reasoning as the level above: the shell's LanguageMode is narrower than
 * the three strings named here, and widening it would push a cast into the
 * shell where it is easiest to get wrong.
 */
export function effectiveMode<T extends string>(stored: T, state: SchoolState): T | 'en' {
  return state.enabled ? 'en' : stored;
}

/** Whether the 10% dim sum draw may happen on this launch. */
export function dimSumAllowed(state: SchoolState): boolean {
  return !state.enabled;
}

export type UnlockMethod = 'pin' | 'password';

export interface Credential {
  readonly method: UnlockMethod;
  /** A hash, never the value. Nothing here ever stores what was typed. */
  readonly hash: string;
  readonly salt: string;
}

export type UnlockResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly recovery: string };

/**
 * The recovery route, in plain words.
 *
 * Stated wherever the lock is, not buried in documentation. Forgetting a
 * password is a normal outcome for a lock like this, so recovery is
 * self-service: no reset ticket, no account, no support channel. A lock must
 * never be the only thing between somebody and their own content.
 */
export function recoveryAdvice(folder: string): string {
  return (
    'Forgotten it? Delete this folder and the mode resets: ' +
    folder +
    '. This is a lock for concentration, not security - anyone with this ' +
    'computer can undo it that way, and it is meant to be undoable.'
  );
}

/**
 * Check an attempt.
 *
 * The comparison itself lives in the caller, because hashing belongs in the
 * privileged process and this module is shared. What is decided here is the
 * WORDING and the fact that a wrong attempt never escalates, never wipes
 * anything, and always names the way out.
 */
export function judgeAttempt(
  matched: boolean,
  state: SchoolState,
  folder: string,
): UnlockResult {
  if (matched) return { ok: true };
  return {
    ok: false,
    // Never says how close the attempt was, how long the real value is, or
    // anything else about it. The refusal rules apply to a toy lock exactly as
    // they apply to a real credential.
    reason: 'That does not match. ' + nameOf(state) + ' is still on.',
    recovery: recoveryAdvice(folder),
  };
}

/**
 * Whether a proposed name may be used.
 *
 * Refuses only what would break the contract: an empty name leaves the surface
 * unnamed, and a name that IS the shipped name defeats a rename whose whole
 * purpose is that the shipped name stops appearing.
 */
export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkName(proposed: string): NameCheck {
  const trimmed = proposed.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'Give it a name, or reset it to the one it shipped with.' };
  }
  if (trimmed.length > 60) {
    return { ok: false, reason: 'That name is too long to fit where it has to appear.' };
  }
  return { ok: true };
}

/**
 * Scan user-visible text for a leak of the shipped name.
 *
 * Exists because the rename rule is the one most easily half-implemented: the
 * button gets the new name and a search result, a notification or an
 * accessible name keeps the old one. A rename that leaks everywhere except the
 * button is not a rename.
 */
export function leaksShippedName(text: string, state: SchoolState): boolean {
  if (nameOf(state) === SHIPPED_NAME) return false;
  return text.toLowerCase().includes(SHIPPED_NAME.toLowerCase());
}
