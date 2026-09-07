/**
 * Classification labels.
 *
 * A label is a claim about how sensitive a document is, and the whole value of
 * the system rests on three rules that are easy to state and easy to get
 * wrong:
 *
 *   - A LABEL ONLY EVER GOES UP WITHOUT AUTHORITY. Anybody may mark a document
 *     MORE sensitive; lowering it is a deliberate act that has to be recorded
 *     and justified. A system that lets a label drift downwards silently is a
 *     system where the label means nothing.
 *   - A DERIVED DOCUMENT INHERITS THE HIGHEST LABEL OF ITS SOURCES. Pasting
 *     from a restricted document into an unlabelled one and keeping the
 *     unlabelled label is how classified material escapes, and it is the
 *     single most common way it happens in practice.
 *   - AN UNLABELLED DOCUMENT IS NOT PUBLIC. It is UNKNOWN, which is a
 *     different fact and must be treated as at least the organisation's
 *     default rather than as the least sensitive option.
 */

export type Sensitivity = 'unknown' | 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * The order. Higher is more sensitive.
 *
 * `unknown` sits ABOVE public deliberately: an unlabelled document is one
 * nobody has assessed, and treating it as the least sensitive option is how a
 * gap in process becomes a disclosure.
 */
const RANK: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  unknown: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
};

export interface Label {
  readonly sensitivity: Sensitivity;
  /** Who applied it. Never inferred. */
  readonly by: string;
  /** ISO 8601, UTC. */
  readonly at: string;
  /** Required when the label is being LOWERED. */
  readonly justification?: string;
  /** Labels this one was derived from, when it was inherited. */
  readonly derivedFrom?: readonly string[];
}

export interface LabelChangeRequest {
  readonly from: Label | undefined;
  readonly to: Sensitivity;
  readonly by: string;
  readonly at: string;
  readonly justification?: string;
  /** True when the actor holds the authority to lower a label. */
  readonly mayLower?: boolean;
}

export type LabelDecision =
  | { readonly allowed: true; readonly label: Label; readonly raised: boolean }
  | { readonly allowed: false; readonly reason: string };

export function rankOf(sensitivity: Sensitivity): number {
  return RANK[sensitivity];
}

export function isMoreSensitive(a: Sensitivity, b: Sensitivity): boolean {
  return RANK[a] > RANK[b];
}

/** The highest of a set. Used when a document is derived from several. */
export function highest(labels: readonly Sensitivity[]): Sensitivity {
  if (labels.length === 0) return 'unknown';
  return labels.reduce((worst, candidate) =>
    RANK[candidate] > RANK[worst] ? candidate : worst,
  );
}

/**
 * Decide a label change.
 *
 * Raising is always allowed and needs no justification: erring towards more
 * protection is never the dangerous direction. Lowering needs BOTH the
 * authority and a written reason, and having one without the other is refused
 * with the specific thing that is missing rather than a generic denial.
 */
export function decideLabelChange(request: LabelChangeRequest): LabelDecision {
  const current = request.from?.sensitivity ?? 'unknown';
  const target = request.to;

  if (RANK[target] === RANK[current]) {
    return {
      allowed: true,
      raised: false,
      label: { sensitivity: target, by: request.by, at: request.at },
    };
  }

  if (RANK[target] > RANK[current]) {
    return {
      allowed: true,
      raised: true,
      label: { sensitivity: target, by: request.by, at: request.at },
    };
  }

  if (request.mayLower !== true) {
    return {
      allowed: false,
      reason:
        'Lowering a label from ' +
        current +
        ' to ' +
        target +
        ' needs authority that ' +
        request.by +
        ' does not hold.',
    };
  }

  const justification = request.justification?.trim() ?? '';
  if (justification.length < 10) {
    // A reason of three characters is not a reason. The bound is arbitrary and
    // stated rather than hidden, so it can be argued with.
    return {
      allowed: false,
      reason:
        'Lowering a label needs a written justification of at least ten characters. ' +
        'It is recorded in the audit log and read by whoever reviews it later.',
    };
  }

  return {
    allowed: true,
    raised: false,
    label: { sensitivity: target, by: request.by, at: request.at, justification },
  };
}

/**
 * The label a derived document must carry.
 *
 * Inheriting the HIGHEST of its sources, always. Pasting from a restricted
 * document into an unlabelled one and keeping the unlabelled label is the
 * single most common way classified material escapes.
 */
export function inheritLabel(
  sources: readonly Label[],
  by: string,
  at: string,
): Label {
  const sensitivity = highest(sources.map((label) => label.sensitivity));
  return {
    sensitivity,
    by,
    at,
    derivedFrom: sources.map((label) => label.sensitivity),
  };
}

export interface ExportTarget {
  readonly description: string;
  /** The highest sensitivity this destination may receive. */
  readonly maximum: Sensitivity;
  /** True when the destination leaves the organisation. */
  readonly external: boolean;
}

export type ExportDecision =
  | { readonly allowed: true; readonly warnings: readonly string[] }
  | { readonly allowed: false; readonly reason: string };

/**
 * May this document go to this destination?
 *
 * Refused rather than warned when the label exceeds what the destination may
 * receive. A warning that can be clicked past is a warning that will be, and
 * the person clicking past it is usually in a hurry for exactly the reason
 * that makes it a bad idea.
 */
export function decideExport(label: Label | undefined, target: ExportTarget): ExportDecision {
  const sensitivity = label?.sensitivity ?? 'unknown';

  if (RANK[sensitivity] > RANK[target.maximum]) {
    return {
      allowed: false,
      reason:
        'This document is marked ' +
        sensitivity +
        '. ' +
        target.description +
        ' may receive at most ' +
        target.maximum +
        '.',
    };
  }

  const warnings: string[] = [];
  if (sensitivity === 'unknown') {
    // Not a refusal: an unassessed document is a process gap rather than a
    // known breach. But it is said out loud, because "nobody looked" is
    // exactly what an unlabelled document means.
    warnings.push(
      'This document has no classification. Nobody has assessed it, which is not the same as it being public.',
    );
  }
  if (target.external && RANK[sensitivity] >= RANK.internal) {
    warnings.push(
      'This destination is outside the organisation, and the document is marked ' +
        sensitivity +
        '.',
    );
  }

  return { allowed: true, warnings };
}

/** A short, plain description for a label, shown wherever one appears. */
export function describeSensitivity(sensitivity: Sensitivity): string {
  switch (sensitivity) {
    case 'public':
      return 'May be shared with anybody.';
    case 'internal':
      return 'For people inside the organisation.';
    case 'confidential':
      return 'For named people only. Do not forward.';
    case 'restricted':
      return 'Highest protection. Sharing needs explicit approval each time.';
    default:
      return 'Not assessed. This is not the same as public.';
  }
}
