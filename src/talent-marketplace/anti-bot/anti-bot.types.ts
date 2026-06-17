/**
 * TM-6 — Anti-bot / abuse gate: provider-agnostic contract.
 *
 * The talent-marketplace apply + account-create surface is the single
 * highest-abuse path in the product: it is unauthenticated-adjacent
 * (a brand-new account applies the moment it is created), it writes PII
 * (Applicant / Application), and it is the obvious target for credential
 * farms, scripted application spam, and duplicate-identity sock-puppets.
 *
 * This file defines ONLY the contract. The provider is pluggable behind
 * {@link AntiBotProvider} so a Turnstile/hCaptcha-class vendor COULD slot
 * in later, but the shipped default is the in-house implementation
 * (operator ruling: build in-house, no paid vendor). See
 * `in-house-anti-bot.provider.ts` for the default.
 *
 * The gate is a GATE LAYER only — it never touches Application / Applicant
 * service bodies (TM-5 owns those). It exposes an {@link AntiBotGuard}
 * that TM-5 attaches to the apply / account-create routes.
 */

/** Which abuse-prone surface is being gated. Drives per-surface limits. */
export const ANTI_BOT_SURFACES = {
  /** POST apply-to-listing (TM-5). Writes Application PII. */
  Apply: 'apply',
  /** Pre-coach account creation that fronts the apply flow. */
  AccountCreate: 'account-create',
} as const;

export type AntiBotSurface =
  (typeof ANTI_BOT_SURFACES)[keyof typeof ANTI_BOT_SURFACES];

/**
 * Outcome of an abuse evaluation.
 *
 * - `allow`     — request proceeds untouched.
 * - `challenge` — request is suspicious but not conclusively abusive;
 *                 the caller must complete a challenge (in-house: a signed
 *                 proof-of-work / future: a Turnstile widget) before the
 *                 protected handler runs. The guard surfaces this as a
 *                 structured 428 so TM-5's client can render the challenge.
 * - `deny`      — request is conclusively over a hard limit; blocked with a
 *                 structured 429 (rate) or 403 (identity) and a Retry-After.
 */
export type AntiBotDecision = 'allow' | 'challenge' | 'deny';

/** Why a request was challenged or denied — stable codes for the client. */
export const ANTI_BOT_REASONS = {
  RateExceeded: 'rate_exceeded',
  VelocityAnomaly: 'velocity_anomaly',
  DuplicateDevice: 'duplicate_device',
  DuplicateIdentity: 'duplicate_identity',
} as const;

export type AntiBotReason =
  (typeof ANTI_BOT_REASONS)[keyof typeof ANTI_BOT_REASONS];

/**
 * Normalized, PII-light signal extracted from the inbound request by the
 * guard and handed to the provider. The provider must never receive the
 * raw Express request — keeping the contract transport-agnostic is what
 * lets a vendor adapter be dropped in without touching the guard.
 *
 * `identityKey` is a caller-supplied stable identity hint (e.g. a
 * normalized email or pre-coach user id) the provider hashes before
 * persistence — it is NEVER stored in the clear.
 */
export interface AntiBotSignal {
  surface: AntiBotSurface;
  /** Best-effort source IP (Fly-Client-IP → XFF → socket). May be empty. */
  ip: string;
  /** Raw User-Agent header, used as a weak device-fingerprint component. */
  userAgent: string;
  /** Stable identity hint (email / user id). Hashed before persistence. */
  identityKey: string;
  /** Optional client-asserted device fingerprint (hashed before storage). */
  deviceFingerprint?: string;
  /** Authenticated user id, when the surface runs post-auth. */
  userId?: string;
}

/** A provider verdict. `retryAfterSeconds` is set on challenge/deny. */
export interface AntiBotVerdict {
  decision: AntiBotDecision;
  reason?: AntiBotReason;
  retryAfterSeconds?: number;
}

/**
 * Pluggable abuse-gate provider. The in-house implementation is the
 * shipped default; a Turnstile/hCaptcha-class adapter implements the same
 * interface and is selected by `ANTI_BOT_PROVIDER` env without any change
 * to the guard or to TM-5.
 */
export interface AntiBotProvider {
  /** Stable provider id for logs/metrics (e.g. `in-house`, `turnstile`). */
  readonly id: string;
  /**
   * Evaluate a normalized signal and return a verdict. Implementations MUST
   * fail open (return `allow`) on internal/storage error — the gate is
   * defense-in-depth, never the sole control, and an infra hiccup must not
   * brick the apply flow (mirrors the throttler fail-open policy).
   */
  evaluate(signal: AntiBotSignal): Promise<AntiBotVerdict>;
}

/** DI token for the active {@link AntiBotProvider}. */
export const ANTI_BOT_PROVIDER = Symbol('ANTI_BOT_PROVIDER');
