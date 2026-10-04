// B-RECUR (split R1 of #654; inert until R2 wires it) — the pure contracts,
// constants and Stripe-object readers of the native subscription checkout,
// moved verbatim out of subscription-checkout.service.ts (R2) to keep each
// piece under the size limit (operator 116 size ruling). Nothing in R1 calls
// this file; R2 (subscription-checkout.service.ts) is its only caller.
import { ConflictException, HttpException } from '@nestjs/common';
import type { ClientPurchase, CoachPackage } from '@prisma/client';
import {
  StripeConnectApiError,
  type StripeSubscriptionCheckoutObject,
} from '../connect/stripe-connect-api.service';

/** pg_advisory_xact_lock namespace: ASCII 'subc'. */
export const ADVISORY_LOCK_NAMESPACE_SUBSCRIPTION_CHECKOUT = 0x73_75_62_63;

/** Stripe expires an unpaid `incomplete` subscription after 23 hours. */
export const OPEN_ATTEMPT_MAX_AGE_MS = 23 * 3600 * 1000;

/**
 * Statuses of a row that is an attempt nobody has paid for yet (with
 * entitlement_active=false and trial_started_at=null). 'trialing' is one of
 * them: a trial attempt mirrors Stripe 'trialing' as soon as its $0 trial
 * invoice is paid, before the client saved a card (B-RECUR-BE R1-1).
 */
export const OPEN_ATTEMPT_STATUSES = [
  'pending',
  'incomplete',
  'payment_failed',
  'trialing',
] as const;

/**
 * Statuses that mean the client already has this plan. 'trialing' counts
 * only once the trial started (trial_started_at set, card saved).
 */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'unpaid'] as const;

/** Statuses of an attempt that is over; its key can never start a plan again. */
export const ENDED_ATTEMPT_STATUSES = new Set(['expired', 'canceled', 'incomplete_expired']);

/** Most stale trial attempts retired per checkout call (bounded Stripe work). */
export const STALE_TRIAL_RETIRE_LIMIT = 3;

/**
 * B-654-5 — a reservation still marked in flight after this long belongs to
 * a request that died (every Stripe call is bounded by a 10 s client
 * timeout, and one mint makes at most four). A later request may take it
 * over and finish it with the same pinned request.
 */
export const STALE_RESERVATION_MS = 120_000;

/** Marker of a reservation whose request is running right now. */
export function reservedMarker(purchaseKey: string): string {
  return `sub-reserved-${purchaseKey}`;
}

/**
 * Marker of a reservation whose Subscription create ended without a clear
 * answer (timeout, 5xx, 429, connection drop): Stripe may or may not have
 * created it. The next request for the attempt resends the pinned request.
 */
export function retryMarker(purchaseKey: string): string {
  return `sub-retry-${purchaseKey}`;
}

/**
 * True when Stripe answered a create definitively, so nothing was created and
 * Stripe stored that answer under the Idempotency-Key (4xx other than a key
 * conflict, an in-use key or a rate limit).
 */
export function isDefinitiveRefusal(err: unknown): boolean {
  return (
    err instanceof StripeConnectApiError &&
    err.httpStatus >= 400 &&
    err.httpStatus < 500 &&
    err.httpStatus !== 409 &&
    err.httpStatus !== 429 &&
    err.stripeType !== 'idempotency_error'
  );
}

/** The machine code of a thrown HttpException, else null. */
export function codeOfHttp(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const body: unknown = err.getResponse();
  if (!body || typeof body !== 'object') return null;
  const code: unknown = Reflect.get(body, 'code');
  return typeof code === 'string' ? code : null;
}

/** Stripe kept this Idempotency-Key for a request with other parameters. */
export function isIdempotencyMismatch(err: unknown): boolean {
  return (
    err instanceof StripeConnectApiError &&
    err.httpStatus === 400 &&
    err.stripeType === 'idempotency_error'
  );
}

/**
 * C-679-3 — Stripe has no such object under this key (404 resource_missing):
 * proven absence, not an outage, so the attempt can end and free its plan.
 */
export function isResourceMissing(err: unknown): boolean {
  return (
    err instanceof StripeConnectApiError &&
    err.httpStatus === 404 &&
    err.stripeCode === 'resource_missing'
  );
}

/** PaymentIntent statuses a PaymentSheet can still complete. */
export const PAYABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

/** Longest trial the checkout will start (B-TRIALS validates the package side). */
export const MAX_TRIAL_DAYS = 730;

export interface SubscriptionIntentInput {
  package_id: string;
  idempotency_key: string;
  /** The renewal price the app showed. */
  expected_amount_cents?: number;
  /** A combo's one-time part the app showed (0 or absent for a pure recurring plan). */
  expected_one_time_cents?: number;
  /**
   * The share-link token the client opened, when the purchase starts from a
   * share link. Used only to say WHY a package of a coach the client is not
   * connected with cannot be bought here (PACKAGE_COACH_NOT_CONNECTED); it
   * never widens who can buy.
   */
  share_token?: string;
}

export interface PlanPrice {
  /** What each renewal charges. */
  amount_cents: number;
  currency: string;
  interval: 'week' | 'month' | 'year';
  interval_count: number;
  /** What is charged today (one-time price + first period for a combo; 0 in a trial). */
  first_charge_cents: number;
  /** One-time part of a combo package (0 for a pure recurring package). */
  one_time_cents: number;
  trial_days: number;
}

export interface SubscriptionIntentResult {
  /**
   * PaymentSheet mode: 'payment' charges now; 'setup' saves a card for a
   * trial. 'none' (B-654-6): Stripe needs nothing from the client (the first
   * invoice was paid without a sheet, or its payment is processing); the app
   * opens no sheet, shows "Confirming your plan" and polls the plan, and the
   * webhook grants access. client_secret and ephemeral_key are '' then.
   */
  mode: 'payment' | 'setup' | 'none';
  client_secret: string;
  ephemeral_key: string;
  customer_id: string;
  publishable_key: string;
  purchase_id: string;
  subscription_id: string;
  status: string;
  reused: boolean;
  plan: PlanPrice & { package_id: string; package_name: string; trial_ends_at: string | null };
}

export type PlanState =
  'confirming' | 'payment_failed' | 'trialing' | 'active' | 'past_due' | 'ended';

/**
 * B-334-3 — what Stripe says about a plan that is still confirming, read on
 * GET /subscriptions/:id only. The app claims "nothing was charged" only on
 * awaiting_payment / awaiting_card (Stripe shows no payment and no saved
 * card), and keeps confirming on processing / paid / card_saved.
 * 'unknown' = Stripe could not be read now. null = not applicable (the plan
 * is already entitled or ended, or the list route).
 */
export type CheckoutState =
  'awaiting_payment' | 'awaiting_card' | 'processing' | 'paid' | 'card_saved' | 'ended' | 'unknown';

export interface ClientPlanView {
  purchase_id: string;
  package_id: string;
  package_name: string;
  coach_user_id: string;
  state: PlanState;
  status: string;
  entitlement_active: boolean;
  amount_cents: number;
  currency: string;
  interval: 'week' | 'month' | 'year' | null;
  interval_count: number;
  current_period_end: string | null;
  /** Next charge date; null when no further charge is scheduled. */
  next_charge_at: string | null;
  cancel_at_period_end: boolean;
  /** When access ends (scheduled cancel or ended plan); null while renewing. */
  access_ends_at: string | null;
  trial_days: number | null;
  trial_ends_at: string | null;
  can_cancel: boolean;
  can_resume: boolean;
  can_resubscribe: boolean;
  /** Last payment problem in plain words, or null. Never a Stripe secret. */
  last_payment_error: string | null;
  /** B-334-3 — Stripe's view of a plan still confirming (single-plan read only). */
  checkout_state: CheckoutState | null;
}

/**
 * Trial length on the package. B-TRIALS adds `CoachPackage.trial_days`
 * (Int @default(0)) in its own PR; read it defensively so this checkout is
 * correct before and after that column exists. Trials apply to pure
 * recurring packages only (a combo would charge its one-time price on the
 * trial's first invoice).
 */
export function packageTrialDays(pkg: CoachPackage): number {
  if (pkg.billing_type !== 'recurring') return 0;
  const raw: unknown = Reflect.get(pkg, 'trial_days');
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_TRIAL_DAYS);
}

export function asInterval(v: string | null | undefined): 'week' | 'month' | 'year' | null {
  return v === 'week' || v === 'month' || v === 'year' ? v : null;
}

/** Renewal + first-charge price of a recurring (or combo) package. */
export function planPriceFor(pkg: CoachPackage, trialDays: number): PlanPrice {
  const isCombo = pkg.billing_type !== 'recurring';
  const interval = asInterval(isCombo ? pkg.recurring_interval : pkg.interval);
  if (!interval) {
    throw new ConflictException({
      code: 'PACKAGE_INTERVAL_INVALID',
      error: 'PACKAGE_INTERVAL_INVALID',
      message:
        'This plan has no valid billing period, so it cannot be started. Message your coach to fix the plan.',
    });
  }
  const amount = isCombo ? (pkg.recurring_amount_cents ?? 0) : pkg.amount_cents;
  const oneTime = isCombo ? pkg.amount_cents : 0;
  const intervalCount = Math.max(
    1,
    (isCombo ? pkg.recurring_interval_count : pkg.interval_count) ?? 1,
  );
  return {
    amount_cents: amount,
    currency: pkg.currency,
    interval,
    interval_count: intervalCount,
    first_charge_cents: trialDays > 0 ? 0 : amount + oneTime,
    one_time_cents: oneTime,
    trial_days: trialDays,
  };
}

/**
 * R1-10 — true when `token` is this package's live share-link token (same
 * rules as the public join route: enabled, not revoked, not expired).
 */
export function shareLinkMatches(pkg: CoachPackage, token: string | undefined): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (!pkg.share_token || pkg.share_token !== token) return false;
  if (!pkg.share_link_enabled || pkg.share_link_revoked_at) return false;
  if (pkg.share_link_expires_at && pkg.share_link_expires_at.getTime() <= Date.now()) return false;
  return true;
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function expandedId(v: { id?: string } | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : (v.id ?? null);
}

/** B-654-6 — a subscription with no sheet secret: paid/processing, ended, or stuck. */
export function classifyWithoutSheet(
  sub: StripeSubscriptionCheckoutObject,
): 'complete' | 'ended' | 'unavailable' {
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'ended';
  if (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'unpaid') {
    return 'complete';
  }
  if (sub.status === 'trialing') return sub.default_payment_method ? 'complete' : 'unavailable';
  const inv =
    sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  if (inv?.status === 'paid') return 'complete';
  const pi = inv && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  if (pi?.status === 'succeeded' || pi?.status === 'processing') return 'complete';
  if (pi?.status === 'canceled') return 'ended';
  return 'unavailable';
}

/** True while no payment of this subscription succeeded or is in flight. */
export function subscriptionUnpaid(sub: StripeSubscriptionCheckoutObject): boolean {
  if (sub.status !== 'incomplete' && sub.status !== 'trialing') return false;
  if (sub.status === 'trialing' && sub.default_payment_method) return false;
  const inv =
    sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  const pi = inv && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  return !(pi?.status === 'succeeded' || pi?.status === 'processing' || inv?.status === 'paid');
}

export function sheetSecret(
  sub: StripeSubscriptionCheckoutObject,
): { mode: 'payment' | 'setup'; client_secret: string } | null {
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return null;
  const si = sub.pending_setup_intent;
  if (sub.status === 'trialing') {
    if (si && typeof si === 'object' && typeof si.client_secret === 'string') {
      return { mode: 'setup', client_secret: si.client_secret };
    }
    return null;
  }
  const inv = sub.latest_invoice;
  const pi = inv && typeof inv === 'object' ? inv.payment_intent : null;
  if (
    pi &&
    typeof pi === 'object' &&
    typeof pi.client_secret === 'string' &&
    (!pi.status || PAYABLE_PI_STATUSES.has(pi.status))
  ) {
    return { mode: 'payment', client_secret: pi.client_secret };
  }
  return null;
}

export function planView(row: ClientPurchase, pkg: CoachPackage | null): ClientPlanView {
  const status = row.status;
  const ended = status === 'canceled' || status === 'incomplete_expired' || status === 'expired';
  let state: PlanState;
  if (ended) state = 'ended';
  else if (row.entitlement_active && status === 'trialing') state = 'trialing';
  else if (row.entitlement_active && (status === 'past_due' || status === 'unpaid'))
    state = 'past_due';
  else if (row.entitlement_active) state = 'active';
  else if (status === 'payment_failed') state = 'payment_failed';
  else state = 'confirming';
  const live = state === 'active' || state === 'trialing' || state === 'past_due';
  const interval = pkg
    ? asInterval(pkg.billing_type === 'recurring' ? pkg.interval : pkg.recurring_interval)
    : null;
  const intervalCount = pkg
    ? Math.max(
        1,
        (pkg.billing_type === 'recurring' ? pkg.interval_count : pkg.recurring_interval_count) ?? 1,
      )
    : 1;
  const periodEnd = row.current_period_end;
  return {
    purchase_id: row.id,
    package_id: row.package_id,
    package_name: pkg?.name ?? '',
    coach_user_id: row.coach_user_id,
    state,
    status,
    entitlement_active: row.entitlement_active,
    amount_cents: row.amount_cents,
    currency: row.currency,
    interval,
    interval_count: intervalCount,
    current_period_end: iso(periodEnd),
    next_charge_at: live && !row.cancel_at_period_end ? iso(periodEnd) : null,
    cancel_at_period_end: row.cancel_at_period_end,
    access_ends_at: ended
      ? iso(row.canceled_at ?? row.access_expires_at)
      : live && row.cancel_at_period_end
        ? iso(periodEnd)
        : null,
    trial_days: row.trial_days ?? null,
    trial_ends_at: state === 'trialing' ? iso(periodEnd) : null,
    can_cancel: live && !row.cancel_at_period_end,
    can_resume: live && row.cancel_at_period_end,
    can_resubscribe: ended,
    last_payment_error:
      state === 'payment_failed' || state === 'past_due'
        ? 'Your last payment did not go through.'
        : null,
    checkout_state: null,
  };
}
