import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeSubscriptionObject,
} from '../connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { PrismaService } from '../prisma.service';
import { DunningService } from './dunning.service';
import { DunningV2Service } from './dunning-v2/dunning-v2.service';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';
import { errorLabel } from './error-label';
import { attachTrialCard } from './trial-card';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';
import { PayoutRoutingService } from '../payouts-v2/payout-routing.service';
import { CoachFirstPaymentService } from '../notifications/coach-first-payment.service';
import { CLEARED_PAYMENT_SECRETS } from './admin-purchase.select';

// B-661-1 (Opus): the purchase statuses a payment_intent.succeeded claims. A
// PaymentIntent that succeeded is terminal, so its success always wins over
// an earlier decline of the same PaymentIntent.
const PI_SUCCEEDED_CLAIMABLE = ['pending', 'payment_failed'];

// B-661-5 (Opus, round 4): which purchase a payment_intent.succeeded
// activates. A pending purchase holding this PaymentIntent, or a
// payment_failed one only when it is the PaymentSheet purchase created for
// this PaymentIntent (createPaymentIntentForClient sets its
// stripe_checkout_session_id to the PaymentIntent id). A hosted Checkout
// purchase that a decline marked payment_failed is activated once, by its
// checkout.session.completed (access window, hosted fanout, one split).
function activatesOnPaymentIntentSuccess(
  purchase: { status: string; stripe_checkout_session_id: string },
  paymentIntentId: string,
): boolean {
  return (
    purchase.status === 'pending' ||
    (purchase.status === 'payment_failed' &&
      purchase.stripe_checkout_session_id === paymentIntentId)
  );
}

// B-661-3 (Sol, round 3): which purchases a payment_intent.payment_failed may
// write. Stripe does not deliver events in order, so a decline can arrive
// after a successful retry of the same PaymentIntent.
//   - `pending` / `payment_failed` may still fail: the write is a
//     compare-and-set on that status, so a success that commits first wins.
//   - These statuses belong to their own events (refund, dispute, cancel,
//     expiry); a decline never rewrites them.
//   - Any other status (paid, active, past_due, trialing, ...) already
//     settled: only Stripe's CURRENT status of the PaymentIntent decides.
//     PI_STATUS_NOT_COMPLETED = the payment really did not complete (e.g. an
//     asynchronous payment that was processing when a hosted checkout
//     completed, then failed), so access ends. `succeeded` = the decline is
//     stale; `processing` / `requires_action` / `requires_confirmation` = a
//     later attempt is in flight and its own outcome event decides. Either
//     way the decline changes nothing.
const PI_FAILED_CLAIMABLE = PI_SUCCEEDED_CLAIMABLE;
const PI_FAILED_NEVER_REWRITES = new Set([
  'canceled',
  'expired',
  'refunded',
  'disputed',
  'chargeback_lost',
]);
const PI_STATUS_NOT_COMPLETED = new Set(['requires_payment_method', 'canceled']);
// C-661-6: Stripe answered 4xx (other than 429) for the PaymentIntent, so a
// retry cannot read it either. Not a Stripe status.
const PI_STATUS_UNREADABLE = 'unreadable';
function failureNeedsProviderStatus(purchaseStatus: string): boolean {
  return (
    !PI_FAILED_CLAIMABLE.includes(purchaseStatus) && !PI_FAILED_NEVER_REWRITES.has(purchaseStatus)
  );
}

// C-661-7: statuses checkout.session.completed never activates again: the
// one-time purchase was activated already, or a later event ended it.
const CHECKOUT_NEVER_REACTIVATES = ['paid', ...PI_FAILED_NEVER_REWRITES];

// B-661-3 (Sol, round 5): the version of a purchase row that a prefetched
// PaymentIntent status was read against. row_version is PostgreSQL's xmin,
// the id of the transaction that last wrote the row: every committed write
// of any writer (Prisma or raw SQL, any service) changes it, two writes in
// the same millisecond included; a row lock alone does not. A changed value
// can only cause a retry; an equal value after a write would need about
// 2^32 transactions between the prefetch and the webhook transaction.
// updated_at (an application-clock timestamp) is not a version: two writes
// can share it.
export interface PurchaseVersion {
  purchase_id: string;
  status: string;
  row_version: string;
}
type PurchaseVersionRow = { status: string; row_version: string };
function samePurchaseVersion(
  seen: PurchaseVersion | null | undefined,
  now: PurchaseVersion | null,
): boolean {
  return (
    !!seen &&
    !!now &&
    seen.purchase_id === now.purchase_id &&
    seen.status === now.status &&
    seen.row_version === now.row_version
  );
}

// Prisma's "record to update not found" (P2025): the row no longer matches
// the state a write was decided for.
function isRecordNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';
}

// Thrown inside the webhook transaction when an event cannot be applied
// safely now. BillingService rolls the transaction back (dedup row included)
// and answers 503, so Stripe redelivers the event and the out-of-tx prefetch
// runs again. Ids and codes only: no Stripe or client text.
function declineRetryLater(reason: string, paymentIntentId: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    error: 'PAYMENT_FAILURE_RETRY',
    reason,
    payment_intent_id: paymentIntentId,
    message: 'This payment failure event cannot be applied yet. Stripe redelivers it.',
  });
}
function successRetryLater(reason: string, paymentIntentId: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    error: 'PAYMENT_SUCCESS_RETRY',
    reason,
    payment_intent_id: paymentIntentId,
    message: 'This payment success event cannot be applied yet. Stripe redelivers it.',
  });
}

// Log tag for a failed call: HTTP status and Stripe code, or the error class.
// Never the message (it may carry provider or client text).
function errorTag(err: unknown): string {
  if (err instanceof StripeConnectApiError) {
    return `stripe_${err.httpStatus}_${err.stripeCode ?? 'none'}`;
  }
  return err instanceof Error ? err.name : 'unknown';
}

// PR-9: BillingService.handleEvent passes its outer `$transaction`'s tx
// client through `handle(event, tx)` so the entitlement update +
// PurchaseFanout drop seeding + immediate-cadence materialisation all
// commit-or-rollback together with the StripeProcessedEvent dedup row.
// Legacy callers (and the spec suite that hand-constructs the handler
// outside a tx) may still call `handle(event)` with no tx; the handler
// then falls back to the bare `this.prisma` client for the entitlement
// write and skips the fan-out's tx-only steps (drop seed). The webhook
// handler's own idempotency via StripeProcessedEvent + PurchaseFanout
// @unique is unchanged.
type WebhookTx = Prisma.TransactionClient;

/**
 * B-680-5 — the trial carries the attempt's own card: the trial-card attach
 * set the default and, in the same write, lifted the create-time end. A
 * default with that end still on (Stripe saved a card itself, or a card the
 * attempt never confirmed) is not proof the attempt saved a card. Same rule
 * as R2's ownTrialCardOn.
 */
function trialOwnCardOn(sub: {
  default_payment_method?: unknown;
  cancel_at_period_end?: boolean;
}): boolean {
  return !!sub.default_payment_method && !sub.cancel_at_period_end;
}

/**
 * B-RECUR — does this Stripe subscription state grant access? active /
 * trialing / past_due do, except a native trial that has not started whose
 * card is not the attempt's own yet (B-680-5: no default card, or a default
 * with the create-time end still on): that trial starts only when the
 * attempt's SetupIntent succeeded and its card was attached.
 */
export function subscriptionGrantsAccess(
  purchase: Pick<ClientPurchase, 'trial_days' | 'trial_started_at' | 'entitlement_active'>,
  sub: { status?: string; default_payment_method?: unknown; cancel_at_period_end?: boolean },
): boolean {
  const status = sub.status ?? 'pending';
  if (!['active', 'trialing', 'past_due'].includes(status)) return false;
  if (
    status === 'trialing' &&
    purchase.trial_days != null &&
    !purchase.trial_started_at &&
    !purchase.entitlement_active &&
    !trialOwnCardOn(sub)
  ) {
    return false;
  }
  return true;
}

/**
 * B-RECUR / B-680-4 — the one-trial marker. A native trial is used once its
 * subscription grants access, whichever state is observed first: trialing
 * after the card was saved, or already active / past_due when the trialing
 * event is late. The date is Stripe's trial_start when the object has it.
 */
function trialStartPatch(
  purchase: Pick<ClientPurchase, 'trial_days' | 'trial_started_at'>,
  sub: { trial_start?: unknown },
  entitled: boolean,
): { trial_started_at?: Date } {
  if (!entitled || purchase.trial_days == null || purchase.trial_started_at) return {};
  const start =
    typeof sub.trial_start === 'number' && sub.trial_start > 0 ? new Date(sub.trial_start * 1000) : null;
  return { trial_started_at: start ?? new Date() };
}

/** B-680-1 — Stripe never moves a subscription out of these states. */
const STRIPE_ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/**
 * B-680-1 — access that no Stripe event restores: the plan ended (deleted,
 * expired or retired) or was revoked for money (full refund, lost dispute,
 * dispute: R-DISPUTE-PAUSE, the coach restarts access separately).
 */
const REVOKED_STATUSES = new Set([
  'canceled',
  'expired',
  'incomplete_expired',
  'refunded',
  'chargeback_lost',
  'disputed',
]);

/** B-680-1 — the purchase ended or was revoked and grants nothing, whenever read. */
export function purchaseHasEnded(
  purchase: Pick<ClientPurchase, 'status' | 'entitlement_active'>,
): boolean {
  return REVOKED_STATUSES.has(purchase.status) && !purchase.entitlement_active;
}

/**
 * B-680-1 — the subscription left `incomplete` (first invoice paid, trial
 * started, or any later state). Stripe never returns a subscription to
 * `incomplete`, so an incomplete snapshot of such a purchase is stale.
 */
function purchaseLeftIncomplete(
  purchase: Pick<ClientPurchase, 'status' | 'entitlement_active' | 'trial_started_at'>,
): boolean {
  return (
    purchase.entitlement_active ||
    !!purchase.trial_started_at ||
    !['pending', 'incomplete', 'payment_failed'].includes(purchase.status)
  );
}

/**
 * B-680-1 — the lifecycle columns subscription events write, read before the
 * out-of-tx Stripe read and again under the package lock. A difference means
 * another delivery wrote the purchase in between, so that Stripe read may be
 * older than the write.
 */
export function lifecycleRevision(
  purchase: Pick<
    ClientPurchase,
    | 'status'
    | 'entitlement_active'
    | 'trial_started_at'
    | 'canceled_at'
    | 'current_period_end'
    | 'cancel_at_period_end'
  >,
): string {
  const ms = (d: Date | null | undefined) => (d instanceof Date ? String(d.getTime()) : '');
  return [
    purchase.status,
    String(!!purchase.entitlement_active),
    ms(purchase.trial_started_at),
    ms(purchase.canceled_at),
    ms(purchase.current_period_end),
    String(!!purchase.cancel_at_period_end),
  ].join('|');
}

/**
 * B-680-2 — the purchase's write version. Every Prisma write moves updated_at
 * (lifecycle-neutral ones too, such as a paid invoice that rewrites an
 * active plan with the same values), so a read taken before a Stripe read
 * and compared under the lock proves no write landed in between.
 */
function writeVersion(purchase: { updated_at?: Date | null }): string {
  return purchase.updated_at instanceof Date ? String(purchase.updated_at.getTime()) : '';
}

/** B-680-2 — a strictly newer updated_at, so no reader of the old version misses this write. */
function nextVersion(purchase: { updated_at?: Date | null }): Date {
  const prev = purchase.updated_at instanceof Date ? purchase.updated_at.getTime() : 0;
  return new Date(Math.max(Date.now(), prev + 1));
}

/**
 * B-680-1 / B-680-2 — a decision made on a Stripe read that a newer purchase
 * write superseded. Thrown inside the outer tx: BillingService rolls back
 * (dedup row included) and Stripe redelivers, and the redelivery reads Stripe
 * again. Never swallowed by a degrade path.
 */
export class WebhookRedeliverError extends Error {}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
  (a instanceof Date ? a.getTime() : null) === (b instanceof Date ? b.getTime() : null);

/** The subscription fields the purchase lifecycle reads (event or live object). */
type SubscriptionSnapshot = {
  id?: string;
  status?: string;
  customer?: string | { id?: string } | null;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  default_payment_method?: unknown;
  trial_start?: unknown;
  latest_invoice?: unknown;
  metadata?: Record<string, string> | null;
};

/** C-680-4 — the first invoice's PaymentIntent id when Stripe sent it expanded. */
function firstInvoicePaymentIntentId(latestInvoice: unknown): string | null {
  if (!latestInvoice || typeof latestInvoice !== 'object') return null;
  const pi: unknown = Reflect.get(latestInvoice, 'payment_intent');
  if (typeof pi === 'string') return pi;
  const id: unknown = pi && typeof pi === 'object' ? Reflect.get(pi, 'id') : null;
  return typeof id === 'string' ? id : null;
}

/**
 * B-RECUR — an unpaid subscription attempt that never granted access. A trial
 * attempt whose $0 trial invoice was paid mirrors Stripe 'trialing' before
 * the card is saved; it never granted access either (B-RECUR-BE R1-1).
 */
export function isNeverEntitledAttempt(
  purchase: Pick<ClientPurchase, 'status' | 'entitlement_active' | 'trial_started_at'>,
): boolean {
  return (
    !purchase.entitlement_active &&
    !purchase.trial_started_at &&
    ['pending', 'incomplete', 'payment_failed', 'trialing'].includes(purchase.status)
  );
}

/**
 * B-680-2 — is this failed invoice a first checkout attempt rather than a
 * renewal? The first invoice (billing_reason subscription_create) is one
 * whatever the purchase shows now: a decline delivered after that invoice was
 * paid, or after the attempt ended, never starts dunning. Without a reason, a
 * purchase that never granted access is still an attempt. A post-trial charge
 * is a subscription_cycle invoice, so it stays eligible for dunning. Same
 * signature as the dunning stack's helper, so the second of the two stacks to
 * land merges them mechanically.
 */
export function isNeverEntitledPaymentAttempt(
  purchase: Pick<ClientPurchase, 'status' | 'entitlement_active' | 'trial_started_at'>,
  billingReason: string | null,
): boolean {
  if (billingReason === 'subscription_create') return true;
  return isNeverEntitledAttempt(purchase);
}

/**
 * B-RECUR-BE R1-8 — a native checkout attempt (POST /v1/checkout/
 * subscription-intent) that ended without ever being paid or starting its
 * trial. Native rows carry the subscription id as their checkout-session id.
 * Such an ending is not churn: it is recorded as 'expired', never 'canceled'.
 */
export function isUnpaidNativeAttempt(
  purchase: Pick<
    ClientPurchase,
    | 'status'
    | 'entitlement_active'
    | 'trial_started_at'
    | 'billing_type'
    | 'stripe_subscription_id'
    | 'stripe_checkout_session_id'
  >,
): boolean {
  return (
    purchase.billing_type === 'recurring' &&
    !!purchase.stripe_subscription_id &&
    purchase.stripe_checkout_session_id === purchase.stripe_subscription_id &&
    (isNeverEntitledAttempt(purchase) ||
      (purchase.status === 'expired' && !purchase.entitlement_active && !purchase.trial_started_at))
  );
}

// Lifecycle:
//
//   pending  -- checkout.session.completed   --> paid (one_time) / active (recurring)
//   active   -- customer.subscription.updated --> active | past_due | canceled
//   active   -- customer.subscription.deleted --> canceled
//   pending | payment_failed -- payment_intent.payment_failed --> payment_failed
//   paid | active | ...      -- payment_intent.payment_failed --> payment_failed
//                               only when Stripe says the PaymentIntent did not
//                               complete (B-661-3); otherwise unchanged
//   payment_failed (activated before) -- payment_intent.succeeded --> paid
//                               recovery: access and the canceled drops come
//                               back; no second activation (B-661-3 round 5)
//   pending  -- checkout.session.expired      --> expired
//
// Entitlement (`entitlement_active`) is derived and persisted on every
// transition so authorization checks are a single indexed read.
//
// All event types are no-op if no matching ClientPurchase row exists
// (the event is logged at debug level — it is normal for the platform
// Stripe account to also send events about SaaS coach subscriptions which
// CheckoutWebhookHandlerService does NOT own; BillingService handles those.
// The two handlers are kept disjoint via the metadata key `tgp_package_id`:
// if set, this handler claims the event).

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

// PR-18 B1 R3 P1 — a split-posting task the handler deferred because an
// outer $transaction (and the CoachPackage FOR UPDATE lock) was held when
// the charge succeeded. PurchaseSplitHandlerService.onChargeSucceeded() can
// synchronously call Stripe (retrievePaymentIntent to resolve the charge id
// AND transfers.attempt() which POSTs a Stripe Transfer); running it inside
// the outer tx holds the Postgres connection — and the package row lock —
// across a Stripe round-trip (the A276-P1-3 anti-pattern, made worse by B1's
// lock). When BillingService threads an outer tx, the handler resolves the
// charge id out-of-tx via prefetchForOuterTx and returns this descriptor so
// BillingService runs the split posting AFTER the outer tx commits. The
// split ledger is idempotent (composite-unique upserts) and the transfer is
// idempotency-keyed + sweeper-backed, so a rolled-back outer tx simply skips
// the post-commit run and Stripe's redelivery (or the sweeper) reconciles.
export interface DeferredSplitTask {
  purchase: ClientPurchase;
  // Charge id pre-resolved out-of-tx (null when not yet known — the split
  // handler then no-ops the transfer and the sweeper retries).
  charge_id: string | null;
  // Recurring-renewal extras (invoice.paid path).
  invoice_amount_cents?: number;
}

export interface CheckoutWebhookResult {
  claimed: boolean;
  reason?: string;
  purchase_id?: string;
  // PR-18 B1 R3 P1 — present iff split posting was deferred to post-commit
  // because the caller held an outer $transaction. BillingService runs these
  // after the outer tx commits (see runDeferredSplit below).
  deferredSplit?: DeferredSplitTask;
  // S-FEE round 6 (#627 C-627-7) — present when a refund / dispute recorded
  // payout notices for this charge inside the caller's $transaction.
  // BillingService delivers them after the tx commits (deliverPayoutNotices).
  deferredPayoutNoticeChargeId?: string;
}

// PR-18 B1 — state that the checkout handler needs from Stripe HTTP but that
// must be resolved BEFORE BillingService opens its outer $transaction, so no
// Stripe round-trip is ever held while a DB transaction (and the CoachPackage
// FOR UPDATE lock) is open. BillingService calls `prefetchForOuterTx(event)`
// before the tx and threads the result through `handle(event, tx, prefetched)`.
export interface CheckoutWebhookPrefetch {
  // The renewed Stripe subscription for an invoice.paid/payment_succeeded
  // event, resolved out-of-tx. null when not applicable or the lookup failed
  // (the handler then falls back to its own out-of-tx retrieve only when no
  // outer tx is held).
  invoiceSubscription?: StripeSubscriptionObject | null;
  // PR-18 B1 R3 P1 — Stripe charge id for the purchase a checkout.session.
  // completed / payment_intent.succeeded event activates, resolved out-of-tx
  // BEFORE BillingService opens its outer $transaction. Keyed by
  // ClientPurchase.id. The deferred split posting (run post-commit) uses this
  // so PurchaseSplitHandlerService never has to call retrievePaymentIntent
  // while the outer tx / package row lock is held. null = not yet known
  // (rare settling race); the split handler no-ops the transfer and the
  // sweeper picks it up. undefined entry = no pre-resolution attempted.
  chargeIdByPurchaseId?: Record<string, string | null>;
  // B-661-3 — Stripe's current status of the PaymentIntent a
  // payment_intent.payment_failed names, keyed by PaymentIntent id. Resolved
  // out-of-tx only when the matched purchase already settled (a decline of a
  // pending or failed purchase never needs it). null = the lookup failed.
  paymentIntentStatusById?: Record<string, string | null>;
  // B-661-3 round 4/5 — the purchase version read BEFORE that Stripe lookup.
  // The status applies only while the purchase is still that version.
  paymentIntentWitnessById?: Record<string, PurchaseVersion>;
  // B-654-1 — setup_intent.succeeded for a native trial attempt: the saved
  // card was made the subscription's default out-of-tx. null = the
  // SetupIntent is not a native trial's; ok=false = the Stripe write failed
  // (the handler throws so Stripe redelivers the event).
  trialCard?: { purchaseId: string | null; ok: boolean } | null;
  // B-680-1 — customer.subscription.created/updated of a package purchase:
  // the live subscription read out-of-tx, with the purchase's lifecycle
  // revision read before it (null = no bound row yet). null = Stripe could
  // not be read (the handler throws so Stripe redelivers).
  subscriptionAuthority?: { sub: StripeSubscriptionObject; revision: string | null } | null;
  // B-680-1 — invoice.paid: the purchase's lifecycle revision read before
  // invoiceSubscription.
  invoiceRevision?: string;
  // B-680-2 — invoice.payment_failed of a package purchase: the invoice's
  // live status (a later paid or void invoice is settled). null = Stripe
  // could not be read (the handler throws so Stripe redelivers).
  failedInvoiceStatus?: string | null;
  // B-680-2 — read with failedInvoiceStatus: the purchase's write version
  // and status (read first), and the live subscription's status and latest
  // invoice.
  failedInvoiceAuthority?: {
    version: string;
    purchaseStatus?: string;
    subscriptionStatus: string | null;
    latestInvoiceId: string | null;
  };
}

@Injectable()
export class CheckoutWebhookHandlerService {
  private readonly logger = new Logger(CheckoutWebhookHandlerService.name);

  constructor(
    private prisma: PrismaService,
    private stripeConnect: StripeConnectApiService,
    // Phase 4-5 — split & dunning. @Optional() so legacy bootstrap tests
    // that don't wire these still construct the handler.
    @Optional() private splits?: PurchaseSplitHandlerService,
    @Optional() private dunning?: DunningService,
    // Phase 6 — refund / dispute / payout event handling. Optional so the
    // legacy unit-test wiring still constructs the handler without these.
    @Optional() private refundDispute?: RefundDisputeHandlerService,
    // PR-4 — fan-out seam fired when entitlement_active flips true.
    // @Optional() so legacy unit tests that hand-construct this service
    // without the full Nest container still work; in production wiring
    // (CheckoutModule imports PackagesModule) it is always present.
    @Optional() private fanout?: PurchaseFanoutService,
    // Bank-Account Payouts v2 (spec §2.5) — @Optional() additive routing seam.
    // On payout.* events the router resolves the coach's effective
    // PayoutMethod.kind and reports the bookkeeping tier (card vs bank). It
    // NEVER moves money (Stripe already did) and NO-OPs while
    // FEATURE_BANK_PAYOUTS_V2 is off, so v1 Express payout bookkeeping
    // (RefundDisputeHandlerService.onPayoutEvent) is entirely unchanged.
    @Optional() private payoutRouting?: PayoutRoutingService,
    // B3 Smart Dunning v2 — @Optional() additive seam. Every call below is
    // gated internally by FEATURE_DUNNING_V2 (default OFF), so this never
    // alters v1 behaviour: while the flag is off the v2 methods return
    // immediately without reading or writing state. No v1 dunning logic is
    // modified — these are pure additions after the existing v1 calls.
    @Optional() private dunningV2?: DunningV2Service,
    // Roman P4 (Option C) — @Optional() additive seam. The first-payment
    // notification primitive. Every call below is gated on
    // FEATURE_ROMAN_FIRST_PAYMENT (default OFF), so while the flag is off this
    // never reads or writes state. @Optional() so legacy unit-test wiring that
    // hand-constructs the handler without the full container still works.
    @Optional() private coachFirstPaymentService?: CoachFirstPaymentService,
  ) {}

  /**
   * Roman P4 (Option C) — record + emit the coach's first-ever payment
   * notification, gated on FEATURE_ROMAN_FIRST_PAYMENT (default OFF). Called
   * from BOTH entitlement-activation callsites (checkout.session.completed and
   * payment_intent.succeeded) AFTER the purchase status flips, on the SAME
   * outer `tx` so the ledger row commits-or-rolls-back with the purchase
   * (50-Failures #44). All inputs come from the SERVER-TRUSTED, just-persisted
   * ClientPurchase row — never the Stripe webhook body (50-Failures #5 IDOR).
   * Exactly-once is enforced downstream by CoachFirstPaymentNotification's
   * coachId @unique. No-op when the flag is off, the service is unwired, or no
   * outer tx is held (the emit MUST share the purchase transaction).
   */
  private async maybeEmitFirstPayment(
    purchase: ClientPurchase,
    tx: WebhookTx | undefined,
    correlationId?: string,
  ): Promise<void> {
    if (process.env.FEATURE_ROMAN_FIRST_PAYMENT !== 'true') return;
    if (!this.coachFirstPaymentService || !tx) return;
    // R81 (PR-395 follow-up, F1/F2): the SAME outer `tx` is threaded all the
    // way through tryEmitFirstPayment → emitter → createNotification so the
    // notification rows commit-or-roll-back with the ledger row + purchase.
    // `correlationId` (the Stripe event id) is carried for the F8 audit entry.
    await this.coachFirstPaymentService.tryEmitFirstPayment(tx, {
      coachId: purchase.coach_user_id,
      amount: purchase.amount_cents,
      currency: purchase.currency,
      clientId: purchase.client_user_id,
      correlationId,
    });
  }

  // Returns claimed=true iff the event was for a Connect package purchase
  // (identified by `metadata.tgp_package_id` or by a matching
  // stripe_checkout_session_id / stripe_subscription_id on a ClientPurchase
  // row). The caller (BillingService) inspects claimed and skips the
  // SaaS-coach-subscription handler when this returns claimed=true.
  async handle(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.applyCheckoutCompleted(event, tx, prefetched);
      case 'checkout.session.expired':
        return this.applyCheckoutExpired(event);
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        return this.applySubscriptionUpdated(event, tx, prefetched);
      case 'customer.subscription.deleted':
        return this.applySubscriptionDeleted(event, tx);
      case 'payment_intent.succeeded':
        return this.applyPaymentIntentSucceeded(event, tx, prefetched);
      case 'payment_intent.payment_failed':
        return this.applyPaymentIntentFailed(event, tx, prefetched);
      // DUNNING-V1 — invoice.payment_succeeded mirrors invoice.paid in
      // Stripe's docs for the subscription-renewal path; some accounts
      // emit one, some the other. We route both to the same handler so
      // the dunning window resolution is robust either way.
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        return this.applyInvoicePaid(event, tx, prefetched);
      case 'invoice.payment_failed':
        return this.applyInvoicePaymentFailed(event, tx, prefetched);
      case 'setup_intent.succeeded':
        return this.applySetupIntentSucceeded(event, tx, prefetched);
      case 'customer.updated':
        return this.applyCustomerUpdated(event);
      // Phase 6 — refund / dispute / transfer / payout events. Delegated
      // to the RefundDisputeHandlerService.
      // Round 17 (Sol B-684-4, Opus B-684-7): Stripe sends refund.updated for every refund and
      // marks charge.refund.updated deprecated; both reach the refund handler (idempotent per
      // refund id), so an async refund's later status moves its money either way.
      case 'charge.refunded':
      case 'charge.refund.updated':
      case 'refund.updated':
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'transfer.reversed':
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.canceled':
        // PR-16 — pass the outer tx so cancelPendingForPurchase can run
        // INSIDE the refund / dispute revocation $transaction (entitlement
        // revoke + drop cancel commit-or-rollback together).
        //
        // B3 v2 (§6) — additive late-reversal seam. For dispute-created /
        // refunded events we additionally probe whether this reverses a
        // PREVIOUSLY-CLEARED dunning payment and, if so, open a compressed
        // cycle. No-op while FEATURE_DUNNING_V2 is off; fire-and-forget so it
        // never alters the v1 refund/dispute result. The v2 service applies
        // the one-active-cycle-per-state guard (§6.4) so a dispute→refund
        // pair never double-opens.
        if (
          this.dunningV2 &&
          (event.type === 'charge.dispute.created' ||
            event.type === 'charge.refunded')
        ) {
          this.fireLateReversalProbe(event);
        }
        // Bank-Account Payouts v2 (spec §2.5) — additive routing branch on the
        // payout.* events. Fire-and-forget bookkeeping classification only;
        // no-op while FEATURE_BANK_PAYOUTS_V2 is off. Never alters the v1
        // refund/dispute/payout result below.
        if (
          this.payoutRouting &&
          (event.type === 'payout.paid' ||
            event.type === 'payout.failed' ||
            event.type === 'payout.canceled')
        ) {
          this.firePayoutRouting(event);
        }
        if (this.refundDispute) return this.refundDispute.handle(event, tx);
        return { claimed: false };
      default:
        return { claimed: false };
    }
  }

  /**
   * B3 v2 (§6) — fire-and-forget late-reversal probe. Extracts the charge /
   * PI id + reversal timestamp from the Stripe event and hands them to the v2
   * service, which applies the "previously cleared" + one-active-cycle guards.
   * Never throws into the webhook path; no-op while FEATURE_DUNNING_V2 is off.
   */
  private fireLateReversalProbe(event: StripeEvent): void {
    if (!this.dunningV2) return;
    const obj = event.data.object as {
      id?: string;
      charge?: string | null;
      payment_intent?: string | null;
      created?: number | null;
    };
    // For charge.refunded the object IS the charge; for dispute.created the
    // object is the dispute carrying a `charge` ref.
    const chargeId =
      event.type === 'charge.refunded' ? (obj.id ?? null) : (obj.charge ?? null);
    const reversedAt =
      typeof obj.created === 'number'
        ? new Date(obj.created * 1000)
        : new Date();
    void this.dunningV2
      .detectAndHandleLateReversal({
        chargeId,
        paymentIntentId: obj.payment_intent ?? null,
        reversedChargeAt: reversedAt,
      })
      .catch((err) =>
        this.logger.warn(
          `dunningV2.detectAndHandleLateReversal failed: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * Bank-Account Payouts v2 (spec §2.5) — fire-and-forget payout routing.
   * Extracts the connected-account id + payout id from the Stripe payout event
   * and hands them to the router, which resolves the coach's effective
   * PayoutMethod.kind and the bookkeeping fee tier. The router NEVER moves
   * money (Stripe already did) and no-ops while FEATURE_BANK_PAYOUTS_V2 is off.
   * Never throws into the webhook path.
   */
  private firePayoutRouting(event: StripeEvent): void {
    if (!this.payoutRouting) return;
    const obj = event.data.object as {
      id?: string;
      account?: string | null;
    };
    void this.payoutRouting
      .routePayoutWebhook({
        connectedAccountId: obj.account ?? null,
        payoutId: obj.id ?? '',
        eventType: event.type,
      })
      .catch((err) =>
        this.logger.warn(
          `payoutRouting.routePayoutWebhook failed: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * PR-9 — fire-and-forget drop alerts captured during the most recent
   * fan-out for the given purchase. Called by BillingService AFTER the
   * outer $transaction commits. Failure-isolated by the fanout service
   * (never throws). No-op when no alerts are pending.
   */
  flushDripAlerts(purchaseId: string): void {
    this.fanout?.flushAlerts(purchaseId);
  }

  /**
   * PR-9 — discard alerts staged for a purchase whose outer tx rolled
   * back. Called by BillingService in the catch block so a Stripe
   * retry doesn't double-alert when the next attempt commits.
   */
  discardPendingDripAlerts(purchaseId: string): void {
    this.fanout?.discardPendingAlerts(purchaseId);
  }

  /**
   * PR-18 B1 — resolve any Stripe HTTP state the handler will need INSIDE
   * BillingService's outer $transaction, run BEFORE that transaction opens.
   *
   * The invoice-renewal path (`invoice.paid` / `invoice.payment_succeeded`)
   * resyncs the subscription via `stripeConnect.retrieveSubscription`. Doing
   * that inside the outer tx would hold the Postgres connection across a
   * Stripe round-trip (the A276-P1-3 anti-pattern) AND across the
   * CoachPackage FOR UPDATE lock the activation takes. BillingService calls
   * this before opening its tx and threads the result through
   * `handle(event, tx, prefetched)`, mirroring `preResolveReceiptUrl`.
   *
   * Best-effort: a Stripe blip returns `invoiceSubscription: null` and the
   * handler degrades cleanly (the renewal simply isn't resynced on this
   * delivery). Never throws — a failure here must not roll back the dedup row.
   */
  async prefetchForOuterTx(
    event: StripeEvent,
  ): Promise<CheckoutWebhookPrefetch> {
    // PR-18 B1 R3 P1 — checkout.session.completed / payment_intent.succeeded
    // activate a one-time (or first-invoice) purchase and then post the
    // head-coach split. That split posting resolves the parent Stripe charge
    // id via stripe.retrievePaymentIntent and may immediately attempt the
    // transfer (stripe.createTransfer) — both Stripe HTTP. To keep those out
    // of BillingService's outer $transaction (and out from under the
    // CoachPackage FOR UPDATE lock the activation takes), we resolve the
    // charge id HERE, before the tx opens. The handler then defers the whole
    // split posting to post-commit using this pre-resolved id, so the in-tx
    // path performs zero Stripe HTTP.
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'payment_intent.succeeded'
    ) {
      return this.prefetchChargeIdForActivation(event);
    }
    if (event.type === 'payment_intent.payment_failed') {
      return this.prefetchFailedPaymentIntentStatus(event);
    }
    if (event.type === 'setup_intent.succeeded') {
      return { trialCard: await this.attachNativeTrialCard(event) };
    }
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated'
    ) {
      return this.prefetchSubscriptionAuthority(event);
    }
    if (event.type === 'invoice.payment_failed') {
      return this.prefetchFailedInvoice(event);
    }
    if (
      event.type !== 'invoice.paid' &&
      event.type !== 'invoice.payment_succeeded'
    ) {
      return {};
    }
    const inv = event.data.object as { subscription?: string | null };
    if (!inv?.subscription) return {};
    // Only pre-resolve when this invoice maps to a package purchase we own;
    // otherwise the SaaS-coach-subscription path (BillingService) handles it
    // and we avoid a needless Stripe call.
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return {};
    const invoiceRevision = lifecycleRevision(purchase);
    try {
      const invoiceSubscription = await this.stripeConnect.retrieveSubscription(
        inv.subscription,
      );
      return { invoiceSubscription, invoiceRevision };
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: retrieveSubscription failed for sub=${inv.subscription} error=${errorLabel(err)}`,
      );
      return { invoiceSubscription: null };
    }
  }

  /**
   * B-680-1 — Stripe does not deliver events in order and retries failed
   * deliveries for days, so a subscription event's payload may be older than
   * the purchase. For a package purchase read the live subscription here,
   * before the outer tx (no Stripe HTTP in it), with the purchase's revision
   * read first. Not ours (no row, no package metadata) = no read.
   */
  private async prefetchSubscriptionAuthority(
    event: StripeEvent,
  ): Promise<CheckoutWebhookPrefetch> {
    const obj = event.data.object as { id?: unknown; metadata?: Record<string, string> | null };
    if (typeof obj.id !== 'string') return {};
    const meta = obj.metadata ?? {};
    try {
      let row = await this.prisma.clientPurchase.findUnique({
        where: { stripe_subscription_id: obj.id },
      });
      if (!row && typeof meta.tgp_purchase_id === 'string') {
        row = await this.prisma.clientPurchase.findUnique({ where: { id: meta.tgp_purchase_id } });
      }
      if (!row && typeof meta.tgp_package_id !== 'string') return {};
      // Expanded first invoice: the metadata bind (C-680-4) takes its
      // PaymentIntent id from here; webhook payloads carry only the id.
      const sub = await this.stripeConnect.retrieveSubscriptionForCheckout(obj.id);
      return { subscriptionAuthority: { sub, revision: row ? lifecycleRevision(row) : null } };
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: subscription read failed sub=${obj.id} error=${errorLabel(err)}`,
      );
      return { subscriptionAuthority: null };
    }
  }

  /**
   * B-680-2 — the live invoice and subscription an invoice.payment_failed
   * event names, read before the outer tx, after the purchase's write
   * version: a failure delivered after the invoice was paid (or voided), after
   * a newer invoice, or after the subscription ended must never open dunning,
   * and a payment that lands after these reads is seen under the lock.
   */
  private async prefetchFailedInvoice(event: StripeEvent): Promise<CheckoutWebhookPrefetch> {
    const inv = event.data.object as { id?: unknown; subscription?: unknown };
    if (typeof inv.id !== 'string' || typeof inv.subscription !== 'string') return {};
    try {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { stripe_subscription_id: inv.subscription },
        select: { id: true, updated_at: true, status: true },
      });
      if (!purchase) return {};
      const version = writeVersion(purchase);
      const [live, sub] = await Promise.all([
        this.stripeConnect.retrieveInvoice(inv.id),
        this.stripeConnect.retrieveSubscription(inv.subscription),
      ]);
      const latest: unknown = sub.latest_invoice;
      const latestId: unknown =
        latest && typeof latest === 'object' ? Reflect.get(latest, 'id') : latest;
      return {
        failedInvoiceStatus: typeof live.status === 'string' ? live.status : 'open',
        failedInvoiceAuthority: {
          version,
          purchaseStatus: purchase.status,
          subscriptionStatus: typeof sub.status === 'string' ? sub.status : null,
          latestInvoiceId: typeof latestId === 'string' ? latestId : null,
        },
      };
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: invoice read failed invoice=${inv.id} error=${errorLabel(err)}`,
      );
      return { failedInvoiceStatus: null };
    }
  }

  /**
   * B-654-1 — a native trial's SetupIntent succeeded (the client saved a
   * card in the PaymentSheet). Stripe does not reliably make that card the
   * subscription's default for a $0 trial, so set it here: the row is found
   * by the attempt's own SetupIntent metadata (B-679-10: R2 creates one when
   * Stripe made no pending SetupIntent; Stripe never ties it to the
   * subscription) or by the SetupIntent id (the prefix of the stored client
   * secret), and the write is idempotent per (subscription, card). Stripe
   * then sends customer.subscription.updated with the default and the trial
   * end lifted, which grants the trial through subscriptionGrantsAccess.
   * Runs before the outer tx (Stripe HTTP); never throws.
   */
  private async attachNativeTrialCard(
    event: StripeEvent,
  ): Promise<{ purchaseId: string | null; ok: boolean } | null> {
    const si = event.data.object as {
      id?: unknown;
      payment_method?: unknown;
      customer?: unknown;
      status?: unknown;
      metadata?: Record<string, unknown> | null;
    };
    if (typeof si.id !== 'string' || !si.id.startsWith('seti_')) return null;
    const paymentMethod = typeof si.payment_method === 'string' ? si.payment_method : null;
    const meta = si.metadata ?? {};
    const own =
      meta.tgp_checkout === 'native_subscription_trial' &&
      typeof meta.tgp_purchase_id === 'string' &&
      typeof meta.tgp_subscription_id === 'string'
        ? { id: meta.tgp_purchase_id, stripe_subscription_id: meta.tgp_subscription_id }
        : null;
    let row: ClientPurchase | null;
    try {
      row = own
        ? await this.prisma.clientPurchase.findFirst({
            where: { ...own, billing_type: 'recurring' },
          })
        : null;
      row ??= await this.prisma.clientPurchase.findFirst({
        where: {
          stripe_client_secret: { startsWith: `${si.id}_secret_` },
          billing_type: 'recurring',
          stripe_subscription_id: { not: null },
        },
      });
    } catch (err) {
      // B-654-1 (narrowed, Sol) — a failed lookup is NOT "no such attempt":
      // answering unclaimed would let BillingService mark the only saved-card
      // event processed with no card attached. Report it as a failed attach
      // so handle() throws, the outer tx rolls back and Stripe redelivers.
      this.logger.warn(`setup_intent.succeeded lookup failed si=${si.id} error=${errorLabel(err)}`);
      return { purchaseId: null, ok: false };
    }
    if (!row || !row.stripe_subscription_id) return null;
    if (
      typeof si.customer === 'string' &&
      row.stripe_customer_id &&
      si.customer !== row.stripe_customer_id
    ) {
      this.logger.warn(`setup_intent.succeeded customer mismatch purchase=${row.id}`);
      return null;
    }
    if (row.entitlement_active || row.trial_started_at || !paymentMethod) {
      return { purchaseId: row.id, ok: true };
    }
    try {
      const sub = await this.stripeConnect.retrieveSubscriptionForCheckout(row.stripe_subscription_id);
      // B-680-5 — a default Stripe set itself (save_default_payment_method
      // on_subscription) leaves the create-time end on: attach anyway, the
      // same write lifts it. Only the attempt's own card already on is done.
      if (sub.status === 'trialing' && !trialOwnCardOn(sub)) {
        await attachTrialCard(this.stripeConnect, sub.id, paymentMethod);
        this.logger.log(`billing.trial_card_attached purchase=${row.id} via=webhook`);
      }
      return { purchaseId: row.id, ok: true };
    } catch (err) {
      this.logger.warn(
        `setup_intent.succeeded trial card attach failed purchase=${row.id} error=${errorLabel(err)}`,
      );
      return { purchaseId: row.id, ok: false };
    }
  }

  /**
   * B-654-1 — claims a native trial's setup_intent.succeeded. The Stripe
   * write ran in prefetchForOuterTx; a failed write throws so the outer tx
   * rolls back (dedup row included) and Stripe redelivers the event.
   */
  private async applySetupIntentSucceeded(
    event: StripeEvent,
    tx: WebhookTx | undefined,
    prefetched: CheckoutWebhookPrefetch | undefined,
  ): Promise<CheckoutWebhookResult> {
    const trialCard =
      prefetched && prefetched.trialCard !== undefined
        ? prefetched.trialCard
        : tx
          ? null
          : await this.attachNativeTrialCard(event);
    if (!trialCard) return { claimed: false };
    if (!trialCard.ok) {
      throw new Error(
        trialCard.purchaseId
          ? `setup_intent.succeeded: trial card not attached for purchase=${trialCard.purchaseId}; redeliver`
          : 'setup_intent.succeeded: attempt lookup failed; redeliver',
      );
    }
    return { claimed: true, reason: 'native_trial_card_attached' };
  }

  /**
   * PR-18 B1 R3 P1 — resolve, out-of-tx, the Stripe charge id for the pending
   * purchase that a checkout.session.completed / payment_intent.succeeded
   * event will activate, so the post-commit split posting needs no Stripe HTTP
   * inside the outer $transaction. Best-effort and never throws — a null entry
   * means the split handler will no-op the transfer and the sweeper retries.
   */
  private async prefetchChargeIdForActivation(
    event: StripeEvent,
  ): Promise<CheckoutWebhookPrefetch> {
    const obj = event.data.object as {
      id?: string;
      payment_intent?: string | null;
      latest_charge?: string | { id?: string } | null;
      charges?: { data?: Array<{ id?: string }> };
    };
    try {
      let purchaseId: string | null = null;
      let paymentIntentId: string | null = null;
      // Charge id may already be on the event payload (PI events carry
      // latest_charge); prefer it to avoid a needless Stripe round-trip.
      let chargeId: string | null =
        (typeof obj.latest_charge === 'string' ? obj.latest_charge : null) ??
        (obj.latest_charge && typeof obj.latest_charge === 'object'
          ? obj.latest_charge.id ?? null
          : null) ??
        obj.charges?.data?.[0]?.id ??
        null;

      if (event.type === 'checkout.session.completed') {
        if (!obj.id) return {};
        const purchase = await this.prisma.clientPurchase.findUnique({
          where: { stripe_checkout_session_id: obj.id },
          select: { id: true, stripe_payment_intent_id: true },
        });
        if (!purchase) return {};
        purchaseId = purchase.id;
        paymentIntentId =
          obj.payment_intent ?? purchase.stripe_payment_intent_id ?? null;
      } else {
        // payment_intent.succeeded
        if (!obj.id) return {};
        // B-661-1 / B-661-5 (Opus): the same rows applyPaymentIntentSucceeded
        // activates.
        const purchase = await this.prisma.clientPurchase.findFirst({
          where: { stripe_payment_intent_id: obj.id, status: { in: PI_SUCCEEDED_CLAIMABLE } },
          select: { id: true, status: true, stripe_checkout_session_id: true },
        });
        if (!purchase || !activatesOnPaymentIntentSuccess(purchase, obj.id)) return {};
        purchaseId = purchase.id;
        paymentIntentId = obj.id;
      }

      // Resolve the charge id from the PaymentIntent when the event payload
      // didn't already carry it. This is the ONLY Stripe HTTP in the path and
      // it runs BEFORE the outer tx opens.
      if (!chargeId && paymentIntentId) {
        const pi = await this.stripeConnect.retrievePaymentIntent(
          paymentIntentId,
        );
        chargeId =
          (typeof pi.latest_charge === 'string' ? pi.latest_charge : null) ??
          pi.charges?.data?.[0]?.id ??
          null;
      }
      return { chargeIdByPurchaseId: { [purchaseId]: chargeId } };
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: charge-id pre-resolution failed for ${event.type} ${obj.id ?? 'unknown'}: ${(err as Error).message}`,
      );
      return {};
    }
  }

  /**
   * B-661-3 — resolve, out-of-tx, Stripe's current status of the PaymentIntent
   * a payment_intent.payment_failed names, but only when the purchase it
   * matches already settled (failureNeedsProviderStatus). Never throws: a
   * failed lookup returns null and the handler then throws inside the tx so
   * Stripe redelivers.
   */
  private async prefetchFailedPaymentIntentStatus(
    event: StripeEvent,
  ): Promise<CheckoutWebhookPrefetch> {
    const pi = event.data.object as { id?: string };
    if (!pi?.id) return {};
    let seen: PurchaseVersion | null;
    try {
      const purchase = await this.prisma.clientPurchase.findFirst({
        where: { stripe_payment_intent_id: pi.id },
        select: { id: true, status: true },
      });
      if (!purchase || !failureNeedsProviderStatus(purchase.status)) return {};
      // Read BEFORE asking Stripe: the status Stripe returns is at least as
      // new as this version of the purchase (round 4; xmin since round 5).
      seen = await this.readPurchaseVersion(this.prisma, purchase.id, false);
      // No version, no Stripe call: the decline is retried in its tx.
      if (!seen) return {};
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: purchase lookup failed for payment_intent.payment_failed ${pi.id} (${errorTag(err)})`,
      );
      return {};
    }
    return {
      paymentIntentStatusById: { [pi.id]: await this.lookUpPaymentIntentStatus(pi.id) },
      paymentIntentWitnessById: { [pi.id]: seen },
    };
  }

  // Stripe's current status of a PaymentIntent; null when it cannot be read
  // now, PI_STATUS_UNREADABLE when Stripe says it never can be (C-661-6).
  // C-661-8: only 404 (no such PaymentIntent) and 400 (malformed request)
  // are permanent. 401/403 (a revoked or rotated key), 429, 5xx and network
  // errors are retried: Stripe redelivers the decline after the key is fixed.
  private async lookUpPaymentIntentStatus(paymentIntentId: string): Promise<string | null> {
    try {
      const current = await this.stripeConnect.retrievePaymentIntent(paymentIntentId);
      return typeof current.status === 'string' ? current.status : null;
    } catch (err) {
      const permanent =
        err instanceof StripeConnectApiError && (err.httpStatus === 404 || err.httpStatus === 400);
      if (permanent) {
        this.logger.error(
          `PaymentIntent ${paymentIntentId} cannot be read (${errorTag(err)}): its payment_intent.payment_failed is not applied`,
        );
        return PI_STATUS_UNREADABLE;
      }
      this.logger.warn(
        `PaymentIntent status lookup failed for ${paymentIntentId} (${errorTag(err)}): Stripe redelivers`,
      );
      return null;
    }
  }

  // B-661-3 (round 5): the version of one purchase row (see PurchaseVersion).
  // `lock` (inside a transaction) also holds the row until that transaction
  // ends (FOR NO KEY UPDATE: returns the newest committed version and blocks
  // every UPDATE/DELETE, never another connection's FK check, C-661-11).
  // A client without raw SQL (minimal test doubles) cannot prove a version:
  // null, and the caller retries instead of guessing.
  private async readPurchaseVersion(
    db: WebhookTx | PrismaService,
    purchaseId: string,
    lock: boolean,
  ): Promise<PurchaseVersion | null> {
    if (typeof (db as { $queryRaw?: unknown }).$queryRaw !== 'function') return null;
    const rows = lock
      ? await db.$queryRaw<
          PurchaseVersionRow[]
        >`SELECT status, xmin::text AS row_version FROM "ClientPurchase" WHERE id = ${purchaseId} FOR NO KEY UPDATE`
      : await db.$queryRaw<
          PurchaseVersionRow[]
        >`SELECT status, xmin::text AS row_version FROM "ClientPurchase" WHERE id = ${purchaseId}`;
    const row = rows[0];
    return row ? { purchase_id: purchaseId, status: row.status, row_version: row.row_version } : null;
  }

  // B-661-8 (round 5): hold every purchase of a PaymentIntent until the
  // webhook transaction ends, BEFORE reading them. A refund, dispute,
  // cancel, deletion or decline that committed first is seen by the read
  // that follows; one that comes later waits and applies to what this
  // transaction wrote. Skipped for clients without raw SQL (test doubles);
  // the compare-and-set writes still fence those.
  private async lockPurchasesOfPaymentIntent(tx: WebhookTx, paymentIntentId: string): Promise<void> {
    if (typeof (tx as { $queryRaw?: unknown }).$queryRaw !== 'function') return;
    await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "ClientPurchase" WHERE stripe_payment_intent_id = ${paymentIntentId} FOR NO KEY UPDATE`;
  }

  // B-661-3 (round 5): a purchase was activated once when its PurchaseFanout
  // row exists (written in the activation's own transaction, never deleted
  // while the purchase exists). A client without that model (minimal test
  // doubles) has no activation record: false.
  private async wasActivated(db: WebhookTx | PrismaService, purchaseId: string): Promise<boolean> {
    if (!(db as { purchaseFanout?: unknown }).purchaseFanout) return false;
    const fanout = await db.purchaseFanout.findUnique({
      where: { purchase_id: purchaseId },
      select: { id: true },
    });
    return !!fanout;
  }

  // B-661-8 (round 5): a success write names the state it was decided for.
  // When the row changed first (a refund, dispute, cancel, deletion, ...),
  // Prisma finds no row (P2025): the webhook transaction rolls back and
  // Stripe redelivers; the redelivery reads the new state, which wins.
  private async writeIfUnchanged<T>(paymentIntentId: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (!isRecordNotFound(err)) throw err;
      this.logger.warn(
        `payment_intent.succeeded ${paymentIntentId}: purchase changed before the write; Stripe redelivers`,
      );
      throw successRetryLater('purchase_changed', paymentIntentId);
    }
  }

  private async applyCheckoutCompleted(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const session = event.data.object as {
      id?: string;
      payment_intent?: string | null;
      subscription?: string | null;
      customer?: string | null;
      metadata?: Record<string, string>;
      mode?: string;
      status?: string;
    };
    if (!session?.id) return { claimed: false, reason: 'no_session_id' };

    // Use the outer tx for the read so we see uncommitted state from the
    // same transaction (e.g. a row inserted by a prior handler step) and
    // so any racing event delivery serialises on the row's tx lock.
    const db: WebhookTx | PrismaService = tx ?? this.prisma;

    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_checkout_session_id: session.id },
    });
    if (!purchase) {
      // Not one of ours.
      return { claimed: false, reason: 'no_matching_purchase' };
    }
    // C-661-7: activation happens once. A late completion never re-activates
    // a purchase that is already paid or that a refund, dispute, cancel,
    // expiry or account deletion ended. (A recurring purchase may already be
    // `active` from a subscription event that arrived first; its fanout and
    // split still run here.)
    if (CHECKOUT_NEVER_REACTIVATES.includes(purchase.status)) {
      this.logger.log(
        `checkout.session.completed: purchase=${purchase.id} not activated again (status=${purchase.status})`,
      );
      return { claimed: true, purchase_id: purchase.id, reason: 'already_progressed' };
    }
    // B-661-3 (round 5): a purchase that was activated and then ended by a
    // real failure of its payment comes back only through the success of
    // that PaymentIntent (recovery), never through a second activation. A
    // purchase a decline marked failed before its checkout completed (never
    // activated) is activated here as usual.
    if (purchase.status === 'payment_failed' && (await this.wasActivated(db, purchase.id))) {
      this.logger.log(
        `checkout.session.completed: purchase=${purchase.id} not activated again (activated before, status=payment_failed)`,
      );
      return { claimed: true, purchase_id: purchase.id, reason: 'already_progressed' };
    }

    const pkg = await db.coachPackage.findUnique({
      where: { id: purchase.package_id },
    });

    const isRecurring = session.mode === 'subscription' || !!session.subscription;
    const newStatus = isRecurring ? 'active' : 'paid';

    const accessExpiresAt = this.computeAccessExpiry(pkg, purchase, isRecurring, null);

    // B1 pricing-lock serialization (PR-18). Before flipping this purchase
    // to entitlement_active=true, take the SAME CoachPackage row lock that
    // PackagesService.update() takes (`SELECT id ... FOR UPDATE`). The
    // pricing-lock transaction counts active recurring buyers under that
    // row lock; if a recurring activation could commit WITHOUT touching the
    // package row, the count could miss it and a price edit could slip past
    // the guard. Taking the package-row lock here forces the two operations
    // to serialize on the package row: whichever transaction acquires the
    // lock first runs to completion, and the other blocks until commit and
    // then observes the committed state (the activation sees the price
    // edit, or the price edit's count sees the now-active buyer and locks).
    // No deadlock: every path acquires the SAME single row lock and never a
    // second one, so there is no lock-ordering cycle.
    const updated = await this.activateUnderPackageLock(
      tx,
      purchase.package_id,
      (client) =>
        client.clientPurchase.update({
          // C-661-7: a refund, cancel or deletion that commits after the read
          // above fails this write; the event rolls back and its redelivery
          // sees the new status.
          where: { id: purchase.id, status: { notIn: CHECKOUT_NEVER_REACTIVATES } },
          data: {
            status: newStatus,
            entitlement_active: true,
            stripe_payment_intent_id: session.payment_intent ?? null,
            stripe_subscription_id: session.subscription ?? null,
            stripe_customer_id: session.customer ?? purchase.stripe_customer_id,
            access_expires_at: accessExpiresAt,
            last_error: null,
          },
        }),
    );

    // Roman P4 (Option C) — first-payment notification. Runs AFTER the status
    // flip to a successful terminal status, on the SAME outer tx so the
    // exactly-once ledger row commits-or-rolls-back with this purchase
    // (50-Failures #44). Gated on FEATURE_ROMAN_FIRST_PAYMENT (default OFF).
    await this.maybeEmitFirstPayment(updated, tx, event.id);

    // Phase 4 — materialize ledger + post head-coach transfer now that
    // the charge has actually succeeded.
    //
    // PR-18 B1 R3 P1: PurchaseSplitHandlerService.onChargeSucceeded() can
    // synchronously call Stripe (retrievePaymentIntent to resolve the charge
    // id AND transfers.attempt() which POSTs a Transfer). When BillingService
    // holds an outer $transaction (it took the CoachPackage FOR UPDATE lock
    // via activateUnderPackageLock above), running that Stripe HTTP inline
    // would hold the Postgres connection — and the package row lock — across
    // the round-trip (the A276-P1-3 anti-pattern, made worse by B1's lock).
    // So when a tx is held we DEFER the split posting to post-commit and
    // return a descriptor; BillingService runs it after the tx commits, using
    // the charge id we pre-resolved out-of-tx in prefetchForOuterTx. When no
    // outer tx is held (legacy/test path) we run it inline against
    // `this.prisma` exactly as before — that path never holds a tx so it is
    // already free of the in-tx-HTTP hazard.
    const deferredSplit = await this.runOrDeferSplit(updated, tx, prefetched);

    // PR-9 — fan-out (drop seed + immediate inline materialisation) INSIDE
    // the outer tx so entitlement + content commit-or-rollback together.
    // A resolver failure here re-throws and rolls the whole event back;
    // Stripe retries; the StripeProcessedEvent dedup + PurchaseFanout
    // @unique + ScheduledDrop @@unique + per-resolver uniques (PR-7)
    // make the retry safe.
    //
    // Legacy callers (test wiring without a real $transaction) still
    // get an idempotent PurchaseFanout row via the @unique guard but
    // skip the drop seed.
    if (this.fanout && tx) {
      await this.fanout.onPurchaseEntitled(
        updated,
        {
          entrypoint: 'in_app_hosted',
          coachId: updated.coach_user_id,
          clientId: updated.client_user_id,
          purchaseTime: new Date(),
        },
        tx,
      );
    } else if (this.fanout) {
      // No outer tx (legacy/test path) — record the idempotency row only.
      try {
        await this.fanout.onPurchaseEntitled(
          updated,
          {
            entrypoint: 'in_app_hosted',
            coachId: updated.coach_user_id,
            clientId: updated.client_user_id,
          },
          this.prisma as unknown as WebhookTx,
        );
      } catch (err) {
        this.logger.warn(
          `Fanout seam failed for purchase=${updated.id} (no-tx legacy path): ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id, deferredSplit };
  }

  /**
   * PR-18 B1 R3 P1 — run the head-coach split posting for a just-activated
   * purchase, or DEFER it to post-commit when an outer $transaction is held.
   *
   * onChargeSucceeded resolves the parent Stripe charge id (retrievePaymentIntent)
   * and may immediately post the head-coach Transfer (createTransfer) — both
   * Stripe HTTP. Doing that while the caller's outer tx (and the CoachPackage
   * FOR UPDATE lock) is open holds the Postgres connection across a Stripe
   * round-trip. So:
   *   - tx held  → return a DeferredSplitTask carrying the pre-resolved charge
   *     id; BillingService.runDeferredSplit runs the posting AFTER commit.
   *   - no tx    → run inline against this.prisma exactly as before (legacy /
   *     sweeper / unit-test path; no lock held, so safe).
   * Returns the descriptor when deferred, otherwise undefined.
   */
  private async runOrDeferSplit(
    purchase: ClientPurchase,
    tx: WebhookTx | undefined,
    prefetched: CheckoutWebhookPrefetch | undefined,
    extra?: { invoice_amount_cents?: number; invoice_charge_id?: string | null },
  ): Promise<DeferredSplitTask | undefined> {
    if (!this.splits) return undefined;
    // Pre-resolved (out-of-tx) charge id for this purchase, when available.
    const preChargeId =
      extra?.invoice_charge_id ??
      prefetched?.chargeIdByPurchaseId?.[purchase.id] ??
      null;
    if (tx) {
      // Defer: do NOT touch Stripe while the outer tx / package lock is held.
      return {
        purchase,
        charge_id: preChargeId,
        invoice_amount_cents: extra?.invoice_amount_cents,
      };
    }
    // No outer tx — safe to post inline (legacy/sweeper/test path).
    try {
      await this.splits.onChargeSucceeded({
        purchase,
        invoice_amount_cents: extra?.invoice_amount_cents,
        invoice_charge_id: preChargeId ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Split posting failed for purchase=${purchase.id}: ${(err as Error).message}`,
      );
    }
    return undefined;
  }

  /**
   * PR-18 B1 R3 P1 — execute a split posting that applyCheckoutCompleted /
   * applyPaymentIntentSucceeded / applyInvoicePaid deferred because the caller
   * held an outer $transaction. Called by BillingService AFTER that tx commits
   * (so the package row lock is released and no DB tx is open across the Stripe
   * round-trip). The pre-resolved charge id is threaded as invoice_charge_id so
   * onChargeSucceeded does NOT re-issue retrievePaymentIntent. Failure-isolated:
   * the split ledger is idempotent and the transfer is idempotency-keyed +
   * sweeper-backed, so a thrown error here is logged, not propagated (money
   * must never depend on a post-commit best-effort hook).
   */
  async runDeferredSplit(task: DeferredSplitTask): Promise<void> {
    if (!this.splits) return;
    try {
      await this.splits.onChargeSucceeded({
        purchase: task.purchase,
        invoice_amount_cents: task.invoice_amount_cents,
        invoice_charge_id: task.charge_id ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Deferred split posting failed for purchase=${task.purchase.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * S-FEE round 6 (C-627-7) — deliver a charge's payout notices after
   * BillingService committed its webhook transaction. Never throws; the
   * notice sweeper is the backstop.
   */
  async deliverPayoutNotices(chargeId: string): Promise<void> {
    if (!this.refundDispute) return;
    await this.refundDispute.deliverPayoutNotices(chargeId);
  }

  /**
   * S-FEE — settle a guest-storefront purchase after BillingService committed
   * its conversion. Never throws; the settlement sweeper is the backstop.
   */
  async settleGuestPurchase(paymentIntentId: string): Promise<void> {
    if (!this.splits) return;
    await this.splits.settleGuestPurchaseByPaymentIntent(paymentIntentId);
  }

  private async applyCheckoutExpired(event: StripeEvent): Promise<CheckoutWebhookResult> {
    const session = event.data.object as { id?: string };
    if (!session?.id) return { claimed: false, reason: 'no_session_id' };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_checkout_session_id: session.id },
    });
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };
    if (purchase.status !== 'pending') {
      // Don't override a paid/active row with expired.
      return { claimed: true, purchase_id: purchase.id, reason: 'already_progressed' };
    }
    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'expired',
        entitlement_active: false,
        ...CLEARED_PAYMENT_SECRETS,
      },
    });
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applySubscriptionUpdated(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const payload = event.data.object as SubscriptionSnapshot;
    if (!payload?.id) return { claimed: false, reason: 'no_sub_id' };
    // B-680-1 — the live subscription read before the tx is the authority;
    // the payload may be older than the purchase. Unknown = redeliver.
    const authority = prefetched?.subscriptionAuthority;
    if (authority === null) {
      throw new Error(`${event.type}: subscription ${payload.id} unreadable on Stripe; redeliver`);
    }
    const live = authority && authority.sub.id === payload.id ? authority : undefined;
    const sub: SubscriptionSnapshot = live ? live.sub : payload;
    const subId = payload.id;

    // PR-18 B1 — use the caller's outer tx for reads/writes when provided so
    // the entitlement activation (and its CoachPackage row lock) commit-or-
    // rollback together with the StripeProcessedEvent dedup row instead of
    // committing independently via a nested $transaction.
    const db: WebhookTx | PrismaService = tx ?? this.prisma;

    // Claim only if this subscription corresponds to a known package
    // purchase. SaaS coach subscriptions are tracked in CoachSubscription
    // via BillingService; this handler stays out of those.
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: subId },
    });
    if (!purchase) {
      // Heuristic 2: metadata may carry binding fields if the subscription
      // was minted by our checkout but the webhook arrived before the
      // checkout.session.completed event populated the FK.
      // Require all binding identifiers from metadata before claiming.
      // Matching only on package_id risks cross-binding two clients who bought
      // the same package in a short window.
      const pkgIdFromMeta = sub.metadata?.tgp_package_id;
      const clientIdFromMeta = sub.metadata?.tgp_client_user_id;
      const coachIdFromMeta = sub.metadata?.tgp_coach_user_id;
      const customerIdFromMeta =
        typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;

      if (!pkgIdFromMeta || !clientIdFromMeta || !coachIdFromMeta || !customerIdFromMeta) {
        this.logger.warn(
          `applySubscriptionUpdated: missing binding metadata on sub ${subId} — skipping fallback`,
        );
        return { claimed: false, reason: 'missing_binding_metadata' };
      }

      // B-RECUR-3 (B-654-5) — a native checkout subscription names its own
      // attempt (metadata.tgp_purchase_id): bind exactly that row, never a
      // newer pending attempt of the same package.
      const purchaseIdFromMeta = sub.metadata?.tgp_purchase_id;
      const pending = await db.clientPurchase.findFirst({
        where: {
          ...(purchaseIdFromMeta ? { id: purchaseIdFromMeta } : {}),
          package_id: pkgIdFromMeta,
          client_user_id: clientIdFromMeta,
          coach_user_id: coachIdFromMeta,
          stripe_customer_id: customerIdFromMeta,
          status: 'pending',
          stripe_subscription_id: null,
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false, reason: 'no_pending_purchase_for_metadata' };

      // C-680-4 — a native attempt binds as the checkout binds it: session id
      // = subscription id (what isUnpaidNativeAttempt reads), plus the first
      // invoice's PaymentIntent when Stripe sent it expanded.
      const piId = firstInvoicePaymentIntentId(sub.latest_invoice);
      const nativeBind = purchaseIdFromMeta
        ? {
            stripe_checkout_session_id: subId,
            ...(piId && !pending.stripe_payment_intent_id ? { stripe_payment_intent_id: piId } : {}),
          }
        : {};
      // Use updateMany with the same where clause to guard against races —
      // only one concurrent call can win the stripe_subscription_id: null check.
      const bound = await db.clientPurchase.updateMany({
        where: {
          id: pending.id,
          stripe_subscription_id: null,
        },
        data: { stripe_subscription_id: subId, ...nativeBind },
      });
      if (bound.count === 0) {
        // Another event already claimed this row.
        this.logger.warn(
          `applySubscriptionUpdated: race-lost binding for purchase ${pending.id}`,
        );
        return { claimed: false, reason: 'race_lost' };
      }
      return this.applySubscriptionUpdated(event, tx, prefetched);
    }

    const pkg = await db.coachPackage.findUnique({
      where: { id: purchase.package_id },
    });

    const status = this.normalizeSubscriptionStatus(sub.status);
    const currentPeriodEnd = this.toDate(sub.current_period_end);
    const canceledAt = this.toDate(sub.canceled_at);

    const accessExpiresAt = this.computeAccessExpiry(
      pkg,
      purchase,
      true,
      currentPeriodEnd,
    );

    // B1 pricing-lock serialization (PR-18). This path can flip
    // entitlement_active=true for a recurring purchase (active/trialing/
    // past_due), so it must serialize against PackagesService.update()'s
    // CoachPackage row lock. We take the same `SELECT id ... FOR UPDATE`
    // before the update. See applyCheckoutCompleted for the full argument.
    // When BillingService threads its outer tx through handle(event, tx) the
    // lock + activation run on that tx (no nested $transaction); otherwise
    // the helper opens its own short $transaction.
    // B-680-1 — the deletion takes the same lock, and the decision is made
    // on the purchase as it is under the lock, never on the earlier read.
    const outcome = await this.activateUnderPackageLock(tx, purchase.package_id, async (client) => {
      const fresh = (await this.lockPurchase(client, purchase.id)) ?? purchase;
      if (STRIPE_ENDED_STATUSES.has(status)) {
        await this.endSubscriptionPurchase(
          fresh,
          sub,
          status === 'incomplete_expired' ? 'incomplete_expired' : 'canceled',
          client,
        );
        return { skipped: 'subscription_ended' };
      }
      if (purchaseHasEnded(fresh)) return { skipped: 'subscription_already_ended' };
      // R-DISPUTE-PAUSE: a plan a dispute paused stays without access whatever
      // Stripe's status (pause_collection keeps it `active`); read under the
      // purchase lock, which the pause and the coach restart also take.
      const entitled =
        subscriptionGrantsAccess(fresh, sub) && !(await this.disputePaused(client, fresh.id));
      if (live && live.revision !== null && lifecycleRevision(fresh) !== live.revision) {
        // Another delivery wrote the purchase after the Stripe read: a
        // matching state needs no write, anything else is read again.
        const same =
          fresh.status === status &&
          fresh.entitlement_active === entitled &&
          !!fresh.cancel_at_period_end === !!sub.cancel_at_period_end;
        if (same) return { skipped: 'subscription_unchanged' };
        throw new WebhookRedeliverError(
          `${event.type}: purchase=${fresh.id} changed during the Stripe read; redeliver`,
        );
      }
      // Stripe never returns a subscription to incomplete: a late snapshot
      // never revokes a paid or started plan.
      if ((status === 'incomplete' || status === 'pending') && purchaseLeftIncomplete(fresh)) {
        return { skipped: 'stale_incomplete_snapshot' };
      }
      const updated = await client.clientPurchase.update({
        where: { id: fresh.id },
        data: {
          status,
          entitlement_active: entitled,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          current_period_end: currentPeriodEnd,
          canceled_at: canceledAt,
          access_expires_at: accessExpiresAt,
          ...trialStartPatch(fresh, sub, entitled),
          // B-661-14/15 — a grant means the sheet's intent was paid or its card saved: erase both.
          ...(entitled ? CLEARED_PAYMENT_SECRETS : {}),
          updated_at: nextVersion(fresh),
        },
      });
      return { updated, firstGrant: entitled && !fresh.entitlement_active };
    });
    if ('skipped' in outcome) {
      return { claimed: true, purchase_id: purchase.id, reason: outcome.skipped };
    }
    // B-RECUR — first grant of a native subscription (a trial whose card was
    // just saved, or a first invoice whose subscription event won the race
    // with invoice.paid): seed content. Idempotent.
    if (outcome.firstGrant && outcome.updated) {
      await this.onSubscriptionFirstEntitled(outcome.updated, tx);
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  /**
   * B-RECUR — content fan-out on a subscription purchase's FIRST entitlement.
   * Idempotent (PurchaseFanout @unique on purchase_id), so invoice.paid and
   * customer.subscription.updated may both call this in either order. The
   * coach's first-payment notice is money, not access (B-680-3): only
   * invoice.paid with an amount sends it (maybeEmitInvoicePayment).
   */
  private async onSubscriptionFirstEntitled(
    purchase: ClientPurchase,
    tx: WebhookTx | undefined,
  ): Promise<void> {
    if (!this.fanout) return;
    if (tx) {
      await this.fanout.onPurchaseEntitled(
        purchase,
        {
          entrypoint: 'in_app_ps',
          coachId: purchase.coach_user_id,
          clientId: purchase.client_user_id,
          purchaseTime: new Date(),
        },
        tx,
      );
      return;
    }
    try {
      await this.fanout.onPurchaseEntitled(
        purchase,
        {
          entrypoint: 'in_app_ps',
          coachId: purchase.coach_user_id,
          clientId: purchase.client_user_id,
        },
        this.prisma,
      );
    } catch (err) {
      this.logger.warn(
        `Fanout seam failed for purchase=${purchase.id} (no-tx subscription path) error=${errorLabel(err)}`,
      );
    }
  }

  /**
   * B-680-3 — the coach's first-payment notice for a native subscription,
   * sent from the invoice that collected money, with the amount and currency
   * Stripe collected (a combo's first invoice includes its one-time part). A
   * trial's card save or a $0 invoice never consumes it. Same outer tx as the
   * purchase write. A coach who already has the notice is skipped before the
   * insert, so renewals never hit the ledger's unique constraint.
   */
  private async maybeEmitInvoicePayment(
    purchase: ClientPurchase,
    inv: { amount_paid?: number; currency?: string | null },
    tx: WebhookTx | undefined,
    correlationId: string,
  ): Promise<void> {
    if (process.env.FEATURE_ROMAN_FIRST_PAYMENT !== 'true') return;
    if (!this.coachFirstPaymentService || !tx) return;
    // Hosted checkouts send theirs from checkout.session.completed.
    if (purchase.stripe_checkout_session_id !== purchase.stripe_subscription_id) return;
    const amount = inv.amount_paid;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return;
    const sent = await tx.coachFirstPaymentNotification.findUnique({
      where: { coachId: purchase.coach_user_id },
    });
    if (sent) return;
    await this.coachFirstPaymentService.tryEmitFirstPayment(tx, {
      coachId: purchase.coach_user_id,
      amount,
      currency: inv.currency ? inv.currency : purchase.currency,
      clientId: purchase.client_user_id,
      correlationId,
    });
  }

  private async applySubscriptionDeleted(
    event: StripeEvent,
    tx?: WebhookTx,
  ): Promise<CheckoutWebhookResult> {
    const sub = event.data.object as SubscriptionSnapshot;
    if (!sub?.id) return { claimed: false, reason: 'no_sub_id' };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: sub.id },
    });
    if (!purchase) return { claimed: false };
    // B-680-1 — under the package lock every grant takes, so a grant that
    // read Stripe before this deletion re-reads the ended purchase.
    await this.activateUnderPackageLock(tx, purchase.package_id, async (client) => {
      const fresh = (await this.lockPurchase(client, purchase.id)) ?? purchase;
      await this.endSubscriptionPurchase(fresh, sub, 'canceled', client);
    });
    return { claimed: true, purchase_id: purchase.id };
  }

  /**
   * B-RECUR-BE R1-8 / B-680-1 — a subscription ended on Stripe (deleted, or
   * updated to canceled / incomplete_expired). Access ends; an abandoned
   * native attempt (never paid, trial never started) ends as 'expired' or
   * 'incomplete_expired' so churn, LTV and plan-list readers, which key on
   * 'canceled', never count a checkout nobody completed. A purchase that
   * already ended keeps its status.
   */
  private async endSubscriptionPurchase(
    purchase: ClientPurchase,
    sub: SubscriptionSnapshot,
    endedAs: 'canceled' | 'incomplete_expired',
    client: WebhookTx,
  ): Promise<void> {
    // Capture pre-revocation entitlement so we know whether this purchase
    // was actually serving content — only entitled purchases have drops
    // worth canceling (cancelPendingForPurchase is still safe for
    // never-entitled purchases — its WHERE clause returns count=0 — but
    // skipping the call avoids noise in the logs).
    const wasEntitled = !!purchase.entitlement_active;
    // B-680-4 — a trial whose card was saved (Stripe shows trial_start and
    // the attempt's own card, B-680-5) was used even when no grant event
    // arrived first.
    const trial =
      typeof sub.trial_start === 'number'
        ? trialStartPatch(purchase, sub, trialOwnCardOn(sub))
        : {};
    const unpaidAttempt = !trial.trial_started_at && isUnpaidNativeAttempt(purchase);
    const ending = purchaseHasEnded(purchase)
      ? {}
      : {
          status: endedAs === 'incomplete_expired' ? endedAs : unpaidAttempt ? 'expired' : 'canceled',
          canceled_at: this.toDate(sub.canceled_at) ?? new Date(),
        };
    await client.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        ...ending,
        entitlement_active: false,
        ...trial,
        // B-SECRETS-3 (#661): an ended subscription can never be paid through its
        // sheet again, so its cached credentials are erased whether or not it
        // was ever paid (supersedes the unpaid-attempt-only erase).
        ...CLEARED_PAYMENT_SECRETS,
      },
    });
    // PR-16 — cancel any not-yet-fired drops for this purchase. Runs in
    // the SAME outer $transaction as the entitlement flip (when caller
    // provides a tx) so revoke + cancel commit-or-rollback together.
    if (this.fanout && wasEntitled) {
      await this.fanout.cancelPendingForPurchase(purchase.id, 'subscription_canceled', client);
    }
    // DUNNING-V1 — explicitly terminate the dunning window so no further
    // cadence reminders fire after Stripe (or the customer) cancels.
    if (this.dunning) {
      try {
        await this.dunning.terminate(purchase.id, 'subscription_deleted');
      } catch (err) {
        this.logger.warn(
          `dunning.terminate failed purchase=${purchase.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  // B3: PaymentSheet flow path. CheckoutSession-completed already covers the
  // hosted-checkout case, but PaymentIntent (created via
  // /v1/checkout/payment-intent for the in-app PaymentSheet) never gets a
  // checkout.session.completed event — only payment_intent.succeeded. Without
  // this case the matching ClientPurchase row stays in `pending` forever.
  private async applyPaymentIntentSucceeded(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const pi = event.data.object as {
      id?: string;
      metadata?: Record<string, string>;
    };
    if (!pi?.id) return { claimed: false, reason: 'no_pi_id' };

    const db: WebhookTx | PrismaService = tx ?? this.prisma;

    // B-661-8 (round 5): lock this PaymentIntent's purchases before reading
    // them, so the state the decision below is made on stays the state the
    // write lands on.
    if (tx) await this.lockPurchasesOfPaymentIntent(tx, pi.id);

    // Only claim if a pending purchase row references this payment intent.
    // PaymentSheet flow creates a pending ClientPurchase with the PI id set
    // by checkout.service.ts createPaymentIntentForClient().
    // B-661-1 (Opus): a declined first attempt flips the row to
    // `payment_failed` (applyPaymentIntentFailed) while the PaymentIntent
    // stays payable; the client's in-sheet retry of the SAME PaymentIntent
    // then succeeds. That success is claimed too, so the client who paid is
    // entitled, the split is posted and the credentials are erased.
    // B-661-3 (Sol, rounds 5-7): a one-time purchase that was activated and then ended by a real
    // failure of this PaymentIntent (e.g. a hosted checkout that completed while an asynchronous
    // payment was processing) is recovered by this success: access comes back, nothing runs twice.
    // Selected by its activation record inside the query, so no number of never-activated
    // purchases a decline adopted it onto (C-661-10) hides it.
    const owners = await this.activatedFailedPurchases(db, pi.id);
    if (owners.length > 0) return this.recoverAfterPaymentSucceeded(db, owners, pi.id, tx);
    const purchase = await db.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id, status: { in: PI_SUCCEEDED_CLAIMABLE } },
    });
    // B-RECUR — the PaymentIntent of a native subscription's first invoice.
    // invoice.paid is the single owner of that purchase's entitlement and
    // settlement; flipping it to a one-time 'paid' here would mislabel a
    // renewing plan and settle it from a second path.
    if (purchase && purchase.billing_type === 'recurring' && purchase.stripe_subscription_id) {
      return { claimed: true, purchase_id: purchase.id, reason: 'subscription_invoice_owned_by_invoice_paid' };
    }
    if (!purchase || !activatesOnPaymentIntentSuccess(purchase, pi.id)) {
      // B-661-3 (Sol, round 4/5): record the settlement on every entitled
      // purchase this PaymentIntent paid (e.g. a hosted checkout that
      // completed while the payment was processing). The write gives the
      // row a new version (xmin; equal timestamps do not matter), so a
      // decline whose Stripe status was read before this success is stale:
      // it is redelivered and reads Stripe again.
      await db.clientPurchase.updateMany({
        where: { stripe_payment_intent_id: pi.id, entitlement_active: true },
        data: { updated_at: new Date() },
      });
      // B-661-5: a hosted Checkout purchase is its checkout session's to
      // activate.
      return {
        claimed: false,
        reason: purchase ? 'checkout_session_activates' : 'no_matching_purchase',
      };
    }

    // B-661-8 (Sol, round 5): compare-and-set on the state this was decided
    // for (id, PaymentIntent, status). A terminal state committed after the
    // read is never overwritten (writeIfUnchanged).
    const updated = await this.writeIfUnchanged(pi.id, () =>
      db.clientPurchase.update({
        where: { id: purchase.id, stripe_payment_intent_id: pi.id, status: purchase.status },
        data: {
          status: 'paid',
          entitlement_active: true,
          last_error: null,
          // B-SECRETS-3: the PaymentIntent is paid; its cached client
          // credentials can never be needed again, so they are erased.
          ...CLEARED_PAYMENT_SECRETS,
        },
      }),
    );

    // Roman P4 (Option C) — first-payment notification on the PaymentSheet
    // (payment_intent.succeeded) path too. Same in-tx, server-trusted,
    // feature-flagged contract as the checkout.session.completed callsite.
    await this.maybeEmitFirstPayment(updated, tx, event.id);

    // PR-18 B1 R3 P1 — defer the split posting to post-commit when an outer
    // tx is held (see runOrDeferSplit / runDeferredSplit + applyCheckoutCompleted
    // for the boundary rationale); run inline only on the no-tx legacy path.
    const deferredSplit = await this.runOrDeferSplit(updated, tx, prefetched);

    // PR-9 — fan-out INSIDE the outer tx (when provided). Resolver
    // failure on an immediate drop rethrows and rolls back entitlement
    // + drops together; Stripe retries idempotently.
    if (this.fanout && tx) {
      await this.fanout.onPurchaseEntitled(
        updated,
        {
          entrypoint: 'in_app_ps',
          coachId: updated.coach_user_id,
          clientId: updated.client_user_id,
          purchaseTime: new Date(),
        },
        tx,
      );
    } else if (this.fanout) {
      try {
        await this.fanout.onPurchaseEntitled(
          updated,
          {
            entrypoint: 'in_app_ps',
            coachId: updated.coach_user_id,
            clientId: updated.client_user_id,
          },
          this.prisma as unknown as WebhookTx,
        );
      } catch (err) {
        this.logger.warn(
          `Fanout seam failed for purchase=${updated.id} (no-tx legacy path): ${(err as Error).message}`,
        );
      }
    }

    return { claimed: true, purchase_id: purchase.id, deferredSplit };
  }

  // B-661-3 (rounds 6-7): one-time purchases of this PaymentIntent that it activated and a real
  // failure then ended, filtered in the query before its limit (at most one in practice).
  private async activatedFailedPurchases(
    db: WebhookTx | PrismaService,
    paymentIntentId: string,
  ): Promise<string[]> {
    if (!(db as { purchaseFanout?: unknown }).purchaseFanout) return [];
    const owners = await db.clientPurchase.findMany({
      where: {
        stripe_payment_intent_id: paymentIntentId,
        status: 'payment_failed',
        fanout: { isNot: null },
        billing_type: { notIn: ['recurring'] },
        stripe_subscription_id: null,
      },
      select: { id: true },
      take: 10,
    });
    return owners.map((row) => row.id);
  }

  // B-661-3 (Sol, round 5): recovery of an activated purchase whose payment
  // failed and then succeeded. Restores paid access and the drops that
  // failure canceled. The activation itself already ran once (first-payment
  // notice, fanout, head-coach split), so none of it runs again.
  private async recoverAfterPaymentSucceeded(
    db: WebhookTx | PrismaService,
    purchaseIds: string[],
    paymentIntentId: string,
    tx: WebhookTx | undefined,
  ): Promise<CheckoutWebhookResult> {
    for (const purchaseId of purchaseIds) {
      await this.writeIfUnchanged(paymentIntentId, () =>
        db.clientPurchase.update({
          where: { id: purchaseId, stripe_payment_intent_id: paymentIntentId, status: 'payment_failed' },
          data: {
            status: 'paid',
            entitlement_active: true,
            last_error: null,
            ...CLEARED_PAYMENT_SECRETS,
          },
        }),
      );
      if (this.fanout) await this.fanout.restoreAfterPaymentRecovered(purchaseId, tx);
      this.logger.log(
        `payment_intent.succeeded: purchase=${purchaseId} recovered after a failed payment of ${paymentIntentId}`,
      );
    }
    return { claimed: true, purchase_id: purchaseIds[0], reason: 'payment_recovered' };
  }

  private async applyPaymentIntentFailed(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const pi = event.data.object as {
      id?: string;
      last_payment_error?: { message?: string };
      metadata?: Record<string, string>;
    };
    if (!pi?.id) return { claimed: false };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const failure = {
      status: 'payment_failed',
      entitlement_active: false,
      last_error: pi.last_payment_error?.message ?? 'payment_failed',
    };
    let purchase = await db.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id },
    });
    if (!purchase) {
      // Try metadata fallback: tgp_package_id + tgp_client_user_id may be
      // present on the failing PI for a one_time package.
      const pkgId = pi.metadata?.tgp_package_id;
      const clientId = pi.metadata?.tgp_client_user_id;
      if (!pkgId || !clientId) return { claimed: false };
      // B-661-3: only a pending purchase that has no PaymentIntent yet (a
      // hosted checkout before completion) can be this PaymentIntent's
      // purchase. A pending purchase that holds another PaymentIntent (an
      // open PaymentSheet) belongs to that one: adopting it would overwrite
      // its PaymentIntent id, and that payment's success could then never
      // find its purchase.
      const pending = await db.clientPurchase.findFirst({
        where: {
          package_id: pkgId,
          client_user_id: clientId,
          status: 'pending',
          stripe_payment_intent_id: null,
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false };
      // Never-entitled pending purchase — flip to payment_failed only.
      // Per PR-16 brief: PI-failed for a never-entitled purchase must NOT
      // cancel drops (none exist anyway; fanout was never run). Skip the
      // cancel call to keep the log line out of the never-entitled path.
      // Compare-and-set: the purchase must still be pending without a
      // PaymentIntent when the write lands.
      const adopted = await db.clientPurchase.updateMany({
        where: { id: pending.id, status: 'pending', stripe_payment_intent_id: null },
        data: { ...failure, stripe_payment_intent_id: pi.id },
      });
      if (adopted.count === 0) throw declineRetryLater('purchase_changed', pi.id);
      return { claimed: true, purchase_id: pending.id };
    }
    // B-RECUR-BE R1-7 — the PaymentIntent of a native subscription's first
    // invoice. invoice.payment_failed owns subscription rows (first-attempt
    // decline = last_error only; renewal = past_due + dunning). Flipping the
    // attempt to 'payment_failed' here would list a client who mistyped a
    // card on the coach's failed-payments roster and fight the invoice path.
    // B-680-2 — the decline is written only while the attempt never granted
    // access and has not ended: a late first-invoice decline after a second
    // card paid never shows on the paid plan.
    if (purchase.billing_type === 'recurring' && purchase.stripe_subscription_id) {
      if (isNeverEntitledAttempt(purchase)) {
        await this.recordAttemptDecline(
          tx,
          purchase,
          pi.last_payment_error?.message ?? 'payment_failed',
        );
      }
      return {
        claimed: true,
        purchase_id: purchase.id,
        reason: 'subscription_invoice_owned_by_invoice_events',
      };
    }

    if (PI_FAILED_CLAIMABLE.includes(purchase.status)) {
      // B-661-3: compare-and-set on a status that may still fail. A success
      // of this PaymentIntent that commits first makes the count 0 (Postgres
      // re-checks the predicate after the row lock is released).
      const wasEntitled = !!purchase.entitlement_active;
      const claimed = await db.clientPurchase.updateMany({
        where: { id: purchase.id, status: { in: PI_FAILED_CLAIMABLE } },
        data: failure,
      });
      if (claimed.count === 1) {
        await this.cancelDropsAfterFailure(purchase.id, wasEntitled, tx);
        return { claimed: true, purchase_id: purchase.id };
      }
      // The purchase moved while this decline was in flight: judge its
      // current state below.
      purchase = await db.clientPurchase.findUnique({ where: { id: purchase.id } });
      if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };
    }

    if (PI_FAILED_NEVER_REWRITES.has(purchase.status)) {
      return { claimed: true, purchase_id: purchase.id, reason: 'already_final' };
    }
    if (PI_FAILED_CLAIMABLE.includes(purchase.status)) {
      // Moved again between the compare-and-set and the re-read.
      throw declineRetryLater('purchase_changed', pi.id);
    }

    // B-661-3: the purchase already settled. The decline is either a late
    // delivery of an earlier attempt (the PaymentIntent then succeeded) or a
    // real failure of a payment that was still processing. Only Stripe's
    // current PaymentIntent status tells them apart. Inside the webhook tx it
    // comes from the out-of-tx prefetch (never Stripe HTTP in a DB tx); the
    // no-tx path asks Stripe directly.
    // Round 4/5: that status is valid only for the purchase version read
    // before the Stripe call (`seen`). A write since then (a success of this
    // PaymentIntent among them) makes it stale: Stripe redelivers, the
    // prefetch reads again. The no-tx path reads the version, then asks.
    const seen = tx
      ? prefetched?.paymentIntentWitnessById?.[pi.id]
      : await this.readPurchaseVersion(this.prisma, purchase.id, false);
    if (!seen || seen.purchase_id !== purchase.id) {
      throw declineRetryLater('purchase_changed', pi.id);
    }
    const providerStatus = tx
      ? (prefetched?.paymentIntentStatusById?.[pi.id] ?? null)
      : await this.lookUpPaymentIntentStatus(pi.id);
    if (!providerStatus) throw declineRetryLater('payment_intent_status_unknown', pi.id);
    if (providerStatus === PI_STATUS_UNREADABLE) {
      // C-661-6: Stripe cannot read this PaymentIntent and never will; the
      // purchase stays as it is (logged by the lookup with its code).
      return { claimed: true, purchase_id: purchase.id, reason: 'payment_intent_unreadable' };
    }
    if (!PI_STATUS_NOT_COMPLETED.has(providerStatus)) {
      return { claimed: true, purchase_id: purchase.id, reason: 'stale_failure' };
    }
    // A real failure ends access only on the exact version the decision was
    // made for, checked and written under the row lock (in the webhook tx,
    // or a short tx of its own on the no-tx path).
    const settled = purchase;
    const paymentIntentId = pi.id;
    const revoke = (client: WebhookTx) =>
      this.revokeIfUnchanged(client, settled, seen, failure, paymentIntentId);
    return tx ? revoke(tx) : this.inShortTransaction(revoke);
  }

  private async revokeIfUnchanged(
    client: WebhookTx,
    purchase: ClientPurchase,
    seen: PurchaseVersion,
    failure: { status: string; entitlement_active: boolean; last_error: string },
    paymentIntentId: string,
  ): Promise<CheckoutWebhookResult> {
    const now = await this.readPurchaseVersion(client, purchase.id, true);
    if (!samePurchaseVersion(seen, now)) throw declineRetryLater('purchase_changed', paymentIntentId);
    const wasEntitled = !!purchase.entitlement_active;
    const revoked = await client.clientPurchase.updateMany({
      where: { id: purchase.id, status: seen.status },
      data: failure,
    });
    if (revoked.count === 0) throw declineRetryLater('purchase_changed', paymentIntentId);
    await this.cancelDropsAfterFailure(purchase.id, wasEntitled, client);
    return { claimed: true, purchase_id: purchase.id };
  }

  // A short transaction of its own for the no-tx (legacy) path, so a row
  // lock is held across a check and its write. Test doubles without
  // $transaction run on the client directly.
  private async inShortTransaction<T>(run: (client: WebhookTx) => Promise<T>): Promise<T> {
    if (typeof (this.prisma as { $transaction?: unknown }).$transaction === 'function') {
      return this.prisma.$transaction((innerTx) => run(innerTx));
    }
    return run(this.prisma);
  }

  // Pre-flip entitlement (captured before the write): only entitled purchases have drops
  // worth canceling. A first-attempt PaymentSheet failure on a still-
  // pending purchase never minted drops; a real failure of an already-
  // entitled purchase (B-661-3: confirmed by Stripe) did. Either way the
  // cancel call is idempotent — but skipping when wasEntitled=false matches
  // the brief's "PI-failed-never-entitled does not cancel" semantic
  // and keeps the log clean.
  private async cancelDropsAfterFailure(
    purchaseId: string,
    wasEntitled: boolean,
    tx?: WebhookTx,
  ): Promise<void> {
    if (!this.fanout || !wasEntitled) return;
    await this.fanout.cancelPendingForPurchase(
      purchaseId,
      'payment_failed',
      tx ?? (this.prisma as unknown as WebhookTx),
    );
  }

  private async applyInvoicePaid(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const inv = event.data.object as {
      id?: string;
      subscription?: string | null;
      amount_paid?: number;
      currency?: string | null;
      charge?: string | null;
      status_transitions?: { paid_at?: number };
    };
    if (!inv?.subscription) return { claimed: false };
    // PR-18 B1 — read/write on the caller's outer tx when provided so the
    // renewal entitlement activation (and its CoachPackage row lock) commit
    // with the StripeProcessedEvent dedup row instead of via a nested
    // $transaction.
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    // Resync subscription state from Stripe so current_period_end and
    // entitlement window are fresh after a renewal.
    let updated = purchase;
    let wasEntitled = purchase.entitlement_active;
    try {
      // PR-18 B1 — NEVER perform Stripe HTTP while a DB transaction is held.
      // When BillingService threads its outer tx, it ALSO pre-resolves the
      // subscription via `prefetchForOuterTx(event)` BEFORE opening the tx
      // and passes it here, so the round-trip already happened out-of-tx.
      // When there is no outer tx (legacy/test resync path), it is safe to
      // retrieve here because activateUnderPackageLock opens its own short
      // tx AFTER this call. B-680-3 — if an outer tx is held but no prefetch
      // was supplied, no Stripe HTTP runs in it and the paid invoice is never
      // acknowledged without its access and money effects: throw so the
      // outer tx rolls back and Stripe redelivers (the prefetch is retried
      // out-of-tx next time).
      let sub = prefetched?.invoiceSubscription ?? null;
      let revision = sub ? prefetched?.invoiceRevision : undefined;
      if (!sub) {
        if (tx) {
          throw new WebhookRedeliverError(
            `invoice.paid for purchase ${purchase.id}: subscription prefetch unavailable; retry`,
          );
        }
        // B-680-1 — the purchase was read before this Stripe read.
        revision = lifecycleRevision(purchase);
        sub = await this.stripeConnect.retrieveSubscription(inv.subscription);
      }
      const pkg = await db.coachPackage.findUnique({
        where: { id: purchase.package_id },
      });
      const status = this.normalizeSubscriptionStatus(sub.status);
      const currentPeriodEnd = this.toDate(sub.current_period_end);
      const live: SubscriptionSnapshot = sub;
      updated = await this.activateUnderPackageLock(tx, purchase.package_id, async (client) => {
        // B-680-1 — decide on the purchase as it is under the lock: a
        // purchase that ended or was revoked is never reopened, whenever
        // Stripe was read. The money below still settles.
        const fresh = (await this.lockPurchase(client, purchase.id)) ?? purchase;
        wasEntitled = fresh.entitlement_active;
        if (purchaseHasEnded(fresh)) return fresh;
        const changed = revision !== undefined && lifecycleRevision(fresh) !== revision;
        // R-DISPUTE-PAUSE: a paid invoice never ends a dispute pause.
        const entitled =
          subscriptionGrantsAccess(fresh, live) && !(await this.disputePaused(client, fresh.id));
        const trial = trialStartPatch(fresh, live, entitled);
        if (changed) {
          // B-680-1 — another delivery wrote the purchase after this Stripe
          // read (a revocation, a renewal period, a cancellation): a matching
          // state needs no write and the money below settles; anything else
          // is read again, never overwritten from the older read.
          const same =
            fresh.status === status &&
            fresh.entitlement_active === entitled &&
            sameInstant(fresh.current_period_end, currentPeriodEnd) &&
            !trial.trial_started_at;
          if (same) return fresh;
          throw new WebhookRedeliverError(
            `invoice.paid: purchase=${fresh.id} changed during the Stripe read; redeliver`,
          );
        }
        return client.clientPurchase.update({
          where: { id: fresh.id },
          data: {
            status,
            entitlement_active: entitled,
            ...trial,
            // B-661-14/15 — same erase as applySubscriptionUpdated; an unsaved trial card keeps them.
            ...(entitled ? CLEARED_PAYMENT_SECRETS : {}),
            current_period_end: currentPeriodEnd,
            access_expires_at: this.computeAccessExpiry(pkg, fresh, true, currentPeriodEnd),
            last_error: null,
            updated_at: nextVersion(fresh),
          },
        });
      });
    } catch (err) {
      // Under the outer tx every failure (an authority conflict included)
      // rolls back for a redelivery; only the no-tx resync of a plan that
      // already grants access degrades to settling the money.
      if (tx || !purchase.entitlement_active) throw err;
      this.logger.warn(
        `invoice.paid resync failed for sub=${inv.subscription} error=${errorLabel(err)}`,
      );
    }
    // B-RECUR — first grant (first invoice paid, or a trial's $0 invoice
    // after its card was saved): content fan-out.
    if (updated.entitlement_active && !wasEntitled) {
      await this.onSubscriptionFirstEntitled(updated, tx);
    }
    // B-680-3 — the coach's first-payment notice: money collected.
    await this.maybeEmitInvoicePayment(updated, inv, tx, event.id);
    // Phase 4 — per-renewal split: each invoice.paid mints (or
    // re-collapses-onto) the head-coach Transfer for that invoice.
    //
    // PR-18 B1 R3 P1: the invoice event already carries the charge id
    // (`inv.charge`) so no retrievePaymentIntent is needed, but
    // onChargeSucceeded still calls transfers.attempt() (createTransfer =
    // Stripe HTTP). When an outer tx is held we defer the posting to
    // post-commit, threading inv.charge as the pre-resolved charge id; with
    // no outer tx we run it inline as before.
    const deferredSplit = await this.runOrDeferSplit(updated, tx, prefetched, {
      invoice_amount_cents: inv.amount_paid ?? undefined,
      invoice_charge_id: inv.charge ?? null,
    });
    // Phase 5 — clear any active dunning window.
    if (this.dunning) {
      try {
        await this.dunning.recordResolution(updated.id);
      } catch (err) {
        this.logger.warn(
          `dunning.recordResolution failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    // B3 v2 (§5) — immediate-clear additions (restore entitlement, lift Day-10
    // lockout, dismiss blockers, revoke recovery tokens). No-op when the flag
    // is off; runs AFTER the v1 recordResolution so v1 behaviour is unchanged.
    // On the outer tx (B-DUNMR-120): it already holds this purchase's row
    // lock, which a second connection would wait on until the tx times out.
    if (this.dunningV2) {
      try {
        await this.dunningV2.applyImmediateClear(updated.id, 'retry', tx);
      } catch (err) {
        this.logger.warn(
          `dunningV2.applyImmediateClear failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id, deferredSplit };
  }

  private async applyInvoicePaymentFailed(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const inv = event.data.object as {
      id?: string;
      subscription?: string | null;
      amount_due?: number | null;
      attempt_count?: number | null;
      billing_reason?: string | null;
      last_payment_error?: { message?: string };
    };
    if (!inv?.subscription) return { claimed: false };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    // B-680-2 — a purchase that ended (deleted, expired by Stripe, retired by
    // checkout) is never reopened as past_due by a late decline.
    if (purchaseHasEnded(purchase)) {
      return { claimed: true, purchase_id: purchase.id, reason: 'subscription_already_ended' };
    }
    // B-680-2 — Stripe retries deliveries for days: a decline delivered after
    // its invoice was paid (a later retry or a second card) or voided is
    // settled. Unreadable = throw so the outer tx rolls back and Stripe
    // redelivers.
    const liveStatus = prefetched?.failedInvoiceStatus;
    if (liveStatus === null) {
      throw new WebhookRedeliverError(
        `invoice.payment_failed: invoice ${inv.id ?? 'unknown'} unreadable on Stripe; redeliver`,
      );
    }
    if (liveStatus === 'paid' || liveStatus === 'void') {
      return { claimed: true, purchase_id: purchase.id, reason: 'invoice_already_settled' };
    }
    const message = inv.last_payment_error?.message ?? 'invoice_payment_failed';
    // B-RECUR / B-680-2 — a declined first invoice is a checkout attempt, not
    // a renewal failure: no past_due, no dunning emails, no lockout. The sheet
    // already told the client; Stripe expires the attempt after 23 h. The
    // decline is recorded only while the attempt, as it is under the lock,
    // has never granted access.
    if (isNeverEntitledPaymentAttempt(purchase, inv.billing_reason ?? null)) {
      if (isNeverEntitledAttempt(purchase)) await this.recordAttemptDecline(tx, purchase, message);
      return { claimed: true, purchase_id: purchase.id, reason: 'first_attempt_declined' };
    }
    // B-680-2 — Stripe's own view at the read: an ended subscription is the
    // deletion's to end, and a decline of an invoice that is no longer the
    // subscription's latest (a newer one was issued or paid) is superseded.
    const authority = prefetched?.failedInvoiceAuthority;
    if (authority?.subscriptionStatus && STRIPE_ENDED_STATUSES.has(authority.subscriptionStatus)) {
      return { claimed: true, purchase_id: purchase.id, reason: 'subscription_already_ended' };
    }
    if (authority?.latestInvoiceId && inv.id && authority.latestInvoiceId !== inv.id) {
      return { claimed: true, purchase_id: purchase.id, reason: 'invoice_superseded' };
    }
    // B-680-2 — Stripe sends the final decline and the deletion together: a
    // deletion that committed after the read above is never reopened. Any
    // write after the invoice read supersedes that read: read again
    // (redeliver). No write is exempt: a status cannot show which invoice
    // moved the plan (the past_due update Stripe sends with this decline,
    // or a payment of this invoice that leaves another one unpaid), so the
    // paired update costs one redelivery, never a decline of a paid invoice.
    const updated = await this.activateUnderPackageLock(tx, purchase.package_id, async (client) => {
      const fresh = await this.lockPurchase(client, purchase.id);
      if (!fresh || purchaseHasEnded(fresh)) return null;
      if (authority && writeVersion(fresh) !== authority.version) {
        throw new WebhookRedeliverError(
          `invoice.payment_failed: purchase=${fresh.id} changed after the invoice read; redeliver`,
        );
      }
      return client.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          // C-680-11 — a decline never downgrades unpaid (access already
          // ended) to past_due.
          status: fresh.status === 'unpaid' ? 'unpaid' : 'past_due',
          // Entitlement is retained during past_due — same as SaaS billing —
          // until Stripe ultimately cancels the subscription, which fires
          // customer.subscription.deleted.
          last_error: message,
          updated_at: nextVersion(fresh),
        },
      });
    });
    if (!updated) {
      return { claimed: true, purchase_id: purchase.id, reason: 'subscription_already_ended' };
    }
    // Phase 5 — open or extend the dunning window and queue a reminder.
    if (this.dunning) {
      try {
        await this.dunning.recordFailure({
          purchase: updated,
          stripe_invoice_id: inv.id ?? null,
          amount_due_cents: typeof inv.amount_due === 'number' ? inv.amount_due : null,
          attempt_number:
            typeof inv.attempt_count === 'number' ? inv.attempt_count : null,
          reason: inv.last_payment_error?.message ?? null,
        });
      } catch (err) {
        this.logger.warn(
          `dunning.recordFailure failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applyCustomerUpdated(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const cus = event.data.object as {
      id?: string;
      invoice_settings?: {
        default_payment_method?:
          | string
          | { id?: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } }
          | null;
      };
    };
    if (!cus?.id) return { claimed: false };
    const customer = await this.prisma.connectCustomer.findUnique({
      where: { stripe_customer_id: cus.id },
    });
    if (!customer) return { claimed: false };

    const dpm = cus.invoice_settings?.default_payment_method;
    let pmId: string | null = null;
    let brand: string | null = null;
    let last4: string | null = null;
    let expMonth: number | null = null;
    let expYear: number | null = null;
    if (typeof dpm === 'string') {
      pmId = dpm;
      // Stripe didn't expand — pull the card details.
      try {
        const pm = await this.stripeConnect.retrievePaymentMethod(dpm);
        brand = pm.card?.brand ?? null;
        last4 = pm.card?.last4 ?? null;
        expMonth = pm.card?.exp_month ?? null;
        expYear = pm.card?.exp_year ?? null;
      } catch (err) {
        this.logger.warn(
          `customer.updated: failed to retrieve payment method ${dpm}: ${(err as Error).message}`,
        );
      }
    } else if (dpm && typeof dpm === 'object') {
      pmId = dpm.id ?? null;
      brand = dpm.card?.brand ?? null;
      last4 = dpm.card?.last4 ?? null;
      expMonth = dpm.card?.exp_month ?? null;
      expYear = dpm.card?.exp_year ?? null;
    }

    await this.prisma.connectCustomer.update({
      where: { stripe_customer_id: cus.id },
      data: {
        default_payment_method_id: pmId,
        default_card_brand: brand,
        default_card_last4: last4,
        default_card_exp_month: expMonth,
        default_card_exp_year: expYear,
      },
    });
    return { claimed: true };
  }

  /**
   * B-680-1 / B-680-2 — the purchase as it is now, row-locked on the webhook
   * transaction (after the package lock), so no writer outside the package
   * lock lands between this read and the write that depends on it.
   */
  private async lockPurchase(client: WebhookTx, id: string): Promise<ClientPurchase | null> {
    if (typeof (client as { $queryRaw?: unknown }).$queryRaw === 'function') {
      // B-680-6 — NO KEY UPDATE: it serializes every lifecycle writer (it
      // conflicts with itself and with UPDATE), but not the foreign-key checks
      // of rows other connections insert for this purchase while the webhook
      // transaction is open (DunningService's DunningState and PaymentReminder
      // on its own client). FOR UPDATE blocked those inserts until this
      // transaction ended, and the transaction was waiting for them.
      await client.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "ClientPurchase" WHERE id = ${id} FOR NO KEY UPDATE`;
    }
    return client.clientPurchase.findUnique({ where: { id } });
  }

  /**
   * B-680-2 — a first-attempt decline (invoice or PaymentIntent) on the
   * webhook transaction, written only while the attempt, as it is under the
   * lock, never granted access and has not ended: a concurrent grant wins.
   */
  private async recordAttemptDecline(
    tx: WebhookTx | undefined,
    purchase: ClientPurchase,
    message: string,
  ): Promise<void> {
    await this.activateUnderPackageLock(tx, purchase.package_id, async (client) => {
      const fresh = await this.lockPurchase(client, purchase.id);
      if (!fresh || !isNeverEntitledAttempt(fresh)) return;
      await client.clientPurchase.update({ where: { id: fresh.id }, data: { last_error: message } });
    });
  }

  /**
   * R-DISPUTE-PAUSE: a plan a dispute paused is never re-entitled by a Stripe
   * status (pause_collection leaves the subscription `active`). Read under the
   * caller's purchase lock, which the pause and the coach restart also take;
   * no DunningState lock here (B-DUNMR-120): v1 `recordResolution` writes
   * that row on its own connection during this transaction.
   */
  private async disputePaused(client: WebhookTx, purchaseId: string): Promise<boolean> {
    // Legacy test stubs of DunningV2Service lack the read; production has it.
    const v2 = this.dunningV2;
    if (!v2 || typeof v2.isDisputePaused !== 'function') return false;
    return v2.isDisputePaused(purchaseId, client);
  }

  /**
   * B1 pricing-lock serialization (PR-18).
   *
   * Runs `activate` (a ClientPurchase entitlement-activation write) AFTER
   * taking a `SELECT id FROM "CoachPackage" WHERE id = ${packageId} FOR
   * UPDATE` row lock on the package, inside the SAME transaction that
   * performs the activation. This is the exact lock that
   * PackagesService.update() takes before it counts active recurring
   * buyers and writes a price edit.
   *
   * Serialization argument (what locks what, in what order, no deadlock):
   *   - Both the pricing-edit tx and the activation tx acquire ONE lock:
   *     the `CoachPackage` row identified by `packageId`. Neither acquires
   *     a second lock while holding the first, so there is no
   *     lock-ordering cycle and therefore no deadlock.
   *   - Whichever tx acquires the row lock first runs to completion; the
   *     other blocks on the row lock until the first commits, then proceeds
   *     against the now-committed state:
   *       * If the activation commits first, the pricing edit's count
   *         (taken under the same row lock) sees the newly active recurring
   *         buyer and throws PACKAGE_PRICING_LOCKED.
   *       * If the pricing edit commits first, this activation observes the
   *         already-edited package row when it proceeds (the price change
   *         is fully committed before the buyer becomes active).
   *   - The guard can therefore NEVER miss an entitlement activation that
   *     commits before the price update commits.
   *
   * When the caller already holds an outer `$transaction` (BillingService
   * threads its tx through `handle(event, tx)`), the lock + activation run
   * on that same tx. When there is no outer tx (the subscription/invoice
   * resync paths call `this.prisma` directly), we open our own short
   * `$transaction` so the FOR UPDATE lock is held across the activating
   * write. No Stripe HTTP is performed inside this transaction.
   */
  private async activateUnderPackageLock<T>(
    tx: WebhookTx | undefined,
    packageId: string,
    activate: (client: WebhookTx) => Promise<T>,
  ): Promise<T> {
    const runLocked = async (client: WebhookTx): Promise<T> => {
      // Legacy/test wiring may pass a minimal client stub without $queryRaw.
      // Production prisma always provides it, so the FOR UPDATE row lock is
      // unchanged there; in the stub case we skip the raw lock and just run
      // the activation write (same defensive pattern as the no-$transaction
      // fallback below).
      if (
        typeof (client as { $queryRaw?: unknown }).$queryRaw === 'function'
      ) {
        await client.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM "CoachPackage" WHERE id = ${packageId} FOR UPDATE`;
      }
      return activate(client);
    };
    if (tx) {
      // Already inside the caller's outer $transaction — lock on it.
      return runLocked(tx);
    }
    // No outer tx — open our own so the row lock is held across the write.
    // Legacy/test wiring may hand-construct this service with a minimal
    // prisma stub that lacks `$transaction` (the same defensive pattern the
    // fanout no-tx path uses). In that case run the lock + activate directly
    // on `this.prisma`: production always provides `$transaction`, so the
    // FOR UPDATE serialization is unchanged there.
    if (
      typeof (this.prisma as { $transaction?: unknown }).$transaction ===
      'function'
    ) {
      return this.prisma.$transaction((innerTx) =>
        runLocked(innerTx as unknown as WebhookTx),
      );
    }
    return runLocked(this.prisma as unknown as WebhookTx);
  }

  // Compute access_expires_at given the package + purchase context.
  //
  // - Recurring: mirrors current_period_end. Once Stripe stops renewing
  //   (status=canceled), the row keeps current_period_end as a tombstone.
  // - One_time + duration_periods != null: created_at + duration_periods
  //   weeks. (Weeks is the unit because programs are typically advertised
  //   in week counts; if we ever need other units the package can carry an
  //   explicit duration_unit.)
  // - One_time + duration_periods == null: returns null (lifetime access).
  private computeAccessExpiry(
    pkg: CoachPackage | null,
    purchase: ClientPurchase,
    isRecurring: boolean,
    currentPeriodEnd: Date | null,
  ): Date | null {
    if (isRecurring) {
      // Pad recurring access by 1 day so a late renewal webhook doesn't
      // briefly drop entitlement between current_period_end and the new
      // current_period_end. Stripe's grace is typically minutes; 24h is a
      // safe cap.
      if (currentPeriodEnd) {
        return new Date(currentPeriodEnd.getTime() + 24 * 3600 * 1000);
      }
      return null;
    }
    if (!pkg || !pkg.duration_periods) return null;
    const startedAt = purchase.created_at;
    return new Date(
      startedAt.getTime() + pkg.duration_periods * 7 * 24 * 3600 * 1000,
    );
  }

  private normalizeSubscriptionStatus(status: string | undefined): string {
    // Stripe statuses: active | past_due | unpaid | canceled | incomplete |
    // incomplete_expired | trialing | paused
    if (!status) return 'pending';
    return status;
  }

  private toDate(seconds: number | null | undefined): Date | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  }
}
