import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import {
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
import { TrialUsageService } from '../packages/trials/trial-usage.service';
import {
  subscriptionHasPaymentMethod,
  TrialNoticeService,
  type TrialWillEndSubscription,
} from '../packages/trials/trial-notice.service';
import { TrialConflictService } from '../packages/trials/trial-conflict.service';
import { trialErrorClass } from '../packages/trials/trial-diagnostics';

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
 * B-TRIALS — the trial columns and access an event resolves to. `owns` (B-TR8-120): this purchase
 * holds the client's one trial with the coach, so it may carry trial_started_at.
 */
type TrialTransition = {
  data: Prisma.ClientPurchaseUpdateInput;
  conflict: boolean;
  entitled: boolean;
  owns: boolean;
  noticeId?: string;
};

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

/** B-TR8-120 — this event starts the purchase's native trial (trialStartPatch would mark it). */
function isTrialStart(
  purchase: Pick<ClientPurchase, 'trial_days' | 'trial_started_at'>,
  sub: { trial_start?: unknown },
  entitled: boolean,
): boolean {
  return !!trialStartPatch(purchase, sub, entitled).trial_started_at;
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
  default_source?: unknown;
  trial_start?: unknown;
  trial_end?: unknown;
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
//   *        -- payment_intent.payment_failed --> payment_failed
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
  // B-TRIALS (OR-113-2) — a trial-ending notice recorded inside the tx whose
  // push + email BillingService delivers after commit (deliverTrialNotice).
  deferredTrialNoticeId?: string;
  // B-TRIALS — a trialing subscription that tried to start a second free
  // trial with the same coach. BillingService cancels it after commit
  // (cancelTrialConflict) so the client is never charged for it.
  trialConflictSubscriptionId?: string;
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
    // B-TRIALS (OR-113-2) — one trial per client per coach + trial notices.
    // @Optional() so legacy unit-test wiring still constructs the handler.
    @Optional() private trialUsage?: TrialUsageService,
    @Optional() private trialNotices?: TrialNoticeService,
    // B-TRIALS-3 (B-656-1) — durable cancellation of a second trial.
    @Optional() private trialConflicts?: TrialConflictService,
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
      // B-TRIALS (OR-113-2) — three days before a free trial ends.
      case 'customer.subscription.trial_will_end':
        return this.applyTrialWillEnd(event, tx);
      case 'payment_intent.succeeded':
        return this.applyPaymentIntentSucceeded(event, tx, prefetched);
      case 'payment_intent.payment_failed':
        return this.applyPaymentIntentFailed(event, tx);
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
        const purchase = await this.prisma.clientPurchase.findFirst({
          where: { stripe_payment_intent_id: obj.id, status: 'pending' },
          select: { id: true },
        });
        if (!purchase) return {};
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
          where: { id: purchase.id },
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
      data: { status: 'expired', entitlement_active: false },
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
      const entitled = subscriptionGrantsAccess(fresh, sub);
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
      // B-TRIALS / B-TR8-120 — the one shared trial rule on the same lock.
      const trial = await this.trialState(client, fresh, status, sub, entitled, event.id);
      const updated = await client.clientPurchase.update({
        where: { id: fresh.id },
        data: {
          status,
          entitlement_active: trial.entitled,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          current_period_end: currentPeriodEnd,
          canceled_at: canceledAt,
          access_expires_at: accessExpiresAt,
          ...(trial.owns ? trialStartPatch(fresh, sub, trial.entitled) : {}),
          ...trial.data,
          updated_at: nextVersion(fresh),
        },
      });
      return { updated, firstGrant: trial.entitled && !fresh.entitlement_active, trial };
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
    return {
      claimed: true,
      purchase_id: purchase.id,
      ...(outcome.trial.conflict ? { trialConflictSubscriptionId: subId } : {}),
      ...(outcome.trial.noticeId ? { deferredTrialNoticeId: outcome.trial.noticeId } : {}),
    };
  }

  /**
   * B-TRIALS (OR-113-2) / B-TR8-120 — the trial side of a subscription or
   * invoice event, on the webhook tx under the package and purchase locks.
   * `granted` is subscriptionGrantsAccess (card up front, B-680-5).
   *
   * ONE SHARED TRIAL RULE (owner 10-05): at most one free trial per client
   * per coach, whichever checkout sold it. Every trial start (trialing with
   * the attempt's own card, or first seen active / past_due, B-680-4) claims
   * the client's trial with this coach in the ledger first
   * (TrialUsageService.markStarted: the unique (client, coach) row is the
   * race guard); only the purchase that holds it carries trial_started_at,
   * which the checkout's eligibility reads, so both trial records always
   * agree. A purchase that lost it gets no free access and owes a durable
   * cancellation (B-656-1); one that billed first keeps a paid plan.
   *
   * Also mirrors card_on_file (B-656-5), writes trial_ends_at only for a
   * trial that started (C-671-4), and records the trial-ending notice when a
   * trial starts inside the warning window (B-656-3).
   */
  private async trialState(
    db: WebhookTx,
    purchase: ClientPurchase,
    status: string,
    sub: SubscriptionSnapshot,
    granted: boolean,
    eventId: string,
  ): Promise<TrialTransition> {
    const out = await this.trialTransition(db, purchase, status, sub, granted, eventId);
    const trialEndsAt = this.toDate(typeof sub.trial_end === 'number' ? sub.trial_end : null);
    const started =
      out.owns &&
      (!!purchase.trial_ends_at ||
        !!purchase.trial_started_at ||
        isTrialStart(purchase, sub, out.entitled));
    if (trialEndsAt && started) out.data.trial_ends_at = trialEndsAt;
    return out;
  }

  private async trialTransition(
    db: WebhookTx,
    purchase: ClientPurchase,
    status: string,
    sub: SubscriptionSnapshot,
    granted: boolean,
    eventId: string,
  ): Promise<TrialTransition> {
    const trialEndsAt = this.toDate(typeof sub.trial_end === 'number' ? sub.trial_end : null);
    const trialStart = this.toDate(typeof sub.trial_start === 'number' ? sub.trial_start : null);
    const data: Prisma.ClientPurchaseUpdateInput = {};
    if (trialEndsAt && trialStart && !purchase.trial_days) {
      const days = Math.round((trialEndsAt.getTime() - trialStart.getTime()) / 86_400_000);
      if (days >= 1 && days <= 30) data.trial_days = days;
    }
    // B-656-5 — card state is billing truth, kept apart from access.
    if ('default_payment_method' in sub || 'default_source' in sub) {
      data.card_on_file = subscriptionHasPaymentMethod(sub);
    }
    if (!this.trialUsage) return { data, conflict: false, entitled: granted, owns: true };

    // B-656-1 — a purchase with a conflict row lost the one-trial race.
    let owed = this.trialConflicts ? await this.trialConflicts.find(db, purchase.id) : null;
    const starting =
      isTrialStart(purchase, sub, granted) ||
      (granted && status === 'trialing' && !!purchase.trial_started_at);
    if (!owed && starting) {
      const outcome = await this.trialUsage.markStarted(db, {
        purchaseId: purchase.id,
        clientUserId: purchase.client_user_id,
        coachUserId: purchase.coach_user_id,
        packageId: purchase.package_id,
        trialDays: (data.trial_days as number | undefined) ?? purchase.trial_days ?? 0,
        trialEndsAt,
      });
      if (outcome === 'owned') {
        // B-656-3 — a trial that starts inside the warning window gets its
        // notice now (its trial_will_end event may have come before the card).
        const noticeId =
          this.trialNotices && status === 'trialing'
            ? await this.trialNotices.recordIfDue(db, {
                purchase,
                sub: sub as TrialWillEndSubscription,
                trialEndsAt,
                eventId,
              })
            : null;
        return { data, conflict: false, entitled: true, owns: true, ...(noticeId ? { noticeId } : {}) };
      }
      if (!this.trialConflicts || !sub.id) {
        return { data, conflict: true, entitled: false, owns: false };
      }
      await this.trialConflicts.owe(db, { purchaseId: purchase.id, subscriptionId: sub.id });
      owed = await this.trialConflicts.find(db, purchase.id);
    }
    if (!owed || !this.trialConflicts) {
      return { data, conflict: false, entitled: granted, owns: true };
    }
    if (owed.status === 'superseded') return { data, conflict: false, entitled: granted, owns: false };
    if (owed.status === 'owed' && status === 'active') {
      // Every cancel failed through the whole trial and Stripe billed the
      // regular price: the client paid, so the plan is a regular paid plan
      // sold without a trial; support is alerted by the sweep (refund).
      await this.trialConflicts.supersede(db, purchase.id);
      return { data, conflict: false, entitled: granted, owns: false };
    }
    // trialing (or past_due: no money taken yet): never any access, and
    // the owed cancel is re-armed after this commit.
    return { data, conflict: owed.status === 'owed', entitled: false, owns: false };
  }

  /**
   * B-TRIALS (OR-113-2) — customer.subscription.trial_will_end. Records the
   * trial-ending notice (ledger + in-app row) on the webhook tx and hands the
   * notice id back so push + email go out after commit.
   */
  private async applyTrialWillEnd(
    event: StripeEvent,
    tx?: WebhookTx,
  ): Promise<CheckoutWebhookResult> {
    const sub = event.data.object as TrialWillEndSubscription;
    if (!sub?.id) return { claimed: false, reason: 'no_sub_id' };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: sub.id },
    });
    if (!purchase) return { claimed: false };
    if (!this.trialNotices) return { claimed: true, purchase_id: purchase.id };
    // The ledger row and the in-app row share the caller's tx when one is
    // held (BillingService always threads it); legacy callers autocommit.
    const noticeId = await this.trialNotices.recordTrialWillEnd(db, {
      purchase,
      sub,
      eventId: event.id,
    });
    return {
      claimed: true,
      purchase_id: purchase.id,
      ...(noticeId ? { deferredTrialNoticeId: noticeId } : {}),
    };
  }

  /** B-TRIALS — post-commit push + email for a trial notice. Never throws. */
  async deliverTrialNotice(noticeId: string): Promise<void> {
    if (!this.trialNotices) return;
    await this.trialNotices.deliver(noticeId);
  }

  /**
   * B-TRIALS — post-commit: cancel a subscription that tried to start a second
   * free trial with the same coach. It is trialing, so cancelling now means no
   * invoice and no charge. B-TRIALS-3 (B-656-1): the obligation is the
   * PackageTrialConflict row written in the webhook tx; this settles it once
   * now, and TrialConflictService.sweep retries it until Stripe confirms.
   * Never throws.
   */
  async cancelTrialConflict(subscriptionId: string): Promise<void> {
    if (this.trialConflicts) {
      try {
        const rows = await this.prisma.packageTrialConflict.findMany({
          where: { stripe_subscription_id: subscriptionId, status: 'owed' },
          select: { purchase_id: true },
        });
        for (const row of rows) await this.trialConflicts.settle(row.purchase_id);
      } catch (err) {
        this.logger.error(
          `trial conflict: settle lookup failed (sweep retries): ${trialErrorClass(err)}`,
        );
      }
      return;
    }
    try {
      await this.stripeConnect.cancelSubscription(subscriptionId);
      this.logger.warn(`trial conflict: cancelled subscription ${subscriptionId} (TRIAL_ALREADY_USED)`);
    } catch (err) {
      this.logger.error(
        `trial conflict: cancel failed for subscription ${subscriptionId} (TRIAL_ALREADY_USED, cancel by hand): ${trialErrorClass(err)}`,
      );
    }
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
    let trial =
      typeof sub.trial_start === 'number'
        ? trialStartPatch(purchase, sub, trialOwnCardOn(sub))
        : {};
    // B-TR8-120 — ONE SHARED TRIAL RULE: a trial first seen at its end claims
    // the ledger like any start; one that lost it to another purchase never
    // counts (it ended unpaid).
    if (trial.trial_started_at && this.trialUsage) {
      const won = await this.trialUsage.markStarted(client, {
        purchaseId: purchase.id,
        clientUserId: purchase.client_user_id,
        coachUserId: purchase.coach_user_id,
        packageId: purchase.package_id,
        trialDays: purchase.trial_days ?? 0,
        trialEndsAt: this.toDate(typeof sub.trial_end === 'number' ? sub.trial_end : null),
      });
      if (won === 'conflict') trial = {};
    }
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
        ...(unpaidAttempt ? { stripe_client_secret: null, stripe_ephemeral_key: null } : {}),
      },
    });
    // B-TRIALS (OR-113-2) — a trial that never started (no card saved) gives
    // the client their trial back; a started trial stays used.
    if (this.trialUsage) {
      await this.trialUsage.release(client, purchase.id, `subscription_${endedAs}`);
    }
    // B-TRIALS-3 (B-656-1) — Stripe confirmed the end: an owed conflict
    // cancellation is settled.
    if (this.trialConflicts) {
      await this.trialConflicts.markCancelled(client, purchase.id);
    }
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

    // Only claim if a pending purchase row references this payment intent.
    // PaymentSheet flow creates a pending ClientPurchase with the PI id set
    // by checkout.service.ts createPaymentIntentForClient().
    const purchase = await db.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id, status: 'pending' },
    });
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };
    // B-RECUR — the PaymentIntent of a native subscription's first invoice.
    // invoice.paid is the single owner of that purchase's entitlement and
    // settlement; flipping it to a one-time 'paid' here would mislabel a
    // renewing plan and settle it from a second path.
    if (purchase.billing_type === 'recurring' && purchase.stripe_subscription_id) {
      return { claimed: true, purchase_id: purchase.id, reason: 'subscription_invoice_owned_by_invoice_paid' };
    }

    const updated = await db.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'paid',
        entitlement_active: true,
        last_error: null,
      },
    });

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

  private async applyPaymentIntentFailed(
    event: StripeEvent,
    tx?: WebhookTx,
  ): Promise<CheckoutWebhookResult> {
    const pi = event.data.object as {
      id?: string;
      last_payment_error?: { message?: string };
      metadata?: Record<string, string>;
    };
    if (!pi?.id) return { claimed: false };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id },
    });
    if (!purchase) {
      // Try metadata fallback: tgp_package_id + tgp_client_user_id may be
      // present on the failing PI for a one_time package.
      const pkgId = pi.metadata?.tgp_package_id;
      const clientId = pi.metadata?.tgp_client_user_id;
      if (!pkgId || !clientId) return { claimed: false };
      const pending = await db.clientPurchase.findFirst({
        where: {
          package_id: pkgId,
          client_user_id: clientId,
          status: 'pending',
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false };
      // Never-entitled pending purchase — flip to payment_failed only.
      // Per PR-16 brief: PI-failed for a never-entitled purchase must NOT
      // cancel drops (none exist anyway; fanout was never run). Skip the
      // cancel call to keep the log line out of the never-entitled path.
      await db.clientPurchase.update({
        where: { id: pending.id },
        data: {
          status: 'payment_failed',
          entitlement_active: false,
          last_error: pi.last_payment_error?.message ?? 'payment_failed',
          stripe_payment_intent_id: pi.id,
        },
      });
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
    // Capture pre-flip entitlement: only entitled purchases have drops
    // worth canceling. A first-attempt PaymentSheet failure on a still-
    // pending purchase never minted drops; a later recurring-charge
    // failure on an already-entitled purchase did. Either way the cancel
    // call is idempotent — but skipping when wasEntitled=false matches
    // the brief's "PI-failed-never-entitled does not cancel" semantic
    // and keeps the log clean.
    const wasEntitled = !!purchase.entitlement_active;
    await db.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'payment_failed',
        entitlement_active: false,
        last_error: pi.last_payment_error?.message ?? 'payment_failed',
      },
    });
    if (this.fanout && wasEntitled) {
      await this.fanout.cancelPendingForPurchase(
        purchase.id,
        'payment_failed',
        (tx ?? (this.prisma as unknown as WebhookTx)),
      );
    }
    return { claimed: true, purchase_id: purchase.id };
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
    let trialConflictSubscriptionId: string | undefined;
    let trialNoticeId: string | undefined;
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
        const entitled = subscriptionGrantsAccess(fresh, live);
        const start = trialStartPatch(fresh, live, entitled);
        if (changed) {
          // B-680-1 — another delivery wrote the purchase after this Stripe
          // read (a revocation, a renewal period, a cancellation): a matching
          // state needs no write and the money below settles; anything else
          // is read again, never overwritten from the older read.
          const same =
            fresh.status === status &&
            fresh.entitlement_active === entitled &&
            sameInstant(fresh.current_period_end, currentPeriodEnd) &&
            !start.trial_started_at;
          if (same) return fresh;
          throw new WebhookRedeliverError(
            `invoice.paid: purchase=${fresh.id} changed during the Stripe read; redeliver`,
          );
        }
        // B-TRIALS / B-TR8-120 — a $0 trial invoice is "paid" before any card
        // is saved; the one shared trial rule decides, as on the
        // subscription event.
        const trial = await this.trialState(client, fresh, status, live, entitled, event.id);
        trialConflictSubscriptionId = trial.conflict ? live.id : undefined;
        trialNoticeId = trial.noticeId;
        return client.clientPurchase.update({
          where: { id: fresh.id },
          data: {
            status,
            entitlement_active: trial.entitled,
            ...(trial.owns ? trialStartPatch(fresh, live, trial.entitled) : {}),
            current_period_end: currentPeriodEnd,
            access_expires_at: this.computeAccessExpiry(pkg, fresh, true, currentPeriodEnd),
            last_error: null,
            ...trial.data,
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
    if (this.dunningV2) {
      try {
        await this.dunningV2.applyImmediateClear(updated.id, 'retry');
      } catch (err) {
        this.logger.warn(
          `dunningV2.applyImmediateClear failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    return {
      claimed: true,
      purchase_id: purchase.id,
      deferredSplit,
      ...(trialConflictSubscriptionId ? { trialConflictSubscriptionId } : {}),
      ...(trialNoticeId ? { deferredTrialNoticeId: trialNoticeId } : {}),
    };
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
