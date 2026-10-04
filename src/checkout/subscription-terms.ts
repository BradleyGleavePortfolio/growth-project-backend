// B-RECUR-3 (agent 115) — the terms one native subscription attempt is bound to.
//
// B-654-5 / B-654-7: an attempt (one ClientPurchase row, one client
// Idempotency-Key, one Stripe Idempotency-Key) is pinned to the exact Stripe
// request it sends and to the money terms the client is shown. The snapshot
// is written on the reservation BEFORE the first Subscription create, so:
//   * a retry after an uncertain failure resends the IDENTICAL request under
//     the same Stripe Idempotency-Key (Stripe rejects a retained key whose
//     parameters differ), and
//   * a same-key replay always answers the terms of the subscription it hands
//     back, never today's package terms relabelled onto an old intent.
// The snapshot holds Stripe price ids, amounts and cadence only: no user id,
// email, token or secret (nothing for the account-deletion manifest).
import type { PlanPrice } from './subscription-plan';

export type CheckoutInterval = 'week' | 'month' | 'year';

export type CheckoutTermsSnapshot = {
  v: 1;
  /** Stripe Price billed every period. */
  recurring_price_id: string;
  /** Stripe Price added to the first invoice (combo packages), else null. */
  one_time_price_id: string | null;
  /** What each renewal charges. */
  amount_cents: number;
  /** One-time part charged with the first period (0 for a pure recurring plan). */
  one_time_cents: number;
  currency: string;
  interval: CheckoutInterval;
  interval_count: number;
  /** Trial granted to THIS attempt (0 = none). */
  trial_days: number;
};

function isWholeCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isInterval(v: unknown): v is CheckoutInterval {
  return v === 'week' || v === 'month' || v === 'year';
}

/** Build the snapshot from the offered price and the resolved Stripe prices. */
export function checkoutTermsFor(
  price: PlanPrice,
  trialDays: number,
  prices: { recurring: string; oneTime: string | null },
): CheckoutTermsSnapshot {
  return {
    v: 1,
    recurring_price_id: prices.recurring,
    one_time_price_id: prices.oneTime,
    amount_cents: price.amount_cents,
    one_time_cents: price.one_time_cents,
    currency: price.currency,
    interval: price.interval,
    interval_count: price.interval_count,
    trial_days: trialDays > 0 ? trialDays : 0,
  };
}

/** Parse a stored snapshot; null when absent or not the v1 shape. */
export function parseCheckoutTerms(raw: unknown): CheckoutTermsSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r: Record<string, unknown> = { ...raw };
  if (r.v !== 1) return null;
  if (typeof r.recurring_price_id !== 'string' || r.recurring_price_id.length === 0) return null;
  if (r.one_time_price_id !== null && typeof r.one_time_price_id !== 'string') return null;
  if (!isWholeCents(r.amount_cents) || !isWholeCents(r.one_time_cents)) return null;
  if (typeof r.currency !== 'string' || !/^[a-z]{3}$/i.test(r.currency)) return null;
  if (!isInterval(r.interval)) return null;
  if (
    typeof r.interval_count !== 'number' ||
    !Number.isInteger(r.interval_count) ||
    r.interval_count < 1
  ) {
    return null;
  }
  if (typeof r.trial_days !== 'number' || !Number.isInteger(r.trial_days) || r.trial_days < 0)
    return null;
  return {
    v: 1,
    recurring_price_id: r.recurring_price_id,
    one_time_price_id: typeof r.one_time_price_id === 'string' ? r.one_time_price_id : null,
    amount_cents: r.amount_cents,
    one_time_cents: r.one_time_cents,
    currency: r.currency,
    interval: r.interval,
    interval_count: r.interval_count,
    trial_days: r.trial_days,
  };
}

/** The plan price the attempt actually charges (renewal, today, trial). */
export function planPriceFromTerms(t: CheckoutTermsSnapshot): PlanPrice {
  return {
    amount_cents: t.amount_cents,
    currency: t.currency,
    interval: t.interval,
    interval_count: t.interval_count,
    first_charge_cents: t.trial_days > 0 ? 0 : t.amount_cents + t.one_time_cents,
    one_time_cents: t.one_time_cents,
    trial_days: t.trial_days,
  };
}

/**
 * True while the package still offers the terms this attempt was started
 * with: same renewal price, one-time part, currency and cadence, and (for a
 * trial attempt) the same trial. An attempt without a trial stays valid when
 * the package offers one: the client was not eligible, which does not change.
 */
export function termsStillOffered(
  t: CheckoutTermsSnapshot,
  offered: PlanPrice,
  packageTrialDays: number,
): boolean {
  return (
    t.amount_cents === offered.amount_cents &&
    t.one_time_cents === offered.one_time_cents &&
    t.currency.toLowerCase() === offered.currency.toLowerCase() &&
    t.interval === offered.interval &&
    t.interval_count === offered.interval_count &&
    (t.trial_days === 0 || t.trial_days === packageTrialDays)
  );
}
