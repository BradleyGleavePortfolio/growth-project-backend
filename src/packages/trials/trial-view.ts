// B-TRIALS (OR-113-2) — the trial status the app reads on a purchase
// (GET /v1/checkout/purchases -> purchases[].trial). Pure, so the mobile
// Home / Your plan line ("Trial ends Oct 12") and the backend agree on one
// definition of "in a trial".
//
// B-TRIALS-3 (B-656-5): access and billing are separate facts. A trial that
// started keeps access after the card is removed, but will_charge is true
// only when a card will really be charged at the trial end (the
// subscription's own card as last observed, or the customer's default).
// no_charge_reason says why not ('cancelled' | 'no_card'); a purchase that
// lost the one-trial race reads 'not_eligible' (never access, never charged
// for the trial).

import { trialNoChargeReason, willChargeCard, type TrialNoChargeReason } from './trial-copy';

export type PurchaseTrialState =
  /** No trial on this purchase. */
  | 'none'
  /** Trialing with a saved card: access now, first charge at ends_at. */
  | 'trialing'
  /** Subscription is trialing but no card was saved: not active yet. */
  | 'setup_incomplete'
  /** The trial is over (converted to paid, or ended after a cancel). */
  | 'ended'
  /**
   * B-TRIALS-3 — this subscription tried to start a second free trial with
   * the same coach: no trial access, cancelled, never charged for a trial.
   */
  | 'not_eligible';

export interface PurchaseTrialView {
  state: PurchaseTrialState;
  trial_days: number;
  /** ISO timestamp of the trial end, or null. */
  ends_at: string | null;
  /**
   * True only when a card will really be charged at ends_at (false after a
   * cancel, and false when no card is saved any more).
   */
  will_charge: boolean;
  /** Why the trial end charges nothing (null when it will charge or n/a). */
  no_charge_reason: TrialNoChargeReason;
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
  trial_days: number | null;
  trial_ends_at: Date | null;
  /** B-TRIALS-3 — the subscription's own card, as last observed (null = unknown). */
  card_on_file?: boolean | null;
}

export interface PurchaseTrialContext {
  /** The client's customer-level default card exists (Stripe invoice default). */
  customerDefaultCard?: boolean;
  /** This purchase lost the one-trial race (PackageTrialConflict owed/cancelled). */
  trialConflict?: boolean;
}

export function purchaseTrialView(
  row: PurchaseTrialFields,
  now: Date = new Date(),
  ctx: PurchaseTrialContext = {},
): PurchaseTrialView {
  const endsAt = row.trial_ends_at ?? null;
  const base = {
    trial_days: row.trial_days ?? 0,
    ends_at: endsAt ? endsAt.toISOString() : null,
    charge_amount_cents: row.amount_cents,
    currency: row.currency,
  };
  const none = { will_charge: false, no_charge_reason: null };
  if (!endsAt && (row.trial_days ?? 0) === 0) {
    return { ...base, state: 'none', ...none };
  }
  if (ctx.trialConflict) return { ...base, state: 'not_eligible', ...none };
  const inTrial = row.status === 'trialing' && (!endsAt || endsAt.getTime() > now.getTime());
  if (inTrial) {
    if (!row.entitlement_active) return { ...base, state: 'setup_incomplete', ...none };
    const reason = trialNoChargeReason({
      cancelAtPeriodEnd: row.cancel_at_period_end,
      cardOnFile: willChargeCard(row.card_on_file, !!ctx.customerDefaultCard),
    });
    return { ...base, state: 'trialing', will_charge: reason === null, no_charge_reason: reason };
  }
  return { ...base, state: 'ended', ...none };
}
