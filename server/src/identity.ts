/**
 * Who is connecting, and what an identity provider told us about them.
 *
 * Three separate things live here because they are three separate trust
 * boundaries, and conflating them is how an authorization hole opens:
 *
 *   - a SESSION TOKEN this server minted and can verify itself;
 *   - an ASSERTION from an external identity provider, mapped to a principal;
 *   - a SCIM record, which is a directory's statement about a person and
 *     carries no authentication weight at all.
 *
 * WHAT IS NOT BUILT, said here rather than discovered later: this does not
 * parse or verify a real signed SAML response. That needs XML canonicalisation
 * and XML digital signature verification, and a half-implementation of either
 * is worse than none, because it looks like verification and is not. What is
 * built is the mapping from an already-verified assertion's attributes onto a
 * principal, plus the session tokens that follow. A deployment therefore needs
 * a proxy that terminates SAML, and that requirement is documented rather than
 * papered over.
 */

import crypto from 'node:crypto';

export interface Principal {
  /** Stable across renames. What authorization is written against. */
  readonly subject: string;
  readonly displayName: string;
  readonly email: string;
  readonly groups: readonly string[];
}

export interface SessionToken {
  readonly principal: Principal;
  /** Millisecond clock reading after which the token is refused. */
  readonly expiresAt: number;
}

export type Verification =
  | { readonly ok: true; readonly token: SessionToken }
  | { readonly ok: false; readonly reason: string };

/**
 * Mint and verify session tokens.
 *
 * The secret never leaves the process: it is read from the environment at
 * start-up, is never logged, never returned by an endpoint, and never appears
 * in an error message. `describeSecret` below exists to make that testable
 * without ever exposing the value.
 */
export class Sessions {
  private readonly secret: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) {
      // Refused rather than padded. A short secret that is silently accepted
      // is a deployment that believes it is protected and is not.
      throw new Error('the session secret must be at least 32 characters');
    }
    this.secret = Buffer.from(secret, 'utf8');
  }

  /**
   * A stable, non-reversible fingerprint of the configured secret.
   *
   * Deliberately does not reveal the value, its length, or any prefix of it.
   * It exists so an operator can confirm two nodes were configured with the
   * SAME secret without either of them printing it.
   */
  describeSecret(): string {
    return crypto.createHmac('sha256', this.secret).update('fingerprint').digest('hex').slice(0, 12);
  }

  issue(principal: Principal, now: number, lifetime: number): string {
    const body = JSON.stringify({ principal, expiresAt: now + lifetime });
    const encoded = Buffer.from(body, 'utf8').toString('base64url');
    return encoded + '.' + this.sign(encoded);
  }

  verify(token: string, now: number): Verification {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return { ok: false, reason: 'malformed token' };

    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = this.sign(encoded);

    // Compared in constant time. A plain === leaks how much of the signature
    // matched through timing, which is enough to forge one a byte at a time.
    // The length check comes first because timingSafeEqual throws on a length
    // mismatch, and that throw would itself be the timing signal.
    if (signature.length !== expected.length) return { ok: false, reason: 'bad signature' };
    if (
      !crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
    ) {
      return { ok: false, reason: 'bad signature' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed token' };
    }

    const token_ = parsed as Partial<SessionToken>;
    if (
      typeof token_?.expiresAt !== 'number' ||
      token_.principal === undefined ||
      typeof token_.principal.subject !== 'string'
    ) {
      return { ok: false, reason: 'malformed token' };
    }

    // Checked AFTER the signature, so an expired token and a forged one are
    // indistinguishable to somebody probing with garbage.
    if (token_.expiresAt <= now) return { ok: false, reason: 'the session has expired' };

    return { ok: true, token: token_ as SessionToken };
  }

  private sign(encoded: string): string {
    return crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
  }
}

/** Which assertion attribute carries which field. Deployments differ. */
export interface AssertionMapping {
  readonly subject: string;
  readonly displayName: string;
  readonly email: string;
  readonly groups: string;
}

export const DEFAULT_MAPPING: AssertionMapping = {
  subject: 'urn:oid:0.9.2342.19200300.100.1.1',
  displayName: 'urn:oid:2.16.840.1.113730.3.1.241',
  email: 'urn:oid:0.9.2342.19200300.100.1.3',
  groups: 'urn:oid:1.3.6.1.4.1.5923.1.5.1.1',
};

export type MappingResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: string };

/**
 * Map an already-verified assertion's attributes onto a principal.
 *
 * Takes attributes, never a raw XML document, precisely so this cannot be
 * mistaken for signature verification. Whatever handed these attributes over
 * is responsible for having checked them.
 */
export function principalFromAssertion(
  attributes: Readonly<Record<string, readonly string[]>>,
  mapping: AssertionMapping = DEFAULT_MAPPING,
): MappingResult {
  const first = (name: string): string => attributes[name]?.[0] ?? '';

  const subject = first(mapping.subject);
  if (subject === '') {
    // Refused rather than falling back to the email address. An email is
    // reassignable, so a leaver's address given to a new starter would hand
    // them the leaver's documents.
    return { ok: false, reason: 'the assertion carried no stable subject' };
  }

  const email = first(mapping.email);
  const displayName = first(mapping.displayName);

  return {
    ok: true,
    principal: {
      subject,
      displayName: displayName === '' ? (email === '' ? subject : email) : displayName,
      email,
      groups: [...(attributes[mapping.groups] ?? [])],
    },
  };
}

/** The subset of a SCIM 2.0 user this server actually reads. */
export interface ScimUser {
  readonly id: string;
  readonly userName: string;
  readonly displayName?: string;
  readonly active?: boolean;
  readonly emails?: readonly { readonly value: string; readonly primary?: boolean }[];
  readonly groups?: readonly { readonly value: string; readonly display?: string }[];
}

export type ScimResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: string };

/**
 * Turn a SCIM user into a principal.
 *
 * A deprovisioned user is REFUSED here rather than mapped and filtered later.
 * Offboarding is the single thing a directory integration exists for, and a
 * pipeline where `active: false` is merely a field somebody downstream might
 * check is a pipeline that keeps a leaver's access.
 */
export function principalFromScim(user: ScimUser): ScimResult {
  if (user.id === undefined || user.id === '') {
    return { ok: false, reason: 'the SCIM record carried no id' };
  }
  if (user.active === false) {
    return { ok: false, reason: 'that account is deprovisioned' };
  }

  const primary = user.emails?.find((entry) => entry.primary === true) ?? user.emails?.[0];

  return {
    ok: true,
    principal: {
      subject: user.id,
      displayName: user.displayName ?? user.userName,
      email: primary?.value ?? '',
      groups: (user.groups ?? []).map((group) => group.display ?? group.value),
    },
  };
}
