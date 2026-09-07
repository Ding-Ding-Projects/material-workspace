/**
 * Data-loss prevention: finding things that should not leave.
 *
 * The honest framing first, because a scanner that oversells itself is worse
 * than none: THIS FINDS PATTERNS, NOT SECRETS. It cannot tell a real card
 * number from a test one, or a private key from a paragraph about private
 * keys. It is a prompt to look, not a verdict.
 *
 * Two design rules follow from that:
 *
 *   - IT NEVER BLOCKS SILENTLY. Every finding is shown with the exact text it
 *     matched and where, so a person can decide. A scanner that quietly
 *     refuses an export teaches people to route around it.
 *   - IT NEVER LOGS WHAT IT FOUND. The whole point is that the matched text is
 *     sensitive; writing it into a log moves the secret somewhere with weaker
 *     protection than the document it came from. Findings carry a REDACTED
 *     preview, and the full match never leaves the process.
 */

export type FindingKind =
  | 'card'
  | 'iban'
  | 'privateKey'
  | 'apiToken'
  | 'password'
  | 'email'
  | 'hkid'
  | 'nationalInsurance';

export interface Finding {
  readonly kind: FindingKind;
  readonly label: string;
  /** Character offset in the scanned text. */
  readonly at: number;
  /** Never the full match. See the note at the top of this file. */
  readonly preview: string;
  readonly confidence: 'high' | 'medium' | 'low';
  /** Why this might be a false positive, stated with the finding. */
  readonly caveat?: string;
}

interface Rule {
  readonly kind: FindingKind;
  readonly label: string;
  readonly pattern: RegExp;
  readonly confidence: Finding['confidence'];
  readonly caveat?: string;
  /** An extra check beyond the pattern, such as a checksum. */
  readonly verify?: (match: string) => boolean;
}

/**
 * The Luhn check.
 *
 * Without it, any sixteen digits look like a card number — a phone number, an
 * order reference, a row of measurements. With it, the false-positive rate
 * falls by roughly ninety per cent, which is the difference between a scanner
 * people read and one they turn off.
 */
export function luhn(digits: string): boolean {
  const cleaned = digits.replace(/[^0-9]/g, '');
  if (cleaned.length < 13 || cleaned.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    let value = cleaned.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The Hong Kong identity-card check digit.
 *
 * Weighted from 9 downwards, modulo 11, with A representing 10. Included
 * because this project's user base is in Hong Kong and an unchecked pattern
 * for it matches an enormous amount of ordinary text.
 */
export function hkidCheckDigit(value: string): boolean {
  const match = /^([A-Z]{1,2})(\d{6})\(?([0-9A])\)?$/i.exec(value.trim());
  if (match === null) return false;

  const letters = (match[1] ?? '').toUpperCase();
  const digits = match[2] ?? '';
  const check = (match[3] ?? '').toUpperCase();

  // A single-letter prefix is treated as a space in the leading position.
  const padded = letters.length === 1 ? ' ' + letters : letters;

  let sum = 0;
  let weight = 9;
  for (const character of padded) {
    sum += (character === ' ' ? 36 : character.charCodeAt(0) - 55) * weight;
    weight -= 1;
  }
  for (const digit of digits) {
    sum += (digit.charCodeAt(0) - 48) * weight;
    weight -= 1;
  }

  const remainder = (11 - (sum % 11)) % 11;
  const expected = remainder === 10 ? 'A' : String(remainder);
  return expected === check;
}

const RULES: readonly Rule[] = [
  {
    kind: 'card',
    label: 'Payment card number',
    // Word boundaries, and separators, because real card numbers are written
    // in groups of four as often as not.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 'high',
    verify: luhn,
    caveat: 'Verified with the Luhn check, which a deliberate test number also passes.',
  },
  {
    kind: 'iban',
    label: 'Bank account (IBAN)',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    confidence: 'medium',
    caveat: 'The country and length are plausible; the checksum is not verified.',
  },
  {
    kind: 'privateKey',
    label: 'Private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    confidence: 'high',
    caveat: 'A document that merely quotes this header would also match.',
  },
  {
    kind: 'apiToken',
    label: 'API token',
    // Long high-entropy runs with a recognisable prefix. A bare long string is
    // deliberately NOT matched: base64 data, hashes and identifiers all look
    // the same, and matching them makes the scanner useless.
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    confidence: 'high',
  },
  {
    kind: 'password',
    label: 'Password written down',
    pattern: /\b(?:password|passwd|pwd|passphrase)\s*[:=]\s*\S{4,}/gi,
    confidence: 'medium',
    caveat: 'Documentation that shows an example password also matches.',
  },
  {
    kind: 'hkid',
    label: 'Hong Kong identity card',
    pattern: /\b[A-Z]{1,2}\d{6}\(?[0-9A]\)?/gi,
    confidence: 'high',
    verify: hkidCheckDigit,
    caveat: 'The check digit is verified, so an invented number is unlikely to match.',
  },
  {
    kind: 'nationalInsurance',
    label: 'UK National Insurance number',
    pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi,
    confidence: 'medium',
  },
  {
    kind: 'email',
    label: 'Email address',
    pattern: /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi,
    confidence: 'low',
    caveat: 'Ordinary correspondence contains these. Listed for completeness, not as a warning.',
  },
];

/**
 * A preview that does not disclose the match.
 *
 * First two and last two characters, with the middle replaced. Enough for a
 * person to recognise which occurrence is meant; not enough to reconstruct it.
 */
export function preview(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 6) return '·'.repeat(trimmed.length);
  return trimmed.slice(0, 2) + '·'.repeat(Math.min(trimmed.length - 4, 12)) + trimmed.slice(-2);
}

export interface ScanOptions {
  /** Kinds to ignore. Recorded by the caller so the choice is auditable. */
  readonly ignoring?: readonly FindingKind[];
  /** Bounded, so a huge document cannot stall the process. */
  readonly maxFindings?: number;
}

export function scan(text: string, options: ScanOptions = {}): Finding[] {
  const ignoring = new Set(options.ignoring ?? []);
  const maxFindings = options.maxFindings ?? 500;
  const findings: Finding[] = [];

  for (const rule of RULES) {
    if (ignoring.has(rule.kind)) continue;

    // A fresh regular expression per scan. A shared global one carries
    // lastIndex between calls, so a second scan of the same text silently
    // starts partway through and finds less.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);

    for (const match of text.matchAll(pattern)) {
      if (findings.length >= maxFindings) return findings;
      const value = match[0];
      if (rule.verify !== undefined && !rule.verify(value)) continue;

      findings.push({
        kind: rule.kind,
        label: rule.label,
        at: match.index ?? 0,
        preview: preview(value),
        confidence: rule.confidence,
        ...(rule.caveat === undefined ? {} : { caveat: rule.caveat }),
      });
    }
  }

  return findings.sort((a, b) => a.at - b.at);
}

export interface ScanSummary {
  readonly total: number;
  readonly byKind: readonly { kind: FindingKind; label: string; count: number }[];
  readonly highest: Finding['confidence'] | 'none';
}

export function summarise(findings: readonly Finding[]): ScanSummary {
  const counts = new Map<FindingKind, { label: string; count: number }>();
  for (const finding of findings) {
    const existing = counts.get(finding.kind);
    if (existing === undefined) counts.set(finding.kind, { label: finding.label, count: 1 });
    else existing.count += 1;
  }

  const order: Finding['confidence'][] = ['low', 'medium', 'high'];
  let highest: Finding['confidence'] | 'none' = 'none';
  for (const finding of findings) {
    if (highest === 'none' || order.indexOf(finding.confidence) > order.indexOf(highest)) {
      highest = finding.confidence;
    }
  }

  return {
    total: findings.length,
    byKind: [...counts.entries()]
      .map(([kind, entry]) => ({ kind, label: entry.label, count: entry.count }))
      .sort((a, b) => b.count - a.count),
    highest,
  };
}
