import { createHash, randomBytes } from 'crypto';

/**
 * PR-HK-1 — PKCE (Proof Key for Code Exchange, RFC 7636) helpers.
 *
 * PKCE hardens the OAuth authorization-code flow against authorization-code
 * interception (50-Failures #11 — auth flow integrity). Providers that
 * support it (Fitbit, and any modern OAuth2 provider) receive a
 * `code_challenge` on the authorization request and we present the matching
 * `code_verifier` on the token exchange. The verifier never leaves the
 * server (it is stored alongside the CSRF state in {@link OauthStateService})
 * and is single-use.
 *
 * This module is intentionally dependency-free (only Node `crypto`) so it can
 * be unit-tested with real values and reused by every connector PR without
 * importing Nest or provider SDKs.
 */

/**
 * RFC 7636 §4.1 — the `code_verifier` is a high-entropy cryptographic random
 * string using the unreserved characters `[A-Z] / [a-z] / [0-9] / "-" / "." /
 * "_" / "~"` with a minimum length of 43 characters and a maximum length of
 * 128 characters.
 *
 * base64url encoding of N raw bytes yields ceil(N * 4 / 3) characters (no
 * padding). 32 bytes → 43 chars, which is exactly the RFC minimum while
 * providing 256 bits of entropy. We expose the byte count so callers/tests
 * can reason about the resulting length, but default to the secure minimum.
 */
export const PKCE_VERIFIER_MIN_LENGTH = 43;
export const PKCE_VERIFIER_MAX_LENGTH = 128;

/** Default entropy for a generated verifier: 32 bytes → 43 base64url chars. */
const DEFAULT_VERIFIER_BYTES = 32;

/**
 * The RFC 7636 unreserved character set, anchored. Exported so tests assert
 * the exact contract rather than a hand-rolled approximation.
 */
export const PKCE_VERIFIER_CHARSET = /^[A-Za-z0-9\-._~]+$/;

/**
 * Encode a buffer as base64url (RFC 4648 §5): `+`→`-`, `/`→`_`, no `=`
 * padding. The resulting alphabet is a strict subset of the PKCE unreserved
 * set, so base64url output is always a valid `code_verifier`/`code_challenge`.
 */
function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a cryptographically random PKCE `code_verifier`.
 *
 * @param byteLength raw entropy in bytes (default 32 → 43 chars, the RFC
 *   minimum). Callers may request more entropy; the resulting string is
 *   clamped by the RFC max of 128 characters. The minimum is 32 bytes so the
 *   output never falls below the 43-char floor.
 * @returns a base64url string of length in [43, 128] matching
 *   {@link PKCE_VERIFIER_CHARSET}.
 */
export function generateVerifier(byteLength: number = DEFAULT_VERIFIER_BYTES): string {
  // 32 bytes → 43 chars (floor); 96 bytes → 128 chars (ceiling). Clamp the
  // byte request so the encoded length stays within RFC bounds regardless of
  // caller input.
  const clampedBytes = Math.min(Math.max(byteLength, 32), 96);
  const verifier = base64url(randomBytes(clampedBytes));
  // base64url of 96 bytes is exactly 128 chars; of 32 bytes exactly 43.
  // Guard the upper bound defensively in case of future encoding changes.
  return verifier.slice(0, PKCE_VERIFIER_MAX_LENGTH);
}

/**
 * Compute the PKCE `code_challenge` for the S256 method (RFC 7636 §4.2):
 * `BASE64URL(SHA256(ASCII(code_verifier)))`.
 *
 * Deterministic: a given verifier always yields the same challenge, which is
 * exactly what the provider re-derives on the token exchange. We always use
 * S256 (never the insecure `plain` method).
 *
 * @param verifier the `code_verifier` previously generated.
 * @returns the base64url-encoded SHA-256 digest (43 chars).
 */
export function generateChallenge(verifier: string): string {
  if (typeof verifier !== 'string' || verifier.length < PKCE_VERIFIER_MIN_LENGTH) {
    throw new Error(
      `PKCE verifier must be at least ${PKCE_VERIFIER_MIN_LENGTH} characters (RFC 7636 §4.1).`,
    );
  }
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** The PKCE challenge method we use everywhere. `plain` is never emitted. */
export const PKCE_CHALLENGE_METHOD = 'S256' as const;

/** A generated verifier + its derived S256 challenge, ready for an auth URL. */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: typeof PKCE_CHALLENGE_METHOD;
}

/** Convenience: generate a verifier and its matching S256 challenge in one call. */
export function generatePkcePair(): PkcePair {
  const verifier = generateVerifier();
  return {
    verifier,
    challenge: generateChallenge(verifier),
    method: PKCE_CHALLENGE_METHOD,
  };
}
