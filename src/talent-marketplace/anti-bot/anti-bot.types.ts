/**
 * TM-6 — Anti-bot / abuse gate: provider-agnostic contract.
 *
 * Protects the talent-marketplace apply + account-create + listing-publish
 * surfaces (the product's highest-abuse paths). This file is the contract only;
 * the provider is pluggable
 * behind {@link AntiBotProvider} so a Turnstile/hCaptcha-class vendor COULD slot
 * in later, but the shipped default is in-house (operator ruling: no paid
 * vendor). GATE LAYER only — never touches Application/Applicant service bodies
 * (TM-5 owns those); TM-5 attaches {@link AntiBotProvider} via the guard.
 */

/** Which abuse-prone surface is being gated. Drives per-surface limits. */
export const ANTI_BOT_SURFACES = {
  Apply: 'apply',
  AccountCreate: 'account-create',
  ListingPublish: 'listing-publish',
} as const;

export type AntiBotSurface =
  (typeof ANTI_BOT_SURFACES)[keyof typeof ANTI_BOT_SURFACES];

/**
 * - `allow`     — proceed untouched.
 * - `challenge` — suspicious; client must complete a challenge (in-house:
 *                 signed proof-of-work / future: a vendor widget). Surfaced as 428.
 * - `deny`      — conclusively over a hard limit; 429 (rate) / 403 (identity).
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
 * Normalized, PII-light signal extracted by the guard and handed to the
 * provider — the provider never sees the raw request, which is what lets a
 * vendor adapter drop in without touching the guard. `identityKey` is hashed
 * before persistence; it is NEVER stored in the clear.
 */
export interface AntiBotSignal {
  surface: AntiBotSurface;
  /** Best-effort source IP (Fly-Client-IP → XFF → socket). May be empty. */
  ip: string;
  userAgent: string;
  /** Stable identity hint (email / user id). Hashed before persistence. */
  identityKey: string;
  /** Optional client-asserted device fingerprint (hashed before storage). */
  deviceFingerprint?: string;
  userId?: string;
}

export interface AntiBotVerdict {
  decision: AntiBotDecision;
  reason?: AntiBotReason;
  /** Set on challenge/deny. */
  retryAfterSeconds?: number;
}

/**
 * Pluggable abuse-gate provider. The in-house implementation is the default;
 * a vendor adapter implements the same interface and is selected by env in the
 * module with no change to the guard or TM-5. Implementations MUST fail open
 * (return `allow`) on internal/storage error.
 */
export interface AntiBotProvider {
  /** Stable provider id for logs/metrics (e.g. `in-house`, `turnstile`). */
  readonly id: string;
  evaluate(signal: AntiBotSignal): Promise<AntiBotVerdict>;
}

/** DI token for the active {@link AntiBotProvider}. */
export const ANTI_BOT_PROVIDER = Symbol('ANTI_BOT_PROVIDER');
