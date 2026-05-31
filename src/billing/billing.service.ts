import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { CoachTier, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StripeApiError, StripeApiService } from './stripe-api.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  CheckoutWebhookHandlerService,
  type DeferredSplitTask,
} from '../checkout/checkout-webhook-handler.service';
import { CoachAiCreditPackService } from '../ai-credits/coach-ai-credit-pack.service';
import { ConnectService } from '../connect/connect.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
// R43 Storefront Phase 1 — guest checkout webhook routing. Optional so
// the billing module still boots in environments that have not imported
// StorefrontModule (legacy tests, half-built deploys).
import { NotificationKind } from '../notifications/notification-kind';
import { NotificationsService } from '../notifications/notifications.service';
import { GUEST_CHECKOUT_METADATA_KEY, GuestCheckoutService } from '../storefront/guest-checkout.service';

// PR-2 P0-c — deep link the coach taps from the COACH_ALERT inbox to
// open the payment-ops surface where they can see the failed transfer.
const COACH_TRANSFER_FAILED_DEEP_LINK = 'tgp://coach/billing/transfers';

// BillingService is the system of record for the Stripe-mirror tables. The
// webhook controller hands it parsed Stripe event objects; this service
// applies them to CoachSubscription / Invoice / PaymentFailure rows.
//
// The mapping from a Stripe customer to our coach User is done via
// CoachProfile.stripe_customer_id. We refuse to mutate state when no coach
// can be resolved — better to log a warning than to silently overwrite the
// wrong row.

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
    private audit: AuditService,
    // ConnectService is @Optional() so the billing webhook handler still
    // boots in environments where ConnectModule was not imported (legacy
    // unit tests). When present, account.* events are forwarded to it.
    @Optional() private connect?: ConnectService,
    // CheckoutWebhookHandlerService claims checkout/session/subscription/
    // payment events that belong to a coach-package purchase. When it
    // claims an event, BillingService skips the SaaS-coach-subscription
    // handler for the same event so the two streams don't collide.
    @Optional() private checkoutWebhooks?: CheckoutWebhookHandlerService,
    // EmailService is @Optional() so legacy tests that hand-construct
    // BillingService without the email module still work. When present
    // it dispatches dunning email on invoice.payment_failed.
    @Optional() private email?: EmailService,
    // R43 — Optional so the billing module still boots when
    // StorefrontModule is not imported (e.g. minimal test wiring).
    @Optional() private guestCheckout?: GuestCheckoutService,
    // Stream 1 — Optional so legacy unit tests can boot BillingService
    // without wiring the AI credits module. When present, the pack
    // service claims checkout.session.completed events whose metadata
    // carries tgp_kind=coach_ai_credit_pack and routes them to
    // CoachAIBudgetService.applyCreditPack().
    @Optional() private coachAiPacks?: CoachAiCreditPackService,
    // PR-2 P0-c — Optional so legacy unit-test wiring that doesn't import
    // NotificationsModule still constructs BillingService. When present,
    // the transfer.failed handler alerts the affected coach via the
    // standard COACH_ALERT inbox channel.
    @Optional() private notifications?: NotificationsService,
    // B1 — StripeApiService backs the shared coach portal-session method
    // that both the v1 and mobile coach-billing controllers call. Optional
    // so legacy unit tests that hand-construct BillingService positionally
    // (webhook-only) still boot without wiring the Stripe API client.
    @Optional() private stripeApi?: StripeApiService,
  ) {}

  // Idempotently process an event. Returns { processed: true } on first
  // delivery, { processed: false, alreadyProcessed: true } on duplicates.
  //
  // Audit #4 P1-1 — transactional integrity: the dedup-row insert and ALL
  // domain writes for this delivery run inside a single Prisma
  // `$transaction`. If any handler throws, the transaction rolls back —
  // the dedup row is undone, the domain writes are undone, and we
  // re-throw. The webhook controller then returns non-2xx and Stripe
  // retries the same event id until the transaction commits. We never
  // acknowledge an event whose side effects failed to commit.
  //
  // External handlers (CheckoutWebhookHandlerService, GuestCheckoutService)
  // run inside the same try/catch — if they throw we propagate. They
  // currently manage their own internal transactions; their writes
  // commit when they return success. The dedup row commits last on
  // success, so a partial external-handler failure cannot leave the
  // dedup row claimed.
  // A276-P1-3 — pre-resolves the Stripe-hosted receipt_url for a
  // guest-checkout payment_intent.succeeded event BEFORE the outer
  // $transaction opens. Returns { id, chargeId, receiptUrl } when the
  // event is a guest-checkout PI; null otherwise. Failures (Stripe blip,
  // unrelated event) are absorbed and surface as null — the inner
  // handler still has its own resolveReceiptUrl fallback path, so a
  // pre-resolve miss degrades cleanly to the legacy in-tx lookup. The
  // method is only called when the event type is payment_intent.succeeded
  // and the metadata flag identifies a guest-checkout PI.
  private async preResolveReceiptUrl(
    event: StripeEvent,
  ): Promise<{
    id: string;
    chargeId: string | null;
    receiptUrl: string | null;
  } | null> {
    if (event.type !== 'payment_intent.succeeded') return null;
    if (!this.guestCheckout) return null;
    const pi = event.data.object as {
      id?: string;
      metadata?: Record<string, string>;
      latest_charge?: string | { id?: string; receipt_url?: string } | null;
      charges?: { data?: Array<{ id?: string; receipt_url?: string }> };
    };
    if (!pi?.id || !pi.metadata?.[GUEST_CHECKOUT_METADATA_KEY]) return null;

    // Extract whatever the event payload already carries so the inner
    // resolver short-circuits without an HTTP round-trip when possible.
    let chargeId: string | null = null;
    let receiptUrl: string | null = null;
    if (typeof pi.latest_charge === 'string') {
      chargeId = pi.latest_charge;
    } else if (pi.latest_charge && typeof pi.latest_charge === 'object') {
      chargeId = pi.latest_charge.id ?? null;
      receiptUrl = pi.latest_charge.receipt_url ?? null;
    }
    if (!receiptUrl && pi.charges?.data?.[0]) {
      chargeId = chargeId ?? pi.charges.data[0].id ?? null;
      receiptUrl = pi.charges.data[0].receipt_url ?? null;
    }

    try {
      // resolveReceiptUrl is best-effort and never throws — it returns
      // null on any Stripe error after logging a warning. We still wrap
      // in try/catch as defence-in-depth so a future regression in the
      // helper can never propagate up and roll the dedup row back.
      const resolved = await this.guestCheckout.resolveReceiptUrl(pi.id, {
        chargeId,
        receiptUrl,
      });
      return { id: pi.id, chargeId, receiptUrl: resolved };
    } catch (err) {
      this.logger.warn(
        `preResolveReceiptUrl: lookup failed for pi=${pi.id}: ${(err as Error).message}`,
      );
      return { id: pi.id, chargeId, receiptUrl };
    }
  }

  async handleEvent(event: StripeEvent) {
    if (!event?.id || !event?.type) {
      return { processed: false, reason: 'malformed' };
    }

    // Fast-path duplicate check OUTSIDE any transaction so concurrent
    // deliveries of the same event don't both open a transaction that
    // will race on the unique index. The authoritative dedup is still
    // the unique-index INSERT inside the transaction below.
    const existing = await this.prisma.stripeProcessedEvent.findUnique({
      where: { stripe_event_id: event.id },
      select: { stripe_event_id: true, handler_completed_at: true },
    });
    if (existing) {
      return { processed: false, alreadyProcessed: true };
    }

    // A276-P1-3 — pre-resolve the Stripe-hosted receipt_url BEFORE the
    // outer $transaction opens. Stripe API 2024-09-30.acacia event
    // payloads only carry latest_charge as a string id (the charges
    // attribute was removed by Stripe in 2022-11-15), so the historical
    // path inside GuestCheckoutService.resolveReceiptUrl ALWAYS did a
    // synchronous Stripe HTTP retrieveCharge inside the outer
    // $transaction — holding the Postgres connection for the full
    // round-trip (200ms–2s typical, Prisma's default interactive
    // transaction timeout is 5s). Under any Stripe slowness this
    // saturated the pool and triggered Stripe webhook retries on
    // rollback. Doing the lookup here keeps the URL in the welcome
    // email AND keeps the DB transaction Stripe-HTTP-free. Best-effort:
    // a Stripe blip leaves preResolved.receiptUrl null and the welcome
    // email simply omits the "View receipt" line (degraded, not broken).
    const preResolved = await this.preResolveReceiptUrl(event);

    // PR-18 B1 — pre-resolve any Stripe HTTP state the checkout webhook
    // handler needs INSIDE the outer $transaction (currently the
    // invoice-renewal subscription resync) BEFORE the transaction opens.
    // The handler takes a CoachPackage `FOR UPDATE` lock on the recurring
    // activation path; performing Stripe HTTP after that lock is acquired —
    // or anywhere inside the outer tx — would hold the Postgres connection
    // across a Stripe round-trip (A276-P1-3). Mirrors preResolveReceiptUrl.
    // Best-effort and never throws.
    // Guard the method reference: legacy/unit-test wiring may stub
    // checkoutWebhooks with only a `handle` fn and no prefetch method.
    const checkoutPrefetch =
      this.checkoutWebhooks &&
      typeof this.checkoutWebhooks.prefetchForOuterTx === 'function'
        ? await this.checkoutWebhooks.prefetchForOuterTx(event)
        : undefined;

    // PR-9 — purchase ids whose immediate drops were materialised inside
    // the outer tx and whose drip alerts (push + in-app, decision #9)
    // need to be flushed AFTER commit. Failing to send an alert MUST
    // NEVER roll back entitlement, so the alert dispatch is moved
    // outside the $transaction.
    let dripAlertPurchaseId: string | null = null;

    // PR-18 B1 R3 P1 — head-coach split posting that the checkout webhook
    // handler DEFERRED because this outer $transaction (and the CoachPackage
    // FOR UPDATE lock the activation takes) was held when the charge
    // succeeded. onChargeSucceeded resolves the parent charge id
    // (retrievePaymentIntent) and may post the head-coach Transfer
    // (createTransfer) — both Stripe HTTP. Running them inside the tx would
    // hold the Postgres connection (and the package row lock) across a Stripe
    // round-trip (the no-Stripe-HTTP-in-DB-tx gate, worse under B1). The
    // handler pre-resolves the charge id out-of-tx in prefetchForOuterTx and
    // hands back this descriptor; we run the posting AFTER the tx commits.
    // The split ledger is idempotent and the transfer is idempotency-keyed +
    // sweeper-backed, so a rolled-back tx simply skips this (the descriptor
    // is captured but never executed) and Stripe's redelivery reconciles.
    let deferredSplit: DeferredSplitTask | null = null;

    // PR-14 R2 P0-1 — recurring/combo guest subscription backstop. The
    // PI-succeeded route is the primary trigger for converting a guest
    // recurring purchase. This is the secondary trigger when Stripe
    // delivers the subscription/invoice event first (or the PI event is
    // lost). Computed inside the try block once we know the event id,
    // captured here so the post-commit fire-and-forget can see it.
    const guestSubFallbackRef: { value: { guest_checkout_id: string; payment_intent_id: string } | null } = {
      value: null,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        // Insert the dedup row INSIDE the transaction. A concurrent
        // delivery that started before this transaction commits will
        // either (a) see the row in its own findUnique fast-path above
        // and short-circuit, or (b) lose the unique-constraint race
        // here and we translate that to an alreadyProcessed return.
        await tx.stripeProcessedEvent.create({
          data: { stripe_event_id: event.id, type: event.type },
        });

        // Phase 2-3 Connect — give the checkout handler first refusal
        // on events that may belong to a coach-package purchase. If it
        // throws we propagate so the outer transaction rolls back and
        // Stripe retries. The checkout handler manages its own writes
        // via this.prisma; until its API is refactored to accept a
        // TransactionClient those writes are not inside this tx, but
        // any failure still surfaces here so we never ack a failed
        // side effect.
        // PR-9 — plumb the outer tx through to the checkout webhook
        // handler so applyCheckoutCompleted / applyPaymentIntentSucceeded
        // can run entitlement+fanout (drop seed + immediate-cadence
        // inline materialisation) inside this $transaction. A resolver
        // failure on an immediate drop now rolls back this whole tx
        // (including the StripeProcessedEvent dedup row), Stripe
        // retries the event id, and the per-row uniques make the
        // retry safe. See PR9_BUILD_REPORT for the atomicity contract.
        let claimedByCheckout = false;
        if (this.checkoutWebhooks) {
          const result = await this.checkoutWebhooks.handle(
            event,
            tx,
            checkoutPrefetch,
          );
          claimedByCheckout = !!result.claimed;
          if (result.claimed && result.purchase_id) {
            dripAlertPurchaseId = result.purchase_id;
          }
          // PR-18 B1 R3 P1 — capture any deferred split posting; run it
          // post-commit (below) so no Stripe HTTP fires inside this tx.
          if (result.deferredSplit) {
            deferredSplit = result.deferredSplit;
          }
        }

        // Stream 1 — give the AI credit-pack handler first refusal on
        // checkout.session.completed / .expired events. It only claims
        // events whose metadata carries `tgp_kind=coach_ai_credit_pack`,
        // so other checkout flows (storefront, SaaS subscription) are
        // unaffected. Audit P0-6 fix: we now thread the outer `tx` into
        // handleStripeEvent so applyCreditPack commits in the SAME
        // transaction as the dedup row. If the outer tx rolls back, the
        // credit-apply rolls back too — restoring proper atomic
        // semantics. Stripe retries the same event id and the
        // schema-level @unique on stripe_checkout_session_id + the
        // `existing.status === 'paid'` early-return keep the retry path
        // idempotent.
        let claimedByAiPack = false;
        if (this.coachAiPacks) {
          const result = await this.coachAiPacks.handleStripeEvent(event, tx);
          claimedByAiPack = !!result.claimed;
        }

        // PR-14 R2 P0-1 — pre-compute the GuestCheckout-by-subscription
        // claim signal for subscription/invoice events. The recurring
        // guest path stores stripe_subscription_id on the GuestCheckout
        // sentinel at mint time; if we see a subscription/invoice event
        // whose subscription id matches a sentinel AND no ClientPurchase
        // exists yet, the PI-succeeded path is the primary trigger (see
        // above). This branch is a BACKSTOP for the case where Stripe
        // delivers the subscription event before the PI event (rare but
        // observed in practice on the customer.subscription.created edge
        // and on lost-PI-webhook recoveries). We pull the sentinel's PI
        // id and route to handlePaymentSucceeded; that path is fully
        // idempotent vs the PI-succeeded primary route via the
        // pending→paid updateMany claim in handlePaymentSucceeded.
        guestSubFallbackRef.value = await this.maybeResolveGuestBySubscriptionEvent(event);

        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
            if (!claimedByCheckout) await this.applySubscription(event, tx);
            break;
          case 'customer.subscription.deleted':
            if (!claimedByCheckout) await this.applySubscriptionDeleted(event, tx);
            break;
          case 'invoice.paid':
            if (!claimedByCheckout) await this.applyInvoicePaid(event, tx);
            break;
          case 'invoice.payment_failed':
            if (!claimedByCheckout) await this.applyInvoicePaymentFailed(event, tx);
            break;
          case 'customer.updated':
            if (!claimedByCheckout) await this.applyCustomerUpdated(event, tx);
            break;
          case 'checkout.session.completed':
          case 'checkout.session.expired':
            // Already dispatched to checkoutWebhooks + coachAiPacks above.
            // `claimedByAiPack` is intentionally referenced here so the
            // variable is not flagged as unused by TS strict mode.
            void claimedByAiPack;
            break;
          case 'payment_intent.succeeded': {
            // A276-P0-2 — pass the latest_charge id alongside the PI id so
            // GuestCheckoutService can fetch the Stripe-hosted receipt_url
            // from the Charge object. Stripe API 2024-09-30.acacia returns
            // latest_charge as a charge id string on the PaymentIntent.
            const pi = event.data.object as {
              id?: string;
              metadata?: Record<string, string>;
              latest_charge?: string | { id?: string; receipt_url?: string } | null;
              charges?: { data?: Array<{ id?: string; receipt_url?: string }> };
            };
            // PR-14 R2 P0-1 — the recurring/combo guest path mints a Stripe
            // Subscription whose first-invoice PaymentIntent does NOT carry
            // GUEST_CHECKOUT_METADATA_KEY (Stripe does not copy Subscription
            // metadata onto its child PaymentIntents). We therefore route
            // through metadata when present, and FALL BACK to a direct
            // GuestCheckout lookup by stripe_payment_intent_id when not —
            // that's the same key handlePaymentSucceeded itself uses to
            // claim pending→paid. Without this fallback the recurring
            // guest leg silently never converts: Stripe takes the money,
            // GuestCheckout stays pending, ClientPurchase is never created,
            // entitlement never flips, fan-out never fires.
            let guestRouteHit =
              !!this.guestCheckout &&
              !!pi?.id &&
              !!pi.metadata?.[GUEST_CHECKOUT_METADATA_KEY];
            if (!guestRouteHit && this.guestCheckout && pi?.id) {
              try {
                const sentinel = await this.prisma.guestCheckout.findUnique({
                  where: { stripe_payment_intent_id: pi.id },
                  select: { id: true },
                });
                if (sentinel) guestRouteHit = true;
              } catch (err) {
                this.logger.warn(
                  `payment_intent.succeeded GuestCheckout fallback lookup failed for ${pi.id}: ${(err as Error).message}`,
                );
              }
            }
            if (this.guestCheckout && pi?.id && guestRouteHit) {
              // Prefer the expanded latest_charge (object form) so a
              // single webhook delivery never has to hit Stripe again for
              // the receipt URL. Fall back to charges.data[0] for older
              // event shapes; final fallback is a charge id string the
              // handler can retrieve.
              let chargeId: string | null = null;
              let receiptUrl: string | null = null;
              if (typeof pi.latest_charge === 'string') {
                chargeId = pi.latest_charge;
              } else if (pi.latest_charge && typeof pi.latest_charge === 'object') {
                chargeId = pi.latest_charge.id ?? null;
                receiptUrl = pi.latest_charge.receipt_url ?? null;
              }
              if (!receiptUrl && pi.charges?.data?.[0]) {
                chargeId = chargeId ?? pi.charges.data[0].id ?? null;
                receiptUrl = pi.charges.data[0].receipt_url ?? null;
              }
              // A276-P1-3 — prefer the pre-resolved URL from the
              // outside-tx Stripe lookup. handlePaymentSucceeded's
              // resolveReceiptUrl short-circuits on a valid https URL
              // so no Stripe HTTP call fires inside this transaction.
              //
              // A276-F2-P2-1 — also signal `preResolveAttempted` so the
              // inner resolveReceiptUrl does NOT issue a SECOND Stripe
              // HTTP call on the degraded path (preResolve returned a
              // non-null record but receiptUrl was null because the
              // outside-tx Stripe lookup failed). On a continuing Stripe
              // outage that second attempt would also block while the
              // outer $transaction holds its Postgres connection —
              // exactly the in-tx HTTP anti-pattern P1-3 was meant to
              // eliminate. With the flag set, the inner resolver returns
              // null immediately; the welcome email omits the receipt
              // line and a future backfill job can fill it in.
              let preResolveAttempted = false;
              if (!receiptUrl && preResolved && preResolved.id === pi.id) {
                receiptUrl = preResolved.receiptUrl;
                chargeId = chargeId ?? preResolved.chargeId;
                preResolveAttempted = true;
              }
              await this.guestCheckout.handlePaymentSucceeded(
                pi.id,
                { chargeId, receiptUrl, preResolveAttempted },
              );
            }
            break;
          }
          case 'payment_intent.payment_failed': {
            const pi = event.data.object as {
              id?: string;
              metadata?: Record<string, string>;
            };
            // PR-14 R2 P0-1 — same metadata-or-by-PI-id fallback the
            // succeeded branch uses, so recurring guest failures route to
            // handlePaymentFailed instead of silently leaking pending rows.
            let guestRouteHit =
              !!this.guestCheckout &&
              !!pi?.id &&
              !!pi.metadata?.[GUEST_CHECKOUT_METADATA_KEY];
            if (!guestRouteHit && this.guestCheckout && pi?.id) {
              try {
                const sentinel = await this.prisma.guestCheckout.findUnique({
                  where: { stripe_payment_intent_id: pi.id },
                  select: { id: true },
                });
                if (sentinel) guestRouteHit = true;
              } catch (err) {
                this.logger.warn(
                  `payment_intent.payment_failed GuestCheckout fallback lookup failed for ${pi.id}: ${(err as Error).message}`,
                );
              }
            }
            if (this.guestCheckout && pi?.id && guestRouteHit) {
              await this.guestCheckout.handlePaymentFailed(pi.id);
            }
            break;
          }
          // r48 #1 — log requires_action but don't treat as failure.
          // Stripe Elements drives the 3DS challenge on the client; the
          // payment ultimately resolves to succeeded or payment_failed.
          case 'payment_intent.requires_action': {
            const pi = event.data.object as { id?: string };
            this.logger.log(
              `payment_intent.requires_action received for ${pi?.id ?? 'unknown'} — 3DS in progress on client`,
            );
            break;
          }
          // r48 #13 — refund webhook.  CheckoutWebhookHandlerService
          // (above) claims this event when it maps to a ClientPurchase;
          // if it didn't claim, fall back to the GuestCheckout path so
          // a guest refund flips status='refunded' + refunded_at and
          // surfaces to the coach via the existing notifications path.
          case 'charge.refunded': {
            if (claimedByCheckout) break;
            if (!this.guestCheckout) break;
            const charge = event.data.object as {
              payment_intent?: string;
              amount?: number;
              amount_refunded?: number;
            };
            if (!charge.payment_intent) break;
            await this.guestCheckout.handleChargeRefunded(
              charge.payment_intent,
              typeof charge.amount === 'number' ? charge.amount : 0,
              typeof charge.amount_refunded === 'number'
                ? charge.amount_refunded
                : 0,
            );
            break;
          }
          // r48 #13 — dispute opened.  Same fall-through semantics as
          // charge.refunded above.
          case 'charge.dispute.created': {
            if (claimedByCheckout) break;
            if (!this.guestCheckout) break;
            const dispute = event.data.object as {
              payment_intent?: string;
              reason?: string;
            };
            if (!dispute.payment_intent) break;
            await this.guestCheckout.handleDisputeOpened(
              dispute.payment_intent,
              dispute.reason ?? null,
            );
            break;
          }
          case 'account.updated':
          case 'capability.updated':
            await this.applyConnectAccountUpdated(event, tx);
            break;
          case 'account.application.deauthorized':
            await this.applyConnectAccountDeauthorized(event, tx);
            break;
          // PR-2 P0-c — Stripe Connect head-coach split-transfer failure.
          // Previously fell through to `default` and was silently dropped,
          // so a failed payout to a head coach surfaced only by squinting
          // at Stripe directly. Now we persist status='failed' on the
          // ConnectTransfer row (and capture Stripe's failure_message in
          // last_error) and alert the affected coach via COACH_ALERT.
          case 'transfer.failed':
            await this.applyTransferFailed(event, tx);
            break;
          // B7 — Stripe Connect PAYOUT failure (coach's Stripe balance →
          // their bank). Distinct from transfer.failed (platform → coach
          // balance): a payout.failed/canceled means money the coach
          // believed was on its way to their bank did NOT arrive. These
          // previously fell through to `default` and were dedup-swallowed,
          // so a coach saw no signal that their bank deposit bounced. We
          // now persist status='failed'/'canceled' onto the cached
          // PayoutSnapshot row and alert the coach via the existing
          // COACH_ALERT kind. (No money math; no new notification kind.)
          case 'payout.failed':
          case 'payout.canceled':
            await this.applyPayoutFailed(event, tx);
            break;
          default:
            this.logger.log(`Ignoring unhandled Stripe event type: ${event.type}`);
        }

        // Mark handler-complete in the SAME transaction so the row is
        // never visible with handler_completed_at = NULL on commit.
        await tx.stripeProcessedEvent.updateMany({
          where: {
            stripe_event_id: event.id,
            handler_completed_at: null,
          },
          data: { handler_completed_at: new Date() },
        });
      });
    } catch (err) {
      // If the failure is a unique-constraint violation, a concurrent
      // delivery beat us to the insert; treat as duplicate.
      if (this.isUniqueViolation(err)) {
        return { processed: false, alreadyProcessed: true };
      }
      // Any other error: roll back (already done by Prisma) and re-throw
      // so the controller returns non-2xx. Stripe will retry the same
      // event id and the next attempt will commit cleanly once the
      // transient cause clears.
      this.logger.error(
        `Stripe event handler failed event=${event.id} type=${event.type}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      // PR-9 R1 audit-fix (P2-1) — operator-observability runbook hint
      // for rollback-and-retry. The outer $transaction rolled back, but
      // three classes of side-effect may have ALREADY committed on
      // `this.prisma` outside this tx and will outlive the rollback
      // until Stripe redelivers the event:
      //   1. Splits ledger (`SplitLedgerEntry`, `ConnectTransfer`) —
      //      idempotent via composite-unique upserts + Stripe
      //      idempotency-key + the sweeper. Safe across retry; the
      //      ledger row remains visible against a purchase whose
      //      entitlement_active is back to false until the retry
      //      commits.
      //   2. Workout assignments — gated by the
      //      `WorkoutBuilderIdempotencyKey` ledger keyed on
      //      `drip:workout:p={purchase}:c={content}` (stable across
      //      retry); a retry collapses onto the cached row.
      //   3. Auto-messages — gated by `DripResolverMarker(purpose=
      //      'auto_message', purchase_id, content_id)`; a retry
      //      collapses onto the cached message id.
      // If you are an oncall investigator hitting a rollback storm:
      // check these three tables for orphan rows tied to the failing
      // purchase id (when known) before manually retrying anything.
      if (dripAlertPurchaseId) {
        this.logger.warn(
          `tx-rollback observability: event=${event.id} type=${event.type} purchase=${dripAlertPurchaseId} — splits/workout-ledger/auto-message-markers committed outside the outer tx will be reconciled by Stripe retry + per-resolver stable-key idempotency; check SplitLedgerEntry, WorkoutBuilderIdempotencyKey (key=drip:workout:p=${dripAlertPurchaseId}:c=*), DripResolverMarker(purpose=auto_message, purchase_id=${dripAlertPurchaseId}) on persistent failure`,
        );
      }
      // PR-9 — drop the in-memory alert bucket for the rolled-back
      // purchase so the inevitable Stripe retry doesn't double-alert
      // alongside the new bucket the retry produces.
      if (
        dripAlertPurchaseId &&
        this.checkoutWebhooks &&
        typeof this.checkoutWebhooks.discardPendingDripAlerts === 'function'
      ) {
        try {
          this.checkoutWebhooks.discardPendingDripAlerts(dripAlertPurchaseId);
        } catch {
          // best-effort
        }
      }
      throw err;
    }

    // PR-9 — outer tx COMMITTED. Now fire-and-forget the drop alerts
    // for any drops materialised inline at checkout. This MUST be
    // outside the tx so a push provider blip cannot roll back money;
    // the hook itself swallows errors internally. Feature-detected so
    // legacy test wiring that stubs CheckoutWebhookHandlerService
    // without the new methods still works.
    if (
      dripAlertPurchaseId &&
      this.checkoutWebhooks &&
      typeof this.checkoutWebhooks.flushDripAlerts === 'function'
    ) {
      try {
        this.checkoutWebhooks.flushDripAlerts(dripAlertPurchaseId);
      } catch (err) {
        this.logger.warn(
          `drip alert flush failed purchase=${dripAlertPurchaseId}: ${(err as Error).message}`,
        );
      }
    }

    // PR-18 B1 R3 P1 — outer tx COMMITTED. Now run any head-coach split
    // posting the checkout handler deferred. This is the FIRST point at which
    // the CoachPackage FOR UPDATE lock is released and no DB transaction is
    // open, so the Stripe HTTP inside onChargeSucceeded (retrievePaymentIntent
    // + createTransfer) no longer holds the Postgres connection. The handler
    // pre-resolved the charge id out-of-tx, so the typical post-commit run
    // issues only the transfer POST. Failure-isolated (runDeferredSplit never
    // throws): the split ledger is idempotent and the transfer is
    // idempotency-keyed + sweeper-backed, so a transient Stripe failure is
    // retried by the sweeper rather than rolling back committed entitlement.
    if (
      deferredSplit &&
      this.checkoutWebhooks &&
      typeof this.checkoutWebhooks.runDeferredSplit === 'function'
    ) {
      await this.checkoutWebhooks.runDeferredSplit(deferredSplit);
    }

    // PR-14 R2 P0-1 — BACKSTOP for recurring guest checkouts. The PI
    // event is the PRIMARY trigger (see payment_intent.succeeded above),
    // but Stripe sometimes delivers the customer.subscription.created /
    // updated / invoice.paid event first. When a subscription/invoice
    // event lands and no ClientPurchase claim was made by the checkout
    // handler, look up the matching GuestCheckout sentinel by
    // stripe_subscription_id and drive `handlePaymentSucceeded` against
    // its persisted first-invoice PI id. That call is idempotent vs the
    // primary PI route — it claims pending→paid via updateMany, and a
    // double-fire is collapsed by the next claim returning count:0.
    const subFallback = guestSubFallbackRef.value;
    if (subFallback !== null && this.guestCheckout) {
      const piId = subFallback.payment_intent_id;
      if (piId) {
        try {
          await this.guestCheckout.handlePaymentSucceeded(piId);
        } catch (err) {
          this.logger.warn(
            `guest subscription fallback handlePaymentSucceeded failed pi=${piId}: ${(err as Error).message}`,
          );
        }
      }
    }
    return { processed: true };
  }

  // PR-14 R2 P0-1 — given a subscription/invoice event, returns the
  // GuestCheckout sentinel's first-invoice PaymentIntent id if a sentinel
  // exists with `stripe_subscription_id` matching the event's subscription
  // id. We use this only as a BACKSTOP — the primary trigger for
  // converting a recurring guest is `payment_intent.succeeded` (which we
  // already route via the by-PI-id fallback). The subscription/invoice
  // route lets us recover from the event-order edge cases where Stripe
  // delivers the subscription event before the PI event, or where the PI
  // event was lost.
  //
  // Returns null when:
  //   - the event has no subscription id;
  //   - no GuestCheckout sentinel matches;
  //   - the sentinel has no real PI id (still on `pending_<key>` stub);
  //   - the sentinel is already in a terminal state (don't re-trigger).
  private async maybeResolveGuestBySubscriptionEvent(
    event: StripeEvent,
  ): Promise<{ guest_checkout_id: string; payment_intent_id: string } | null> {
    if (!this.guestCheckout) return null;
    let subId: string | undefined;
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const sub = event.data.object as { id?: string };
      subId = sub?.id;
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const inv = event.data.object as {
        subscription?: string | { id?: string } | null;
      };
      if (typeof inv?.subscription === 'string') {
        subId = inv.subscription;
      } else if (inv?.subscription && typeof inv.subscription === 'object') {
        subId = inv.subscription.id ?? undefined;
      }
    }
    if (!subId) return null;
    try {
      const sentinel = await this.prisma.guestCheckout.findUnique({
        where: { stripe_subscription_id: subId },
        select: {
          id: true,
          stripe_payment_intent_id: true,
          status: true,
        },
      });
      if (!sentinel) return null;
      if (sentinel.stripe_payment_intent_id.startsWith('pending_')) {
        // Sentinel never made it past the synthetic placeholder — no PI
        // to resume against. The mint path patches the row with the real
        // PI id before returning; arriving here means the mint crashed
        // mid-flight. The lost-webhook reconciler's new
        // subscription-aware branch (`reconcileRecurringStuckSentinel`)
        // handles this case.
        return null;
      }
      // Only re-trigger if the row is in a state that hasn't yet been
      // converted. paid / converted / refunded / disputed are already
      // post-conversion; pending/conversion_failed_retryable are the
      // states where running handlePaymentSucceeded is meaningful.
      if (
        sentinel.status !== 'pending' &&
        sentinel.status !== 'conversion_failed_retryable'
      ) {
        return null;
      }
      return {
        guest_checkout_id: sentinel.id,
        payment_intent_id: sentinel.stripe_payment_intent_id,
      };
    } catch (err) {
      this.logger.warn(
        `maybeResolveGuestBySubscriptionEvent lookup failed sub=${subId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // Detects Prisma's unique-constraint violation (P2002). Falls back to a
  // message regex so the in-memory test stub can simulate it without
  // importing Prisma's runtime error classes.
  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    if (typeof e.message === 'string' && /unique constraint/i.test(e.message)) {
      return true;
    }
    return false;
  }

  // Resolve coach by stripe customer id via CoachProfile. Accepts a
  // Prisma TransactionClient so the lookup participates in the outer
  // webhook transaction — same connection, same isolation level, no
  // read-after-write skew.
  private async resolveCoachByCustomer(
    customerId: string | undefined | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!customerId) return null;
    // CoachProfile.stripe_customer_id is not @unique on the canonical Phase 1A
    // shape (CoachSubscription owns the @unique on its own customer mirror),
    // so we use findFirst here. Order by created_at desc so that if two
    // profiles share the same customer id (duplicate Stripe customer creation
    // race) we consistently pick the most-recently created one.
    const profile = await db.coachProfile.findFirst({
      where: { stripe_customer_id: customerId },
      orderBy: { created_at: 'desc' },
    });
    return profile?.user_id ?? null;
  }

  private toDate(seconds: unknown): Date | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  }

  private async applySubscription(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const sub = event.data.object as {
      id?: string;
      customer?: string;
      status?: string;
      current_period_end?: number;
      trial_end?: number | null;
      cancel_at_period_end?: boolean;
      items?: { data?: Array<{ price?: { id?: string } }> };
    };
    if (!sub?.id || !sub?.customer) {
      this.logger.warn(`Subscription event ${event.id} missing id/customer`);
      return;
    }
    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    const status = sub.status ?? 'incomplete';

    // Hybrid pricing (spec §9): set tier based on subscription status.
    //   active | trialing      → tier='pro' (subscribe/upgrade)
    //   canceled | incomplete_expired → tier='free' (explicit downgrade)
    //   past_due               → no tier change (guard handles 7-day grace)
    //   incomplete | unpaid    → no tier change
    //
    // IMPORTANT — no accidental Pro→free downgrade on past_due:
    //   past_due → tier stays 'pro' in the DB
    //   → SubscriptionGuard handles the 7-day grace window (spec §6)
    // This ensures a momentary payment failure does not strip Pro access.
    let tierUpdate: { tier?: CoachTier } = {};
    if (status === 'active' || status === 'trialing') {
      tierUpdate = { tier: CoachTier.pro };
    } else if (status === 'canceled' || status === 'incomplete_expired') {
      tierUpdate = { tier: CoachTier.free };
    }
    // past_due: no tier change — guard handles grace
    // incomplete/unpaid: no tier change
    // Keep backward-compat alias for the create/update spread below:
    const tierForActiveSubscription = tierUpdate.tier;

    // Profile lookup + subscription upsert run inside the outer webhook
    // transaction (passed in as `tx`). Concurrent created+updated
    // deliveries cannot interleave the read and the write, which would
    // cross-link subscription IDs to the wrong coach row.
    const profile = await tx.coachProfile.findFirst({
      where: { stripe_customer_id: sub.customer },
      orderBy: { created_at: 'desc' },
    });
    const coachId = profile?.user_id ?? null;
    if (coachId) {
      await tx.coachSubscription.upsert({
        where: { coach_id: coachId },
        create: {
          coach_id: coachId,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status,
          // Set tier per status: pro on active/trialing, free on canceled/
          // incomplete_expired, schema-default 'free' on first create otherwise.
          ...(tierForActiveSubscription !== undefined
            ? { tier: tierForActiveSubscription }
            : {}),
          current_period_end: this.toDate(sub.current_period_end),
          trial_end: this.toDate(sub.trial_end ?? null),
          cancel_at_period_end: !!sub.cancel_at_period_end,
        },
        update: {
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status,
          // Set tier per status: active|trialing → pro, canceled|
          // incomplete_expired → free, past_due/incomplete → no change
          // (leave existing tier value unchanged in the DB).
          ...(tierForActiveSubscription !== undefined
            ? { tier: tierForActiveSubscription }
            : {}),
          current_period_end: this.toDate(sub.current_period_end),
          trial_end: this.toDate(sub.trial_end ?? null),
          cancel_at_period_end: !!sub.cancel_at_period_end,
        },
      });
    }
    if (!coachId) {
      this.logger.warn(
        `Subscription ${sub.id} for unknown customer ${sub.customer}`,
      );
      return;
    }
    this.analytics.capture(coachId, Events.SUBSCRIPTION_UPDATED, {
      stripe_event_type: event.type,
      status,
      stripe_price_id: priceId,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      had_trial: !!sub.trial_end,
    });
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_UPDATED,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'coach_subscription',
      targetId: sub.id,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_customer_id: sub.customer,
        stripe_price_id: priceId,
        status,
        cancel_at_period_end: !!sub.cancel_at_period_end,
      },
    });
  }

  private async applySubscriptionDeleted(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const sub = event.data.object as { id?: string; customer?: string };
    const coachId = await this.resolveCoachByCustomer(sub?.customer, tx);
    if (!coachId) return;
    // Hybrid pricing (spec §9): on subscription deleted, set tier='free'.
    // Do NOT delete the row — preserves audit trail and stripe_customer_id
    // for reactivation (spec §9: "never delete the row").
    //
    // Why tier='free' here but NOT on past_due:
    //   Deleted = coach explicitly canceled or Stripe gave up after retries.
    //   past_due = transient payment failure. The 7-day grace window in
    //   SubscriptionGuard (§6) handles past_due. The tier in DB stays 'pro'
    //   during past_due so a card update can restore access without re-checkout.
    //
    // Use updateMany (not update) so that an out-of-order delete event for a
    // coach with no subscription row is a graceful no-op rather than a P2025
    // throw. updateMany with 0 matching rows silently does nothing.
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: {
        status: 'canceled',
        cancel_at_period_end: false,
        tier: CoachTier.free,
        updated_at: new Date(),
      },
    });
    this.analytics.capture(coachId, Events.SUBSCRIPTION_CANCELED, {});
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_CANCELED,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'coach_subscription',
      targetId: sub?.id ?? null,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_customer_id: sub?.customer ?? null,
      },
    });
  }

  private async applyInvoicePaid(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const inv = event.data.object as {
      id?: string;
      customer?: string;
      amount_paid?: number;
      amount_due?: number;
      currency?: string;
      hosted_invoice_url?: string;
      invoice_pdf?: string;
      period_start?: number;
      period_end?: number;
      status?: string;
      status_transitions?: { paid_at?: number };
    };
    if (!inv?.id) return;
    const coachId = await this.resolveCoachByCustomer(inv.customer, tx);
    if (!coachId) return;
    await tx.invoice.upsert({
      where: { stripe_invoice_id: inv.id },
      create: {
        coach_id: coachId,
        stripe_invoice_id: inv.id,
        stripe_customer_id: inv.customer ?? null,
        amount_paid_cents: inv.amount_paid ?? 0,
        amount_due_cents: inv.amount_due ?? 0,
        currency: inv.currency ?? 'usd',
        status: inv.status ?? 'paid',
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        invoice_pdf: inv.invoice_pdf ?? null,
        period_start: this.toDate(inv.period_start),
        period_end: this.toDate(inv.period_end),
        paid_at: this.toDate(inv.status_transitions?.paid_at) ?? new Date(),
      },
      update: {
        amount_paid_cents: inv.amount_paid ?? 0,
        status: inv.status ?? 'paid',
        paid_at: this.toDate(inv.status_transitions?.paid_at) ?? new Date(),
      },
    });
    // Clear payment failure state. If the subscription was past_due (set by
    // invoice.payment_failed), restore it to active so the guard allows
    // access immediately without waiting for a customer.subscription.updated
    // event (which Stripe may deliver slightly later).
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: { last_payment_failed_at: null, failed_payments_this_month: 0 },
    });
    // Restore status if invoice payment resolved a past_due state.
    // We only upgrade past_due → active, never touch canceled/paused/trialing.
    // The authoritative status arrives via customer.subscription.updated;
    // this is a best-effort recovery that removes the lockout immediately.
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId, status: 'past_due' },
      data: { status: 'active' },
    });
    // Stripe-sourced amounts only — these are real revenue, not synthesized.
    this.analytics.capture(coachId, Events.INVOICE_PAID, {
      amount_paid_cents: inv.amount_paid ?? 0,
      currency: inv.currency ?? 'usd',
    });
    await this.audit.write({
      action: AuditAction.BILLING_INVOICE_PAID,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'invoice',
      targetId: inv.id,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_invoice_id: inv.id,
        amount_paid_cents: inv.amount_paid ?? 0,
        currency: inv.currency ?? 'usd',
      },
    });
  }

  private async applyInvoicePaymentFailed(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const inv = event.data.object as {
      id?: string;
      customer?: string;
      amount_due?: number;
      last_payment_error?: { message?: string };
    };
    const coachId = await this.resolveCoachByCustomer(inv?.customer, tx);
    if (!coachId) return;
    const now = new Date();
    await tx.paymentFailure.create({
      data: {
        coach_id: coachId,
        stripe_invoice_id: inv?.id ?? null,
        stripe_event_id: event.id,
        amount_due_cents: inv?.amount_due ?? 0,
        reason: inv?.last_payment_error?.message ?? null,
        occurred_at: now,
      },
    });
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId, status: { notIn: ['canceled', 'paused'] } },
      data: {
        status: 'past_due',
        last_payment_failed_at: now,
        failed_payments_this_month: { increment: 1 },
      },
    });
    this.analytics.capture(coachId, Events.INVOICE_PAYMENT_FAILED, {
      amount_due_cents: inv?.amount_due ?? 0,
    });
    await this.audit.write({
      action: AuditAction.BILLING_INVOICE_PAYMENT_FAILED,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'invoice',
      targetId: inv?.id ?? null,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_invoice_id: inv?.id ?? null,
        amount_due_cents: inv?.amount_due ?? 0,
        reason: inv?.last_payment_error?.message ?? null,
      },
    });
    // QA P1-B1. Dispatch the payment-failed dunning email so the coach
    // actually finds out their card got declined within the 7-day grace
    // window. Pre-fix the row above wrote audit + analytics but never
    // talked to EmailService, so the grace was meaningless. Idempotency
    // is keyed on the Stripe event id — webhook re-deliveries are
    // no-ops at the EmailSendLog level, and the rest of this handler
    // already short-circuits on duplicate event id at the outer claim.
    await this.dispatchPaymentFailedEmail({
      coachId,
      stripeEventId: event.id,
      amountDueCents: inv?.amount_due ?? 0,
      reason: inv?.last_payment_error?.message ?? null,
    });
  }

  private async dispatchPaymentFailedEmail(args: {
    coachId: string;
    stripeEventId: string;
    amountDueCents: number;
    reason: string | null;
  }): Promise<void> {
    if (!this.email) return; // Legacy tests / boot configs without EmailModule
    try {
      const sub = await this.prisma.coachSubscription.findUnique({
        where: { coach_id: args.coachId },
        select: { billing_email: true },
      });
      const user = await this.prisma.user.findUnique({
        where: { id: args.coachId },
        select: { email: true, name: true },
      });
      const recipient = sub?.billing_email || user?.email;
      if (!recipient) {
        this.logger.warn(
          `dispatchPaymentFailedEmail: no recipient email for coach ${args.coachId}; skipping send`,
        );
        return;
      }
      await this.email.send({
        to: recipient,
        template: EmailTemplateKey.PAYMENT_FAILED,
        idempotencyKey: `billing-payment-failed:${args.stripeEventId}`,
        data: {
          coach_name: user?.name ?? 'there',
          amount_due_cents: args.amountDueCents,
          amount_due_display: (args.amountDueCents / 100).toFixed(2),
          reason: args.reason ?? 'Your card was declined.',
        },
      });
    } catch (err) {
      // Email is best-effort — the mirror has already been updated and
      // the audit row is durable. A transient Resend outage must not
      // cause Stripe to retry the webhook and re-double-write the
      // mirror.
      this.logger.error(
        `dispatchPaymentFailedEmail failed for coach ${args.coachId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private async applyCustomerUpdated(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const cus = event.data.object as {
      id?: string;
      email?: string | null;
      invoice_settings?: {
        default_payment_method?:
          | string
          | { card?: { last4?: string } }
          | null;
      };
    };
    if (!cus?.id) return;
    const coachId = await this.resolveCoachByCustomer(cus.id, tx);
    if (!coachId) return;
    const dpm = cus.invoice_settings?.default_payment_method;
    const last4 =
      dpm && typeof dpm === 'object' ? dpm.card?.last4 ?? null : null;
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: {
        billing_email: cus.email ?? null,
        ...(last4 ? { card_last4: last4 } : {}),
      },
    });
  }

  // Phase 1 Connect — refresh the mirror on every account.updated /
  // capability.updated event. The Stripe payload is the snapshot at event
  // time; we re-read via ConnectService.syncFromStripe so we always reflect
  // the freshest server state and never drift.
  // Connect account events are forwarded to ConnectService, which manages
  // its own writes. The `tx` parameter is accepted for symmetry with other
  // handlers and so future refactors can wire ConnectService into the same
  // transaction without changing the call sites here.
  private async applyConnectAccountUpdated(
    event: StripeEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tx: Prisma.TransactionClient,
  ) {
    const obj = event.data.object as { id?: string; account?: string };
    const accountId =
      typeof obj?.id === 'string' && obj.id.startsWith('acct_')
        ? obj.id
        : typeof obj?.account === 'string'
        ? obj.account
        : null;
    if (!accountId) {
      this.logger.warn(
        `Connect event ${event.id} (${event.type}) missing account id`,
      );
      return;
    }
    if (!this.connect) {
      this.logger.warn(
        `Connect event ${event.id} (${event.type}) received but ConnectService is not wired`,
      );
      return;
    }
    await this.connect.syncFromStripe(accountId);
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_UPDATED,
      actorId: null,
      actorRole: 'system',
      targetUserId: null,
      targetType: 'connect_account',
      targetId: accountId,
      tenantCoachId: null,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_account_id: accountId,
      },
    });
  }

  private async applyConnectAccountDeauthorized(
    event: StripeEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tx: Prisma.TransactionClient,
  ) {
    const obj = event.data.object as { id?: string; account?: string };
    const accountId =
      typeof obj?.id === 'string' && obj.id.startsWith('acct_')
        ? obj.id
        : typeof obj?.account === 'string'
        ? obj.account
        : null;
    if (!accountId) {
      this.logger.warn(
        `Connect deauthorized event ${event.id} missing account id`,
      );
      return;
    }
    if (!this.connect) {
      this.logger.warn(
        `Connect deauthorized event ${event.id} received but ConnectService is not wired`,
      );
      return;
    }
    await this.connect.markDeauthorized(accountId);
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_CANCELED,
      actorId: null,
      actorRole: 'system',
      targetUserId: null,
      targetType: 'connect_account',
      targetId: accountId,
      tenantCoachId: null,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_account_id: accountId,
      },
    });
  }

  // PR-2 P0-c — `transfer.failed` webhook handler.
  //
  // The Stripe Connect head-coach split is delivered as a follow-on
  // Transfer minted by TransferOrchestratorService (see
  // src/connect/fees/transfer-orchestrator.service.ts). When that
  // transfer fails on Stripe's side, we previously fell through to the
  // `default` log line and the head coach learned about the missed
  // payout only by checking Stripe directly. This handler:
  //   1. Looks up the matching ConnectTransfer by stripe_transfer_id and
  //      flips status='failed' + records Stripe's failure_message in
  //      last_error.
  //   2. Emits a COACH_ALERT inbox notification to the destination
  //      coach (User on ConnectTransfer.destination_user_id) so they can
  //      see the failure in-app and act on it.
  //   3. Logs the failure at warn level with the structured fields the
  //      rest of the webhook handler uses (event id, transfer id, coach
  //      id, amount, stripe failure reason).
  //
  // Idempotency: the outer handleEvent() guards on stripe_event_id via
  // StripeProcessedEvent so a Stripe replay of the SAME event id never
  // re-enters this method. As belt-and-suspenders for a different-id
  // replay of the same logical failure (e.g. transfer.failed re-fired
  // after our schema state was reset), the ConnectTransfer.update uses
  // updateMany with a WHERE-guard on status != 'failed' so the second
  // write is a no-op and we only emit COACH_ALERT when the status flip
  // actually happened (count > 0).
  private async applyTransferFailed(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const transfer = event.data.object as {
      id?: string;
      amount?: number;
      currency?: string;
      destination?: string | null;
      failure_message?: string | null;
      failure_code?: string | null;
    };
    if (!transfer?.id) {
      this.logger.warn(
        `transfer.failed event ${event.id} missing transfer id — skipping`,
      );
      return;
    }
    const row = await tx.connectTransfer.findFirst({
      where: { stripe_transfer_id: transfer.id },
    });
    if (!row) {
      // Unknown transfer — could be a platform-level transfer not
      // minted by TransferOrchestratorService, or it predates our
      // ConnectTransfer mirror. Log and move on; never throw, or we'd
      // cause Stripe to retry an event we cannot reconcile.
      this.logger.warn(
        `transfer.failed event=${event.id} transfer=${transfer.id}: no matching ConnectTransfer row`,
      );
      return;
    }
    // Compose the failure reason from Stripe's payload. failure_message
    // is the human-readable string; failure_code is the machine code.
    // Both are optional on the Stripe payload.
    const failureReason =
      [transfer.failure_code, transfer.failure_message]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(': ') || null;
    // WHERE-guard on status keeps the write idempotent under a
    // different-event-id replay of the same logical failure: re-running
    // sees status='failed' already and the updateMany returns count=0
    // so we skip the downstream COACH_ALERT. The outer stripe-event-id
    // dedup row still covers the dominant Stripe-side replay case.
    const updated = await tx.connectTransfer.updateMany({
      where: { id: row.id, status: { not: 'failed' } },
      data: {
        status: 'failed',
        last_error: failureReason ?? row.last_error,
        last_attempt_at: new Date(),
      },
    });
    const amountCents =
      typeof transfer.amount === 'number' ? transfer.amount : row.amount_cents;
    const coachId = row.destination_user_id ?? null;
    this.logger.warn(
      `transfer.failed event=${event.id} transfer=${transfer.id} coach=${coachId ?? 'unknown'} amount_cents=${amountCents} reason=${failureReason ?? 'unknown'}`,
    );
    // If updateMany reported count=0 we already flipped this row to
    // 'failed' on a prior delivery — skip the alert so the coach isn't
    // pinged twice for the same logical failure.
    if (updated.count === 0) return;
    if (!coachId) {
      this.logger.warn(
        `transfer.failed event=${event.id} transfer=${transfer.id}: ConnectTransfer.destination_user_id is null — cannot send COACH_ALERT`,
      );
      return;
    }
    if (!this.notifications) {
      this.logger.warn(
        `transfer.failed event=${event.id} transfer=${transfer.id}: NotificationsService is not wired — skipping COACH_ALERT`,
      );
      return;
    }
    try {
      const dollars = (amountCents / 100).toFixed(2);
      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.COACH_ALERT,
        body: `Payout transfer failed: $${dollars} could not be delivered.${failureReason ? ` Reason: ${failureReason}.` : ''}`,
        payload: {
          event: 'transfer_failed',
          stripe_transfer_id: transfer.id,
          stripe_event_id: event.id,
          purchase_id: row.purchase_id,
          amount_cents: amountCents,
          currency: row.currency,
          failure_code: transfer.failure_code ?? null,
          failure_message: transfer.failure_message ?? null,
        },
        deep_link: COACH_TRANSFER_FAILED_DEEP_LINK,
        channel: 'inapp',
      });
    } catch (err) {
      // The status flip has already committed in the outer transaction;
      // a failed downstream signal must not roll it back. Match the
      // pattern in RefundDisputeHandlerService.emitRefundCoachAlert.
      this.logger.warn(
        `coach transfer.failed notification failed transfer=${transfer.id} coach=${coachId}: ${(err as Error).message}`,
      );
    }
  }

  // B7 — `payout.failed` / `payout.canceled` webhook handler.
  //
  // A Stripe Connect PAYOUT is the leg that moves funds OUT of the
  // coach's Stripe balance to their external bank account. When it
  // fails or is canceled, the coach's expected bank deposit does not
  // arrive. Previously these events fell through to the `default`
  // "ignoring unhandled" log line and were swallowed behind the
  // StripeProcessedEvent dedup — so the coach had no in-app signal.
  //
  // This handler mirrors applyTransferFailed:
  //   1. Resolves the connected account id (payout events arrive with
  //      the account on the event envelope; we also accept it on the
  //      object for safety) and finds the cached PayoutSnapshot row,
  //      which is keyed by stripe_account_id.
  //   2. Records the failure on the snapshot: last_payout_status =
  //      'failed'/'canceled', last_payout_failure_message, and mirrors
  //      the payout id/amount so the coach/admin UI reads the failure
  //      without a Stripe round-trip. NO money math — this is a cached
  //      status mirror, not a ledger write.
  //   3. Emits a COACH_ALERT to the coach (existing notification kind).
  //
  // Idempotency: the outer handleEvent() StripeProcessedEvent dedup
  // makes a SAME-event-id replay never re-enter this method. As
  // belt-and-suspenders for a different-id replay of the same logical
  // payout failure, the snapshot updateMany is WHERE-guarded on
  // (last_payout_stripe_id != this payout OR last_payout_status not
  // already this terminal status); a second write returns count=0 and
  // we skip the COACH_ALERT so the coach is not pinged twice.
  private async applyPayoutFailed(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const payout = event.data.object as {
      id?: string;
      amount?: number;
      currency?: string;
      status?: string;
      failure_message?: string | null;
      failure_code?: string | null;
      account?: string | null;
    };
    // Connect events carry the connected account on the envelope; some
    // shapes also place it on the object. Accept either.
    const accountId =
      (typeof (event as { account?: unknown }).account === 'string'
        ? (event as { account?: string }).account
        : null) ??
      (typeof payout?.account === 'string' ? payout.account : null);
    if (!payout?.id) {
      this.logger.warn(
        `${event.type} event ${event.id} missing payout id — skipping`,
      );
      return;
    }
    if (!accountId) {
      this.logger.warn(
        `${event.type} event=${event.id} payout=${payout.id}: missing connected account id — cannot map to a coach`,
      );
      return;
    }
    const row = await tx.payoutSnapshot.findFirst({
      where: { stripe_account_id: accountId },
    });
    if (!row) {
      // No cached snapshot for this account — could predate the snapshot
      // mirror or belong to an account we don't track. Log and move on;
      // never throw, or Stripe retries an event we cannot reconcile.
      this.logger.warn(
        `${event.type} event=${event.id} payout=${payout.id} account=${accountId}: no matching PayoutSnapshot row`,
      );
      return;
    }
    const terminalStatus = event.type === 'payout.canceled' ? 'canceled' : 'failed';
    const failureReason =
      [payout.failure_code, payout.failure_message]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(': ') || null;
    const amountCents =
      typeof payout.amount === 'number'
        ? payout.amount
        : row.last_payout_amount_cents ?? 0;
    // Idempotency is decided in TypeScript, NOT via a nullable Prisma `NOT`
    // predicate. The guarded columns last_payout_stripe_id and
    // last_payout_status are nullable; a SQL `NOT (col = ? AND col2 = ?)`
    // evaluates to UNKNOWN (not TRUE) when those columns are NULL, so a
    // first-ever / no-prior-value snapshot would match 0 rows and the failed
    // payout would be silently swallowed (no record, no COACH_ALERT) while
    // the webhook is still marked complete. Compare here instead so a genuine
    // same-payout same-terminal-status replay is a true no-op, while a
    // different payout or a first-ever NULL-snapshot failure records + alerts.
    const alreadyTerminal =
      row.last_payout_stripe_id === payout.id &&
      row.last_payout_status === terminalStatus;
    if (alreadyTerminal) return;
    await tx.payoutSnapshot.updateMany({
      where: { id: row.id },
      data: {
        last_payout_stripe_id: payout.id,
        last_payout_status: terminalStatus,
        last_payout_amount_cents: amountCents,
        last_payout_failure_message: failureReason,
      },
    });
    const coachId = row.coach_user_id;
    this.logger.warn(
      `${event.type} event=${event.id} payout=${payout.id} account=${accountId} coach=${coachId} amount_cents=${amountCents} reason=${failureReason ?? 'unknown'}`,
    );
    if (!this.notifications) {
      this.logger.warn(
        `${event.type} event=${event.id} payout=${payout.id}: NotificationsService is not wired — skipping COACH_ALERT`,
      );
      return;
    }
    try {
      const dollars = (amountCents / 100).toFixed(2);
      const verb = terminalStatus === 'canceled' ? 'was canceled' : 'failed';
      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.COACH_ALERT,
        body: `Bank payout ${verb}: $${dollars} did not reach your bank.${failureReason ? ` Reason: ${failureReason}.` : ''}`,
        payload: {
          event: event.type === 'payout.canceled' ? 'payout_canceled' : 'payout_failed',
          stripe_payout_id: payout.id,
          stripe_event_id: event.id,
          stripe_account_id: accountId,
          amount_cents: amountCents,
          currency: payout.currency ?? row.currency,
          failure_code: payout.failure_code ?? null,
          failure_message: payout.failure_message ?? null,
        },
        deep_link: COACH_TRANSFER_FAILED_DEEP_LINK,
        channel: 'inapp',
      });
    } catch (err) {
      // The status mirror has already committed; a failed downstream
      // signal must not roll it back. Matches applyTransferFailed.
      this.logger.warn(
        `coach ${event.type} notification failed payout=${payout.id} coach=${coachId}: ${(err as Error).message}`,
      );
    }
  }

  // Read-only helpers used by /v1/coach/me/billing.

  async getCoachBilling(coachId: string) {
    const [subscription, invoices] = await Promise.all([
      this.prisma.coachSubscription.findUnique({ where: { coach_id: coachId } }),
      this.prisma.invoice.findMany({
        where: { coach_id: coachId },
        orderBy: { created_at: 'desc' },
        take: 24,
      }),
    ]);
    return {
      subscription,
      invoices,
    };
  }

  // B1 — single source of truth for the Stripe Billing Portal redirect.
  // Previously this exact logic was duplicated in CoachBillingController
  // (v1) and MobileCoachBillingController, which let the two surfaces drift.
  // Both now delegate here. Behavior is unchanged — same three modes, same
  // customer-id resolution order, same error shapes:
  //   1. Stripe configured → mint a per-coach portal session. { url }.
  //   2. Stripe unset but STRIPE_CUSTOMER_PORTAL_LOGIN_URL set to a hosted
  //      login link → { url, fallback: true, coachId }.
  //   3. Neither → BadRequest STRIPE_NOT_CONFIGURED.
  async createCoachPortalSession(coachId: string): Promise<{
    url: string;
    fallback?: boolean;
    coachId?: string;
  }> {
    if (!this.stripeApi || !this.stripeApi.isConfigured()) {
      const fallbackUrl = process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL?.trim();
      if (
        fallbackUrl &&
        /^https:\/\/billing\.stripe\.com\/p\/login\//.test(fallbackUrl)
      ) {
        return { url: fallbackUrl, fallback: true, coachId };
      }
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID_FITNESS to mint per-coach portal sessions, or set STRIPE_CUSTOMER_PORTAL_LOGIN_URL to a hosted Customer Portal login link as a fallback.',
      });
    }

    // Resolve stripe_customer_id from CoachSubscription first (mirror is the
    // primary source of truth post-onboarding) and fall back to CoachProfile
    // (where OWNER provisioning writes the customer id immediately, before
    // the customer.subscription.created webhook lands).
    const subscription = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
    });
    let customerId = subscription?.stripe_customer_id ?? null;
    if (!customerId) {
      const profile = await this.prisma.coachProfile.findUnique({
        where: { user_id: coachId },
      });
      customerId = profile?.stripe_customer_id ?? null;
    }
    if (!customerId) {
      throw new BadRequestException({
        error: 'BILLING_NOT_PROVISIONED',
        message:
          'No Stripe customer is provisioned for this coach yet. An OWNER must call start-subscription first.',
      });
    }

    const returnUrl =
      process.env.STRIPE_BILLING_PORTAL_RETURN_URL ??
      'https://console.thegrowthproject.app/billing';

    try {
      const session = await this.stripeApi.createBillingPortalSession({
        customer: customerId,
        returnUrl,
      });
      return { url: session.url };
    } catch (err) {
      if (err instanceof StripeApiError) {
        // Surface Stripe's own status (4xx for client errors, 5xx for
        // upstream issues) rather than wrapping every error as 400.
        throw new HttpException(
          {
            error: 'STRIPE_PORTAL_ERROR',
            message: err.message,
            stripeCode: err.stripeCode,
          },
          err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502,
        );
      }
      throw err;
    }
  }
}
