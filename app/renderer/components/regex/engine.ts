/**
 * What the regular-expression engine underneath this builder can actually do.
 *
 * The capability matrix is DETECTED at run time rather than hard-coded, because
 * a hard-coded list is a claim about a JavaScript version, and this application
 * runs on whatever Chromium the installed build carries. A builder that offers a
 * construct the engine does not support produces a pattern that throws when the
 * user tries it, which is worse than not offering it.
 *
 * Unsupported constructs stay VISIBLE with an exact explanation. Hiding them
 * makes the builder look simpler and leaves the user wondering why a pattern
 * they know works elsewhere cannot be built here.
 */

export interface Capability {
  id: string;
  label: string;
  /** A pattern that compiles only when the construct is supported. */
  probe: string;
  flags?: string;
  supported: boolean;
  note: string;
}

function probe(pattern: string, flags = ''): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

const DEFINITIONS: Omit<Capability, 'supported'>[] = [
  {
    id: 'named-groups',
    label: 'Named capture groups',
    probe: '(?<year>\\d{4})',
    note: 'Capture by name rather than by number, and refer back with \\k<name>.',
  },
  {
    id: 'lookbehind',
    label: 'Lookbehind',
    probe: '(?<=x)y',
    note: 'Match only when something precedes the position, without consuming it.',
  },
  {
    id: 'negative-lookbehind',
    label: 'Negative lookbehind',
    probe: '(?<!x)y',
    note: 'Match only when something does NOT precede the position.',
  },
  {
    id: 'unicode-property',
    label: 'Unicode property escapes',
    probe: '\\p{Letter}',
    flags: 'u',
    note: 'Match by Unicode property, such as \\p{Letter} or \\p{Script=Han}. Requires the u flag.',
  },
  {
    id: 'sticky',
    label: 'Sticky matching',
    probe: 'a',
    flags: 'y',
    note: 'Anchor each attempt at lastIndex rather than searching forward.',
  },
  {
    id: 'dot-all',
    label: 'Dot matches newline',
    probe: 'a.b',
    flags: 's',
    note: 'With the s flag, the dot also matches a line break.',
  },
  {
    id: 'unicode-sets',
    label: 'Unicode sets and set operations',
    probe: '[\\p{Letter}--[aeiou]]',
    flags: 'v',
    note: 'Set intersection and subtraction inside a character class. Requires the v flag.',
  },
  {
    id: 'match-indices',
    label: 'Match indices',
    probe: 'a',
    flags: 'd',
    note: 'With the d flag, each match reports the start and end offset of every group.',
  },
  {
    id: 'modifier-groups',
    label: 'Inline modifier groups',
    probe: '(?i:abc)',
    note: 'Apply a flag to part of a pattern, as in (?i:abc).',
  },
];

/**
 * Constructs this engine genuinely does not have. Listed rather than omitted,
 * because a user who knows them from another engine will look for them, and an
 * explanation is more useful than a blank.
 */
const KNOWN_ABSENT: Capability[] = [
  {
    id: 'atomic-groups',
    label: 'Atomic groups',
    probe: '(?>abc)',
    supported: false,
    note: 'Not available in this engine. A lookahead wrapped around a capture — (?=(abc))\\1 — achieves the same no-backtracking effect.',
  },
  {
    id: 'possessive',
    label: 'Possessive quantifiers',
    probe: 'a++',
    supported: false,
    note: 'Not available in this engine. Use the atomic-group workaround above where backtracking must be prevented.',
  },
  {
    id: 'recursion',
    label: 'Recursion and subroutine calls',
    probe: '(?R)',
    supported: false,
    note: 'Not available in this engine. Balanced or nested structures need a real parser rather than a pattern.',
  },
  {
    id: 'conditionals',
    label: 'Conditionals',
    probe: '(?(1)a|b)',
    supported: false,
    note: 'Not available in this engine. Alternation with lookahead can express many of the same intents.',
  },
];

let cached: Capability[] | null = null;

export function capabilities(): Capability[] {
  if (cached) return cached;
  const detected = DEFINITIONS.map((definition) => ({
    ...definition,
    supported: probe(definition.probe, definition.flags ?? ''),
  }));
  cached = [...detected, ...KNOWN_ABSENT];
  return cached;
}

export interface EngineIdentity {
  name: string;
  dialect: string;
  /** Supported flags, detected rather than assumed. */
  flags: { flag: string; label: string; supported: boolean }[];
}

const FLAG_LABELS: Record<string, string> = {
  d: 'Report match indices',
  g: 'Find every match, not just the first',
  i: 'Ignore case',
  m: 'Anchors match at every line',
  s: 'Dot matches a line break',
  u: 'Unicode mode',
  v: 'Unicode sets mode',
  y: 'Sticky: anchor at lastIndex',
};

export function engineIdentity(): EngineIdentity {
  const flags = Object.entries(FLAG_LABELS).map(([flag, label]) => ({
    flag,
    label,
    supported: probe('a', flag),
  }));
  return {
    name: 'ECMAScript regular expressions',
    dialect: 'The engine built into this application runtime, used exactly as-is.',
    flags,
  };
}

/**
 * Flags that cannot be combined. Reported rather than silently dropped: u and v
 * are mutually exclusive, and a builder that quietly removes one produces a
 * pattern that behaves differently from the one the user asked for.
 */
export function flagConflicts(flags: string): string[] {
  const conflicts: string[] = [];
  if (flags.includes('u') && flags.includes('v')) {
    conflicts.push('The u and v flags cannot both be set. v is the newer superset of u.');
  }
  return conflicts;
}
