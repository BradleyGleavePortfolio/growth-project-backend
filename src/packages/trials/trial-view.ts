// B-TRIALS (OR-113-2) — the trial status the app reads on a purchase
// (GET /v1/checkout/purchases -> purchases[].trial). Pure, so the mobile
// Home / Your plan line ("Trial ends Oct 12") and the backend agree on one
// definition of "in a trial".

export type PurchaseTrialState =
  /** No trial on this purchase. */
  | 'none'
  /** Trialing with a saved card: access now, first charge at ends_at. */
  | 'trialing'
  /** Subscription is trialing but no card was saved: not active yet. */
  | 'setup_incomplete'
  /** The trial is over (converted to paid, or ended after a cancel). */
  | 'ended';

export interface PurchaseTrialView {
  state: PurchaseTrialState;
  trial_days: number;
  /** ISO timestamp of the trial end, or null. */
  ends_at: string | null;
  /** True when the card will be charged at ends_at (false after a cancel). */
  will_charge: boolean;
  /** What the card will be charged at the trial end, in minor units. */
  charge_amount_cents: number;
  currency: string;
}

export interface PurchaseTrialFields {
  status: string;
  entitlement_active: boolean;
  amount_cents: number;
  currency: string;
  cancel_at_period_end: boolean;
  trial_days: number;
  trial_ends_at: Date | null;
}

export function purchaseTrialView(
  row: PurchaseTrialFields,
  now: Date = new Date(),
): PurchaseTrialView {
  const endsAt = row.trial_ends_at ?? null;
  const base = {
    trial_days: row.trial_days ?? 0,
    ends_at: endsAt ? endsAt.toISOString() : null,
    charge_amount_cents: row.amount_cents,
    currency: row.currency,
  };
  if (!endsAt && (row.trial_days ?? 0) === 0) {
    return { ...base, state: 'none', will_charge: false };
  }
  const inTrial = row.status === 'trialing' && (!endsAt || endsAt.getTime() > now.getTime());
  if (inTrial) {
    if (!row.entitlement_active) return { ...base, state: 'setup_incomplete', will_charge: false };
    return { ...base, state: 'trialing', will_charge: !row.cancel_at_period_end };
  }
  return { ...base, state: 'ended', will_charge: false };
}
