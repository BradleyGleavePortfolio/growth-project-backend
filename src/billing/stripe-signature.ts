import { createHmac, timingSafeEqual } from 'crypto';

/**
 * WHY A CUSTOM HMAC VERIFIER INSTEAD OF stripe.webhooks.constructEvent
 * -----------------------------------------------------------------------
 * The Stripe Node SDK's `stripe.webhooks.constructEvent` is perfectly valid
 * for single-secret deployments, but it does not support verifying against
 * more than one secret simultaneously. We need that capability for
 * zero-downtime webhook secret rotation:
 *
 *   During a rotation, Stripe continues signing with the OLD secret while
 *   we also configure the NEW secret. Both `STRIPE_WEBHOOK_SECRET` (the
 *   current/old secret) and `STRIPE_WEBHOOK_SECRET_NEXT` (the incoming new
 *   secret) are read from the environment. A signature is accepted if it
 *   verifies under ANY of the configured secrets, so we can deploy the new
 *   secret, let Stripe complete the rotation, then remove the old one —
 *   without any downtime or rejected events.
 *
 * ALGORITHM FIDELITY
 * ------------------
 * The implementation exactly matches Stripe's documented verification
 * algorithm (https://docs.stripe.com/webhooks#verify-manually):
 *
 *   1. Extract `t` (timestamp) and `v1` (hex-encoded HMAC digest) from the
 *      `Stripe-Signature` header: "t=<unix_ts>,v1=<hex_sig>[,v0=...]"
 *   2. Build the signed payload string: "<unix_ts>.<raw_request_body>"
 *   3. Compute HMAC-SHA256 of the signed payload, keyed by the webhook
 *      secret.
 *   4. Compare the expected digest to every `v1` value in the header using
 *      `timingSafeEqual` (Node crypto) to prevent timing-based side-channel
 *      attacks.
 *   5. Reject if the absolute difference between `t` and `now()` exceeds the
 *      tolerance (default 300 s — Stripe's own default).
 *
 * EMPTY-SECRET SAFETY
 * -------------------
 * `resolveStripeWebhookSecrets` trims and filters empty strings from env
 * vars so an unset or blank `STRIPE_WEBHOOK_SECRET_NEXT` cannot accidentally
 * cause every signature to verify (an empty-string HMAC key is never used).
 */

// Verifies a Stripe webhook signature header without pulling in the Stripe
// SDK. Stripe documents the algorithm at https://docs.stripe.com/webhooks#verify-manually
//
// Header shape: "t=<unix_ts>,v1=<hex_signature>[,v0=<deprecated>]"
// Signed payload: "<unix_ts>.<raw_request_body>"
// MAC: HMAC-SHA256 keyed by the webhook secret.
//
// Tolerance defaults to 300 seconds — matches Stripe's documented default.
//
// We avoid the Stripe SDK on purpose: tests must not require a real Stripe
// account, the webhook handler is the only Stripe-touching code path that
// receives untrusted input, and the algorithm is small enough to audit by
// hand.

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

// Accepts either a single `secret` (back-compat with existing call sites and
// tests) or an array via `secrets` for zero-downtime rotation. During a
// rotation window both the old and new endpoint signing secrets are listed;
// a signature that verifies against ANY secret is accepted. Stripe's
// recommended rotation procedure (add a new signing secret, deploy with
// both, swap dashboard to new, drop old) maps directly onto this contract.
export function verifyStripeSignature(opts: {
  payload: string;
  signatureHeader: string;
  secret?: string;
  secrets?: ReadonlyArray<string>;
  toleranceSeconds?: number;
  now?: () => number;
}): void {
  const { payload, signatureHeader } = opts;
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  if (!signatureHeader) throw new StripeSignatureError('Missing signature header');

  // Normalize: merge single + plural inputs into one ordered, de-duplicated
  // list. Empty strings are dropped so a half-rotated env (secrets=[real, ''])
  // doesn't accidentally accept all signatures via the empty-secret HMAC.
  const candidateSecrets = [
    ...(opts.secret ? [opts.secret] : []),
    ...(opts.secrets ?? []),
  ]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  // Preserve first-seen order while de-duplicating.
  const uniqueSecrets = Array.from(new Set(candidateSecrets));
  if (uniqueSecrets.length === 0) {
    throw new StripeSignatureError('Webhook secret not configured');
  }

  const parts: Record<string, string[]> = {};
  for (const segment of signatureHeader.split(',')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const k = segment.slice(0, eq).trim();
    const v = segment.slice(eq + 1).trim();
    (parts[k] ||= []).push(v);
  }
  const tStr = parts['t']?.[0];
  const v1List = parts['v1'] ?? [];
  if (!tStr || v1List.length === 0) {
    throw new StripeSignatureError('Malformed signature header');
  }
  const t = Number(tStr);
  if (!Number.isFinite(t)) throw new StripeSignatureError('Invalid timestamp');
  if (Math.abs(now() - t) > tolerance) {
    throw new StripeSignatureError('Signature timestamp outside tolerance');
  }

  const signedPayload = `${tStr}.${payload}`;

  // Try every configured secret against every v1 in the header. Both lists
  // are normally length-1; size two only during a rotation. Constant-time
  // compare per (secret, candidate) pair — total work is O(n*m) HMACs where
  // n is the number of configured secrets (<=2 in practice) and m is the
  // number of v1 entries (1 in practice).
  for (const secret of uniqueSecrets) {
    const expected = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    for (const v1 of v1List) {
      let candidateBuf: Buffer;
      try {
        candidateBuf = Buffer.from(v1, 'hex');
      } catch {
        continue;
      }
      if (
        candidateBuf.length === expectedBuf.length &&
        timingSafeEqual(candidateBuf, expectedBuf)
      ) {
        return;
      }
    }
  }
  throw new StripeSignatureError('No matching signature');
}

// Resolve the configured webhook secrets from env. Supports two shapes:
//   - STRIPE_WEBHOOK_SECRET (single — legacy / steady state)
//   - STRIPE_WEBHOOK_SECRET_NEXT (the incoming secret during rotation)
// Both may be set during a rotation window; either alone is also valid.
// Returns the ordered, de-duplicated, trim-cleaned list. Empty strings are
// stripped so a half-set env var does not bypass HMAC verification.
export function resolveStripeWebhookSecrets(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_NEXT]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0);
  return Array.from(new Set(candidates));
}

// Helper used by tests: produce a valid header for a payload. Not exported
// from the module index — it lives next to verification so the contract
// stays in one file.
export function signStripePayload(opts: {
  payload: string;
  secret: string;
  timestamp?: number;
}): string {
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret)
    .update(`${t}.${opts.payload}`, 'utf8')
    .digest('hex');
  return `t=${t},v1=${sig}`;
}
