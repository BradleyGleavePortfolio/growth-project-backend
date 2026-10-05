// B-RECUR-BE (agent 114) — allowlisted error details.
//
// HttpExceptionFilter normally sends only the fixed envelope (statusCode,
// code, message, error, timestamp, path, request_id). A few coded 4xx answers
// carry facts the app needs to show the next step without another round
// trip (the current price after PACKAGE_PRICE_CHANGED, the plan that already
// exists after SUBSCRIPTION_ALREADY_ACTIVE). Those facts pass through ONLY
// when the exception's own `code` is listed here, ONLY for the listed field
// names, and ONLY when each value has the listed shape. Anything else on the
// exception body (Stripe codes, ids, internals) is dropped exactly as before.
// Envelope keys can never be overridden by a detail.

type DetailCheck = (value: unknown) => boolean;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const cents: DetailCheck = (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000_000;
const count: DetailCheck = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 52;
const currency: DetailCheck = (v) => typeof v === 'string' && /^[a-z]{3}$/i.test(v);
const bool: DetailCheck = (v) => typeof v === 'boolean';
const uuid: DetailCheck = (v) => typeof v === 'string' && UUID_RE.test(v);
const isoOrNull: DetailCheck = (v) => v === null || (typeof v === 'string' && ISO_RE.test(v));
const oneOf =
  (...allowed: string[]): DetailCheck =>
  (v) =>
    typeof v === 'string' && allowed.includes(v);

/** code -> field name -> shape check. Extend only with client-safe facts. */
export const ERROR_DETAIL_ALLOWLIST: Readonly<Record<string, Readonly<Record<string, DetailCheck>>>> =
  {
    PACKAGE_PRICE_CHANGED: {
      amount_cents: cents,
      one_time_cents: cents,
      first_charge_cents: cents,
      currency,
      interval: oneOf('week', 'month', 'year'),
      interval_count: count,
    },
    // B-RECUR-3 (B-654-7) — why the attempt behind this key ended.
    SUBSCRIPTION_ATTEMPT_EXPIRED: {
      reason: oneOf('timed_out', 'terms_changed'),
    },
    SUBSCRIPTION_ALREADY_ACTIVE: {
      purchase_id: uuid,
      cancel_at_period_end: bool,
      current_period_end: isoOrNull,
    },
    PACKAGE_ALREADY_INCLUDED: {
      purchase_id: uuid,
      included_by: oneOf('invite', 'free_claim', 'purchase'),
      access_expires_at: isoOrNull,
    },
    PACKAGE_COACH_NOT_CONNECTED: {
      reason: oneOf('no_coach', 'other_coach'),
    },
  };

const ENVELOPE_KEYS = new Set([
  'statusCode',
  'code',
  'message',
  'error',
  'timestamp',
  'path',
  'request_id',
]);

/**
 * The allowlisted details of a coded 4xx exception body, or an empty object.
 * Never throws; a value of the wrong shape is dropped, not coerced.
 */
export function pickErrorDetails(
  status: number,
  code: string | undefined,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!code || status < 400 || status >= 500) return {};
  const allowed = Object.prototype.hasOwnProperty.call(ERROR_DETAIL_ALLOWLIST, code)
    ? ERROR_DETAIL_ALLOWLIST[code]
    : undefined;
  if (!allowed) return {};
  const out: Record<string, unknown> = {};
  for (const [field, check] of Object.entries(allowed)) {
    if (ENVELOPE_KEYS.has(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (check(value)) out[field] = value;
  }
  return out;
}
