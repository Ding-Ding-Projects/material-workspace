/**
 * Policy pushed from the server to every client.
 *
 * The rules here are about DISTRIBUTION, not about what a policy says. What it
 * says is the governance layer's business, on the client, where it is applied.
 *
 * Two properties matter and both are the sort that fail silently:
 *
 *   - A client must never move BACKWARDS to an older policy. A stale reply
 *     arriving late, out of order, would otherwise quietly re-enable something
 *     an administrator had just turned off, and nothing would report it.
 *   - A client that cannot reach the server keeps the last policy it had.
 *     Failing open would mean an outage silently removes every restriction,
 *     which is exactly backwards.
 */

export interface PolicyDocument {
  /** Monotonic. The whole ordering rests on this. */
  readonly version: number;
  /** When the administrator published it, as an ISO-8601 string. */
  readonly publishedAt: string;
  readonly settings: Readonly<Record<string, PolicyValue>>;
}

export type PolicyValue = string | number | boolean | readonly string[];

export type PolicyDecision =
  | { readonly applied: true; readonly policy: PolicyDocument }
  | { readonly applied: false; readonly reason: string };

/**
 * Decide whether an arriving policy replaces the one in force.
 *
 * `current` being null is a client that has never had one, which is the only
 * case where any version is acceptable.
 */
export function accept(
  current: PolicyDocument | null,
  incoming: PolicyDocument,
): PolicyDecision {
  if (!isWellFormed(incoming)) {
    return { applied: false, reason: 'the policy was malformed and was not applied' };
  }
  if (current === null) return { applied: true, policy: incoming };

  if (incoming.version < current.version) {
    return {
      applied: false,
      reason:
        'a policy older than the one in force arrived and was ignored (version ' +
        incoming.version +
        ' behind ' +
        current.version +
        ')',
    };
  }
  if (incoming.version === current.version) {
    // Same version, possibly different content. Refused, because accepting it
    // would make the version number meaningless as an ordering, and an
    // administrator who edited without bumping needs to be told rather than
    // silently obeyed on whichever node happened to poll last.
    return { applied: false, reason: 'that policy version is already in force' };
  }

  return { applied: true, policy: incoming };
}

export function isWellFormed(policy: unknown): policy is PolicyDocument {
  if (typeof policy !== 'object' || policy === null) return false;
  const candidate = policy as Partial<PolicyDocument>;
  if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version)) return false;
  if (candidate.version < 1) return false;
  if (typeof candidate.publishedAt !== 'string' || candidate.publishedAt === '') return false;
  if (typeof candidate.settings !== 'object' || candidate.settings === null) return false;

  for (const value of Object.values(candidate.settings)) {
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') continue;
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) continue;
    return false;
  }
  return true;
}

/** The policy in force on this server, and the audit of what it refused. */
export class PolicyStore {
  private current: PolicyDocument | null = null;
  private readonly refusals: { at: number; reason: string; version: number }[] = [];

  get(): PolicyDocument | null {
    return this.current;
  }

  /** What was refused and why. Bounded, so a hostile pusher cannot grow it. */
  rejected(): readonly { at: number; reason: string; version: number }[] {
    return this.refusals;
  }

  publish(incoming: PolicyDocument, now: number): PolicyDecision {
    const decision = accept(this.current, incoming);
    if (decision.applied) {
      this.current = decision.policy;
      return decision;
    }

    const version =
      typeof (incoming as Partial<PolicyDocument>).version === 'number' ? incoming.version : -1;
    this.refusals.push({ at: now, reason: decision.reason, version });
    if (this.refusals.length > 100) this.refusals.shift();
    return decision;
  }
}
