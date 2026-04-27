import { createHmac, timingSafeEqual } from 'crypto';

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

export function verifyStripeSignature(opts: {
  payload: string;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
  now?: () => number;
}): void {
  const { payload, signatureHeader, secret } = opts;
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  if (!signatureHeader) throw new StripeSignatureError('Missing signature header');
  if (!secret) throw new StripeSignatureError('Webhook secret not configured');

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
  throw new StripeSignatureError('No matching signature');
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
