import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import { ConnectModuleState } from '../connect/connect.module-state';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import {
  StripeConnectApiService,
  type StripeSubscriptionCheckoutObject,
} from '../connect/stripe-connect-api.service';
import { PackagesService } from '../packages/packages.service';
import { PrismaService } from '../prisma.service';
import { CheckoutService, isRecurringPackage } from './checkout.service';
import { errorLabel } from './error-label';
import {
  CreateFailed,
  type Fenced,
  holdUnresolved,
  ownTrialSheet,
  sendFenced,
} from './subscription-attempt';
import {
  attachTrialCard,
  readTrialSetup,
  setupIntentIdOf,
  trialCardSaved,
  type TrialSetupState,
} from './trial-card';
import { checkoutTermsFor, parseCheckoutTerms, termsStillOffered } from './subscription-terms';
import {
  alreadyActive,
  alreadyIncluded,
  attemptExpired,
  clientNotFound,
  coachNotConnected,
  inProgress,
  keyOtherPlan,
  packageIsFree,
  packageUnavailable,
  planChangeUnconfirmed,
  planNotFound,
  setupUnavailable,
  stripeFailure,
} from './subscription-errors';
import {
  ADVISORY_LOCK_NAMESPACE_SUBSCRIPTION_CHECKOUT,
  ENDED_ATTEMPT_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
  OPEN_ATTEMPT_MAX_AGE_MS,
  OPEN_ATTEMPT_STATUSES,
  PAYABLE_PI_STATUSES,
  STALE_RESERVATION_MS,
  STALE_TRIAL_RETIRE_LIMIT,
  classifyWithoutSheet,
  codeOfHttp,
  isDefinitiveRefusal,
  isIdempotencyMismatch,
  isResourceMissing,
  intentResult,
  packageTrialDays,
  planPriceFor,
  planView,
  reservedMarker,
  retryMarker,
  shareLinkMatches,
  sheetSecret,
  subscriptionUnpaid,
  type CheckoutState,
  type ClientPlanView,
  type PlanPrice,
  type SubscriptionIntentInput,
  type SubscriptionIntentResult,
} from './subscription-plan';

// Moved to R1 (subscription-plan.ts); re-exported for existing importers.
export {
  ADVISORY_LOCK_NAMESPACE_SUBSCRIPTION_CHECKOUT,
  MAX_TRIAL_DAYS,
  packageTrialDays,
  planPriceFor,
  shareLinkMatches,
} from './subscription-plan';
export type {
  CheckoutState,
  ClientPlanView,
  PlanPrice,
  PlanState,
  SubscriptionIntentInput,
  SubscriptionIntentResult,
} from './subscription-plan';

// B-RECUR (agent 113; OR-113-1 + OR-113-2) — native subscription checkout.
//
// Recurring packages (and one-time packages with a recurring second price)
// are sold as real Stripe Subscriptions through the SAME native, TGP-themed
// PaymentSheet as one-time packages. No hosted Stripe page is involved.
//
// Money model (#627 S-FEE, unchanged here): the Subscription lives on the
// PLATFORM with on_behalf_of = the coach's connected account and NO
// transfer_data / application_fee_percent. Every paid invoice (the first one
// and each renewal) is settled from `invoice.paid` by ChargeSettlementService
// with Stripe's actual fee. This service never computes a fee or a transfer.
//
// Entitlement is NEVER granted here. It is granted by the webhook
// (invoice.paid, or customer.subscription.updated once a trial's card is
// saved) and revoked by the existing lifecycle. Cancel is cancel_at_period_end
// through POST /v1/checkout/subscriptions/:id/cancel (client billing, #628);
// keep-my-plan (undo a scheduled cancel) is resumePlan() below.
//
// Idempotency and abandoned attempts:
//   * Same (client, Idempotency-Key) -> same ClientPurchase row -> same
//     Subscription (the Stripe Idempotency-Key derives from the client key).
//   * A per-(client, coach) Postgres advisory lock serializes the decision
//     "already subscribed / reuse an open attempt / reserve a new attempt",
//     so a double tap with two different keys never mints two Subscriptions.
//   * An open, unpaid attempt for the same package (Stripe status
//     `incomplete`, same price) is REUSED for a new key: the client gets the
//     same Subscription and PaymentIntent back. A stale one (price changed,
//     expired on Stripe) is canceled on Stripe and marked expired before a
//     new attempt is reserved, so incomplete Subscriptions never pile up.
//     Stripe itself expires an unpaid `incomplete` Subscription after 23 h.

type Tx = Prisma.TransactionClient;

type Decision =
  | { kind: 'included'; purchase: ClientPurchase }
  | { kind: 'active'; purchase: ClientPurchase }
  | { kind: 'reuse'; purchase: ClientPurchase }
  | { kind: 'reserved'; purchase: ClientPurchase; trialDays: number };

@Injectable()
export class SubscriptionCheckoutService {
  private readonly logger = new Logger(SubscriptionCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
    private readonly packages: PackagesService,
    private readonly state: ConnectModuleState,
    private readonly feePolicy: FeePolicyService,
    private readonly checkout: CheckoutService,
  ) {}

  // ── POST /v1/checkout/subscription-intent ──────────────────────────────

  async createSubscriptionIntent(
    clientUserId: string,
    input: SubscriptionIntentInput,
  ): Promise<SubscriptionIntentResult> {
    this.assertReady();

    const client = await this.prisma.user.findUnique({
      where: { id: clientUserId },
      select: { id: true, email: true, name: true, coach_id: true },
    });
    if (!client) throw clientNotFound();
    const pkg = await this.packages.getById(input.package_id);
    // Same visibility rule as the one-time path: unpublished, archived,
    // inactive, or another coach's package is a non-leaking 404.
    if (!pkg || !pkg.is_active || pkg.archived_at || !pkg.published_at) {
      throw packageUnavailable();
    }
    if (!client.coach_id || pkg.coach_id !== client.coach_id) {
      // R1-10 — the in-app paths (payment-intent and this route) sell only
      // the client's own coach's packages; a client who is not connected
      // with the package's coach is refused, exactly like payment-intent.
      // When the client opened this package's live share link (the link
      // already shows the package publicly), the refusal says why, with a
      // working next step. Without a matching live token it stays the
      // non-leaking 404, so no package id is ever confirmed to a stranger.
      if (shareLinkMatches(pkg, input.share_token)) {
        throw coachNotConnected(client.coach_id ? 'other_coach' : 'no_coach');
      }
      throw packageUnavailable();
    }
    // $0 packages and invite-code grants never create Stripe objects. A
    // recurring package priced $0 is free too (claimable through
    // /v1/packages/:id/claim-free, which keys on amount_cents = 0).
    if (pkg.amount_cents === 0 && (!isRecurringPackage(pkg) || pkg.billing_type === 'recurring')) {
      throw packageIsFree();
    }
    if (!isRecurringPackage(pkg)) {
      throw new ConflictException({
        code: 'ONE_TIME_REQUIRES_PAYMENT_INTENT',
        error: 'ONE_TIME_REQUIRES_PAYMENT_INTENT',
        message:
          'This plan is a single payment, not a subscription. Update the app to buy it, or message your coach.',
      });
    }
    const pkgTrial = packageTrialDays(pkg);
    const offeredPrice = planPriceFor(pkg, 0);
    if (!(offeredPrice.amount_cents > 0)) {
      // Unreachable after the two checks above (isRecurringPackage requires a
      // positive recurring part); kept as the backstop against a $0 renewal.
      throw packageIsFree();
    }
    const oneTimeMismatch =
      typeof input.expected_one_time_cents === 'number' &&
      input.expected_one_time_cents !== offeredPrice.one_time_cents;
    if (
      (typeof input.expected_amount_cents === 'number' &&
        input.expected_amount_cents !== offeredPrice.amount_cents) ||
      oneTimeMismatch
    ) {
      throw new ConflictException({
        code: 'PACKAGE_PRICE_CHANGED',
        error: 'PACKAGE_PRICE_CHANGED',
        message:
          'The price of this plan changed since you opened it. Review the new price before you start.',
        amount_cents: offeredPrice.amount_cents,
        one_time_cents: offeredPrice.one_time_cents,
        // Today's charge without a trial; a trial makes today's charge 0.
        first_charge_cents: offeredPrice.first_charge_cents,
        currency: offeredPrice.currency,
        interval: offeredPrice.interval,
        interval_count: offeredPrice.interval_count,
      });
    }

    const purchaseKey = `sub-${client.id}-${input.idempotency_key}`;

    // Fast path: exact same attempt (retry after a timeout, double tap with
    // the same key). Returns the same Subscription without any Stripe write.
    const replay = await this.prisma.clientPurchase.findUnique({
      where: { idempotency_key: purchaseKey },
    });
    if (replay && replay.client_user_id === client.id) {
      // B-679-2 — a key belongs to the plan it started; never relabel it.
      if (replay.package_id !== pkg.id || replay.coach_user_id !== pkg.coach_id) {
        throw keyOtherPlan();
      }
      return this.replayAttempt(replay, pkg, pkgTrial, offeredPrice);
    }

    // R1-2 — already included (invite grant, free claim, one-time purchase):
    // answered before any Stripe object (customer, subscription) exists.
    const included = await this.findIncluded(this.prisma, client.id, pkg.id);
    if (included) throw alreadyIncluded(included);

    const coach = await this.prisma.user.findUnique({
      where: { id: pkg.coach_id },
      select: { id: true, email: true, name: true },
    });
    if (!coach) throw packageUnavailable();
    const connectAccount = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: pkg.coach_id },
    });
    if (!connectAccount) {
      throw new ConflictException({
        code: 'COACH_NOT_CONNECTED',
        error: 'COACH_NOT_CONNECTED',
        message:
          'Your coach has not finished setting up payments yet, so this plan cannot start. Message your coach; nothing was charged.',
      });
    }
    if (!connectAccount.charges_enabled || connectAccount.deauthorized_at) {
      throw new ConflictException({
        code: 'COACH_NOT_PAYOUT_READY',
        error: 'COACH_NOT_PAYOUT_READY',
        message:
          'Your coach cannot take payments right now, so this plan cannot start. Message your coach; nothing was charged.',
      });
    }

    // Same two-layer contract gate as every checkout path: no Stripe write
    // past an unsigned required contract.
    const gate = await this.checkout.runContractGate({
      clientId: client.id,
      client: { email: client.email, name: client.name ?? client.email },
      pkg,
      coach: { id: coach.id, email: coach.email, name: coach.name ?? '' },
    });

    // Customer before the lock: the webhook's metadata fallback binds a
    // subscription to a pending row by (package, client, coach, customer).
    const customer = await this.checkout.ensureCustomer(client.id, client.email, client.name);

    // R1-6 — trial attempts abandoned before the card was saved stay
    // `trialing` on Stripe until the trial ends (Stripe expires only
    // `incomplete` ones after 23 h). Retire the stale ones now. Best effort:
    // it never blocks this checkout.
    const cardSaved = await this.retireStaleTrialAttempts(client.id, coach.id, pkg.id);
    // B-654-1 — a stale trial of THIS package whose card turned out saved is
    // the client's plan (the webhook grants it); never start a second one.
    const savedHere = cardSaved.find((r) => r.package_id === pkg.id);
    if (savedHere) throw alreadyActive(savedHere);

    // Decide under the per-(client, coach) lock. At most two passes: the
    // second runs only after a stale open attempt was retired.
    for (let pass = 0; pass < 2; pass += 1) {
      const decision = await this.decide({
        clientId: client.id,
        coachId: coach.id,
        pkg,
        pkgTrial,
        purchaseKey,
        customerId: customer.stripe_customer_id,
        destination: connectAccount.stripe_account_id,
        renewalCents: offeredPrice.amount_cents,
        contractEnvelopeId: gate.coachEnvelopeId ?? null,
      });
      if (decision.kind === 'included') throw alreadyIncluded(decision.purchase);
      if (decision.kind === 'active') throw alreadyActive(decision.purchase);
      if (decision.kind === 'reserved') {
        return this.mintSubscription(decision.purchase, pkg, false);
      }
      // Reuse candidate: an open attempt for the same package.
      const reused = await this.tryReuse(
        decision.purchase,
        pkg,
        pkgTrial,
        offeredPrice,
        client.id,
        input.idempotency_key,
      );
      if (reused) return reused;
    }
    // Two stale attempts in a row means Stripe and the database disagree.
    throw inProgress(true);
  }

  // ── GET /v1/checkout/subscriptions[/:id] ───────────────────────────────

  async listPlans(clientUserId: string): Promise<ClientPlanView[]> {
    const rows = await this.prisma.clientPurchase.findMany({
      where: {
        client_user_id: clientUserId,
        billing_type: 'recurring',
        stripe_subscription_id: { not: null },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    // Hide unpaid abandoned attempts; a client only sees real plans.
    const real = rows.filter(
      (r) =>
        r.entitlement_active ||
        r.trial_started_at ||
        r.status === 'canceled' ||
        r.status === 'past_due' ||
        r.status === 'unpaid',
    );
    const pkgs = await this.packagesById(real.map((r) => r.package_id));
    return real.map((r) => planView(r, pkgs.get(r.package_id) ?? null));
  }

  async getPlan(clientUserId: string, purchaseId: string): Promise<ClientPlanView> {
    const row = await this.prisma.clientPurchase.findFirst({
      where: { id: purchaseId, client_user_id: clientUserId },
    });
    if (!row || row.billing_type !== 'recurring' || !row.stripe_subscription_id) {
      throw planNotFound();
    }
    const pkg = await this.prisma.coachPackage.findUnique({ where: { id: row.package_id } });
    const checkoutState = await this.readCheckoutState(row);
    return { ...planView(row, pkg), checkout_state: checkoutState };
  }

  /**
   * B-334-3 — Stripe's own view of a plan the app is still confirming, so
   * the app can tell "not paid, nothing charged" from "paid, the webhook is
   * on its way" after the card sheet ended without a clear answer.
   *
   * Also the trial backstop (B-654-1): when the trial's SetupIntent
   * succeeded but the subscription has no default card yet, set it on
   * Stripe; Stripe then sends customer.subscription.updated and the webhook
   * grants the trial. Never grants access itself; a Stripe failure answers
   * 'unknown' and the webhook path stays the source of truth.
   */
  private async readCheckoutState(row: ClientPurchase): Promise<CheckoutState | null> {
    if (row.entitlement_active || row.trial_started_at || !row.stripe_subscription_id) return null;
    if (ENDED_ATTEMPT_STATUSES.has(row.status)) return null;
    if (!this.state.ready) return 'unknown';
    try {
      const sub = await this.stripe.retrieveSubscriptionForCheckout(row.stripe_subscription_id);
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'ended';
      if (sub.status === 'trialing') {
        // B-679-8 (Opus) — a default with the create-time end still set is
        // not proof of the attempt's own card: read its SetupIntent.
        if (sub.default_payment_method && !sub.cancel_at_period_end) return 'card_saved';
        // B-654-1 — read the SetupIntent itself: Stripe returns
        // pending_setup_intent = null once it succeeded.
        const setup = await readTrialSetup(this.stripe, row.stripe_client_secret, sub);
        if (trialCardSaved(setup)) {
          await this.attachTrialCardQuietly(sub.id, setup.payment_method, row.id);
          return 'card_saved';
        }
        if (setup?.status === 'processing') return 'processing';
        if (setup?.status === 'canceled') return 'ended';
        return setup ? 'awaiting_card' : 'unknown';
      }
      if (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'unpaid') {
        return 'paid';
      }
      const inv =
        sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      if (inv?.status === 'paid') return 'paid';
      const pi = inv && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
      const piStatus = pi?.status;
      if (piStatus === 'succeeded') return 'paid';
      if (piStatus === 'processing') return 'processing';
      if (piStatus === 'canceled') return 'ended';
      if (typeof piStatus === 'string' && PAYABLE_PI_STATUSES.has(piStatus))
        return 'awaiting_payment';
      return 'unknown';
    } catch (err) {
      this.logger.warn(`checkout state read skipped purchase=${row.id} error=${errorLabel(err)}`);
      return 'unknown';
    }
  }

  // ── POST /v1/checkout/subscriptions/:id/resume ─────────────────────────

  /**
   * Keep a plan the client scheduled to cancel. Only before the paid period
   * ends; after it ends the client starts a new subscription instead.
   */
  async resumePlan(
    clientUserId: string,
    purchaseId: string,
    idempotencyKey: string,
  ): Promise<ClientPlanView> {
    this.assertReady();
    const row = await this.prisma.clientPurchase.findFirst({
      where: { id: purchaseId, client_user_id: clientUserId },
    });
    if (!row || row.billing_type !== 'recurring' || !row.stripe_subscription_id) {
      throw planNotFound();
    }
    const pkg = await this.prisma.coachPackage.findUnique({ where: { id: row.package_id } });
    if (!row.cancel_at_period_end) return planView(row, pkg);
    if (row.status === 'canceled' || !row.entitlement_active) {
      throw new ConflictException({
        code: 'PLAN_ALREADY_ENDED',
        error: 'PLAN_ALREADY_ENDED',
        message:
          'This plan has already ended, so it cannot be kept. Start it again from your coach’s plans.',
      });
    }
    let sub;
    try {
      sub = await this.stripe.resumeSubscription({
        subscriptionId: row.stripe_subscription_id,
        idempotencyKey: `tgp-resume-${row.stripe_subscription_id}-${idempotencyKey}`,
      });
    } catch (err) {
      throw stripeFailure(err);
    }
    // B-679-4 — the answer may predate a newer cancel (or be an idempotent
    // replay): write Stripe's current state, and only over the row version
    // this request read; a newer write (webhook, cancel) wins. Without that
    // state nothing is written (Sol B-679-4): the cached answer proves nothing.
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(row.stripe_subscription_id);
    } catch (err) {
      this.logger.warn(`resume read-back failed purchase=${row.id} error=${errorLabel(err)}`);
      throw planChangeUnconfirmed();
    }
    const periodEnd =
      typeof sub.current_period_end === 'number'
        ? new Date(sub.current_period_end * 1000)
        : row.current_period_end;
    const res = await this.prisma.clientPurchase.updateMany({
      where: { id: row.id, updated_at: row.updated_at },
      data: { cancel_at_period_end: !!sub.cancel_at_period_end, current_period_end: periodEnd },
    });
    const updated = await this.prisma.clientPurchase.findUnique({ where: { id: row.id } });
    this.logger.log(`billing.client_plan_resumed purchase=${row.id} superseded=${res.count !== 1}`);
    return planView(updated ?? row, pkg);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async decide(args: {
    clientId: string;
    coachId: string;
    pkg: CoachPackage;
    pkgTrial: number;
    purchaseKey: string;
    customerId: string;
    destination: string;
    renewalCents: number;
    contractEnvelopeId: string | null;
  }): Promise<Decision> {
    return this.prisma.$transaction(async (tx: Tx): Promise<Decision> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE_SUBSCRIPTION_CHECKOUT}::int4, hashtext(${`${args.clientId}:${args.coachId}`}))`;

      // 0. R1-2 — the client already holds this package without a
      //    subscription: an invite-code grant (free / prepaid), a free claim,
      //    or a one-time purchase still in its access window. Charging for it
      //    again would bill a plan they already have.
      //    Re-checked under the lock (a grant may land while this runs).
      const included = await this.findIncluded(tx, args.clientId, args.pkg.id);
      if (included) return { kind: 'included', purchase: included };

      // 1. Already on this plan -> coded 409 the app explains. A trial counts
      //    once it started (card saved); before that it is an open attempt.
      const live = await tx.clientPurchase.findFirst({
        where: {
          client_user_id: args.clientId,
          package_id: args.pkg.id,
          billing_type: 'recurring',
          stripe_subscription_id: { not: null },
          OR: [
            { entitlement_active: true },
            { trial_started_at: { not: null }, status: 'trialing' },
            { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
          ],
        },
        orderBy: { created_at: 'desc' },
      });
      if (live) return { kind: 'active', purchase: live };

      // 2. An open attempt for the same package (any key, B-679-1: any age;
      //    an unresolved attempt is never replaced by elapsed time) -> reuse it.
      const open = await tx.clientPurchase.findFirst({
        where: {
          client_user_id: args.clientId,
          package_id: args.pkg.id,
          billing_type: 'recurring',
          entitlement_active: false,
          trial_started_at: null,
          status: { in: [...OPEN_ATTEMPT_STATUSES] },
          idempotency_key: { startsWith: `sub-${args.clientId}-` },
        },
        orderBy: { created_at: 'desc' },
      });
      if (open) return { kind: 'reuse', purchase: open };

      // 3. Trial eligibility: one trial per client per coach. A trial counts
      //    as used once its entitlement was granted, and an open trial
      //    attempt for another package of the same coach also holds it.
      let trialDays = 0;
      if (args.pkgTrial > 0) {
        const used = await tx.clientPurchase.findFirst({
          where: {
            client_user_id: args.clientId,
            coach_user_id: args.coachId,
            OR: [
              { trial_started_at: { not: null } },
              {
                trial_days: { not: null },
                entitlement_active: false,
                status: { in: [...OPEN_ATTEMPT_STATUSES] },
              },
            ],
          },
          select: { id: true },
        });
        trialDays = used ? 0 : args.pkgTrial;
      }

      // 4. Reserve this attempt before any Stripe write.
      const reservation = await tx.clientPurchase.create({
        data: {
          client_user_id: args.clientId,
          coach_user_id: args.coachId,
          package_id: args.pkg.id,
          amount_cents: args.renewalCents,
          currency: args.pkg.currency,
          billing_type: 'recurring',
          stripe_checkout_session_id: `sub-reserved-${args.purchaseKey}`,
          stripe_customer_id: args.customerId,
          stripe_destination_account: args.destination,
          status: 'pending',
          entitlement_active: false,
          idempotency_key: args.purchaseKey,
          contract_envelope_id: args.contractEnvelopeId,
          trial_days: trialDays > 0 ? trialDays : null,
        },
      });
      return { kind: 'reserved', purchase: reservation, trialDays };
    });
  }

  /**
   * Create (or finish) the Stripe Subscription of one reserved attempt.
   *
   * B-654-5 — the attempt is durable from its first Stripe write on:
   *   1. The request is pinned on the reservation (`checkout_terms`: price
   *      ids, amounts, cadence, trial) BEFORE the create, and every retry
   *      resends exactly that request under the same Stripe Idempotency-Key
   *      (`tgp-<purchase key>`), with metadata built from the row (its own id
   *      included). Stripe rejects a retained key whose parameters differ, so
   *      nothing is ever regenerated between tries.
   *   2. The Subscription is bound to the row as soon as Stripe returns it,
   *      before the ephemeral key, so a later failure never loses it.
   *   3. Failures before the create (prices, fee policy, pin write) drop the
   *      reservation: Stripe never saw the key. A definitive Stripe refusal
   *      ends the attempt (Stripe stores that answer under the key). An
   *      uncertain one (timeout, 5xx, 429, connection drop) marks it for a
   *      retry; the next request for it first looks the subscription up by
   *      metadata.tgp_purchase_id (C-654-8) and resends the pinned request
   *      only when none exists and the key is still retained; if Stripe
   *      reports the key was used with other parameters, the lookup decides
   *      again or the attempt ends (nothing was created).
   */
  private async mintSubscription(
    reservation: ClientPurchase,
    pkg: CoachPackage,
    reusedFlag: boolean,
  ): Promise<SubscriptionIntentResult> {
    const stripeKey = `tgp-${reservation.idempotency_key}`;
    const customerId = reservation.stripe_customer_id;
    const destination = reservation.stripe_destination_account;
    let terms = parseCheckoutTerms(reservation.checkout_terms);
    const firstTry = terms === null;
    let headCoachId: string;
    try {
      if (!customerId || !destination) {
        throw new Error(`reservation ${reservation.id} has no customer or destination`);
      }
      // Pre-charge preview only (metadata + fee-policy validation), exactly
      // like the one-time path. Settlement reads Stripe's actual fee later.
      const plan = await this.feePolicy.planFor(
        reservation.coach_user_id,
        reservation.amount_cents,
      );
      headCoachId = plan.head_coach_id ?? '';
      if (!terms) {
        const isCombo = pkg.billing_type !== 'recurring';
        const recurringPriceId = isCombo
          ? await this.checkout.ensureRecurringPriceForPackage(pkg)
          : await this.checkout.ensurePriceForPackage(pkg);
        const oneTimePriceId = isCombo ? await this.checkout.ensurePriceForPackage(pkg) : null;
        const trialDays = reservation.trial_days ?? 0;
        terms = checkoutTermsFor(planPriceFor(pkg, trialDays), trialDays, {
          recurring: recurringPriceId,
          oneTime: oneTimePriceId,
        });
        await this.prisma.clientPurchase.update({
          where: { id: reservation.id },
          data: { checkout_terms: terms },
        });
      }
    } catch (err) {
      // Nothing reached Stripe under this attempt's key yet.
      if (firstTry) await this.dropReservation(reservation.id);
      else await this.markRetryable(reservation);
      throw stripeFailure(err, firstTry);
    }

    const metadata = {
      tgp_client_user_id: reservation.client_user_id,
      tgp_coach_user_id: reservation.coach_user_id,
      tgp_package_id: reservation.package_id,
      tgp_purchase_id: reservation.id,
      tgp_head_coach_user_id: headCoachId,
      tgp_fee_mechanism: 'separate_charge_transfer',
      tgp_checkout: 'native_subscription',
    };
    // B-654-5 / C-654-8 — a retry never resends blindly: Stripe keeps a key
    // for 24 h only, after which the pinned request would make a second
    // subscription. Stripe is read first: the attempt's own subscription
    // (metadata.tgp_purchase_id) is bound; unreadable stays retryable; none
    // past the key window ends the attempt (nothing was created). Inside the
    // window the same key still guards the resend.
    let sub: StripeSubscriptionCheckoutObject | null = null;
    if (!firstTry) {
      const found = await this.findAttemptSubscription(reservation);
      if (found === 'unreadable') {
        await this.markRetryable(reservation);
        throw inProgress(true);
      }
      sub = found;
      if (!sub && Date.now() - reservation.created_at.getTime() >= OPEN_ATTEMPT_MAX_AGE_MS) {
        await this.expireAttempt(reservation.id);
        throw attemptExpired('timed_out');
      }
    }
    // Sol B-679-7 — the create is sent only inside sendFenced (claim, create
    // and bind in one transaction holding the client's User row).
    const pinned = terms;
    const create = () =>
      this.stripe.createSubscription({
        customer: customerId,
        recurringPriceId: pinned.recurring_price_id,
        oneTimePriceId: pinned.one_time_price_id ?? undefined,
        onBehalfOf: destination,
        metadata,
        trialPeriodDays: pinned.trial_days > 0 ? pinned.trial_days : undefined,
        idempotencyKey: stripeKey,
      });
    let sent: Fenced;
    try {
      try {
        sent = await sendFenced(this.prisma, reservation, sub, create);
      } catch (failed) {
        if (!(failed instanceof CreateFailed)) throw failed;
        const err = failed.cause;
        if (!isIdempotencyMismatch(err)) {
          const refused = isDefinitiveRefusal(err);
          if (refused) await this.expireAttempt(reservation.id);
          else await this.markRetryable(reservation);
          throw stripeFailure(err, refused);
        }
        const found = await this.findAttemptSubscription(reservation);
        if (found === 'unreadable') {
          await this.markRetryable(reservation);
          throw inProgress(true);
        }
        if (!found) {
          // Stripe holds the key for another request and has no
          // subscription for this attempt: nothing was created or charged.
          await this.expireAttempt(reservation.id);
          throw attemptExpired('timed_out');
        }
        sub = found;
        sent = await sendFenced(this.prisma, reservation, sub, create);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Stripe may have the subscription; the pinned retry finds it.
      this.logger.error(
        `subscription send/bind failed purchase=${reservation.id} error=${errorLabel(err)}`,
      );
      await this.markRetryable(reservation);
      throw inProgress(true);
    }
    if (sent === 'gone') throw clientNotFound();
    if (sent === 'closed') {
      const now = await this.prisma.clientPurchase.findUnique({ where: { id: reservation.id } });
      if (now && (now.entitlement_active || now.trial_started_at)) throw alreadyActive(now);
      if (now?.client_user_id !== reservation.client_user_id) throw clientNotFound();
      if (now.stripe_subscription_id && now.stripe_subscription_id !== sub?.id)
        throw inProgress(false);
      if (!sub) throw attemptExpired('timed_out');
      sent = { sub, bound: null };
    }
    sub = sent.sub;
    let bound = sent.bound;
    if (!bound) {
      const again = await this.prisma.clientPurchase.findUnique({ where: { id: reservation.id } });
      if (again && (again.entitlement_active || again.trial_started_at)) throw alreadyActive(again);
      if (again && again.stripe_subscription_id === sub.id) {
        bound = again;
      } else {
        // B-679-7 / Sol B-679-8 — the attempt closed before the bind. An
        // unpaid subscription ends through the guarded termination (void or
        // SetupIntent cancel first, so a payment landing now is never
        // canceled); paid, in flight or unconfirmed stays on the row for
        // reconciliation and never gets a no-charge answer.
        const end = subscriptionUnpaid(sub)
          ? await this.endUnpaid(again ?? reservation, sub)
          : 'settled';
        if (end === 'ended') throw attemptExpired('terms_changed');
        await holdUnresolved(this.prisma, this.logger, reservation, sub);
        this.logger.error(
          `billing.subscription_paid_after_close purchase=${reservation.id} stripe_status=${sub.status} end=${end}`,
        );
        throw inProgress(true);
      }
    }
    return this.finishBound(bound, sub, pkg, stripeKey, reusedFlag);
  }

  /**
   * B-654-6 — finish a bound attempt from Stripe's canonical subscription:
   *   * a payable PaymentIntent / pending SetupIntent: the sheet secret plus an
   *     ephemeral key (idempotent per attempt; a failure keeps the binding, so
   *     the next request finishes it);
   *   * paid or processing without a sheet (a zero-due first invoice, credit
   *     balance, a payment already in flight, a trial whose card is the
   *     default): kept, never canceled; mode 'none' and the webhook grants;
   *   * ended on Stripe: the attempt ends;
   *   * anything else (no way to collect payment): canceled, nothing charged.
   */
  private async finishBound(
    row: ClientPurchase,
    sub: StripeSubscriptionCheckoutObject,
    pkg: CoachPackage,
    ephemeralKeyBase: string,
    reusedFlag: boolean,
  ): Promise<SubscriptionIntentResult> {
    let secret: ReturnType<typeof sheetSecret>;
    try {
      secret = sheetSecret(sub) ?? (await ownTrialSheet(this.stripe, row, sub, null));
    } catch (err) {
      throw stripeFailure(err);
    }
    if (secret) {
      let ephemeral: { secret: string };
      try {
        ephemeral = await this.stripe.createEphemeralKey(
          row.stripe_customer_id ?? '',
          `${ephemeralKeyBase}-ephkey`,
        );
      } catch (err) {
        throw stripeFailure(err);
      }
      const updated = await this.storeCredentials(row, sub, secret.client_secret, ephemeral.secret);
      if (!updated) throw attemptExpired('timed_out');
      return intentResult(updated, pkg, reusedFlag, sub.status);
    }
    const outcome = classifyWithoutSheet(sub);
    if (outcome === 'complete') {
      this.logger.log(
        `billing.subscription_needs_no_sheet purchase=${row.id} stripe_status=${sub.status}`,
      );
      return intentResult(row, pkg, reusedFlag, sub.status, 'none');
    }
    if (outcome === 'ended') {
      await this.expireAttempt(row.id);
      throw attemptExpired('timed_out');
    }
    this.logger.error(
      `subscription ${sub.id} has no payable PaymentIntent or SetupIntent and is not paid; canceling it`,
    );
    // B-654-8 — the attempt ends only once Stripe shows its subscription ended.
    const end = await this.endUnpaid(row, sub);
    if (end === 'settled') throw alreadyActive(row);
    if (end === 'ended') await this.expireAttempt(row.id);
    throw setupUnavailable(end === 'ended');
  }

  /**
   * B-679-3 — store sheet credentials only while the row is still this open,
   * unentitled attempt of `sub`. A row that turned entitled meanwhile answers
   * ALREADY_ACTIVE; one that ended answers null (no credential is written or
   * returned).
   */
  private async storeCredentials(
    row: ClientPurchase,
    sub: StripeSubscriptionCheckoutObject,
    clientSecret: string,
    ephemeralKey: string,
  ): Promise<ClientPurchase | null> {
    const res = await this.prisma.clientPurchase.updateMany({
      where: {
        id: row.id,
        stripe_subscription_id: sub.id,
        status: { in: [...OPEN_ATTEMPT_STATUSES] },
        entitlement_active: false,
        trial_started_at: null,
      },
      data: { stripe_client_secret: clientSecret, stripe_ephemeral_key: ephemeralKey },
    });
    const now = await this.prisma.clientPurchase.findUnique({ where: { id: row.id } });
    if (now && (now.entitlement_active || now.trial_started_at)) throw alreadyActive(now);
    return res.count === 1 ? now : null;
  }

  /**
   * B-654-5 / B-654-7 — a same-key retry. The key is bound to its attempt
   * and to the terms that attempt was started with:
   *   * still being created by another request: wait for it (bounded);
   *   * its create ended uncertainly (or its request died): finish it from
   *     Stripe (C-654-8: look up first; resend only inside the key window);
   *   * paid / card saved: SUBSCRIPTION_ALREADY_ACTIVE; ended:
   *     SUBSCRIPTION_ATTEMPT_EXPIRED (never a spent or dead secret, R1-5 /
   *     C-654-3);
   *   * the package no longer offers those terms (price, one-time part,
   *     currency, cadence or the attempt's trial changed): the unpaid attempt
   *     is retired and the app starts again with a new key and the current
   *     terms (SUBSCRIPTION_ATTEMPT_EXPIRED, reason terms_changed). An old
   *     intent is never relabelled with the package's new terms;
   *   * bound without a sheet secret (the ephemeral key failed, or nothing to
   *     pay): finished from Stripe's subscription;
   *   * otherwise the stored secret and the attempt's own pinned terms.
   */
  private async replayAttempt(
    row: ClientPurchase,
    pkg: CoachPackage,
    pkgTrial: number,
    offered: PlanPrice,
  ): Promise<SubscriptionIntentResult> {
    let cur = row;
    let claimed = false;
    if (
      !cur.stripe_subscription_id &&
      !cur.stripe_client_secret &&
      !ENDED_ATTEMPT_STATUSES.has(cur.status)
    ) {
      const own = await this.claimUnbound(cur);
      if (own) {
        cur = own;
        claimed = true;
      } else {
        const winner = await this.waitForSecret(cur.idempotency_key);
        if (!winner) throw inProgress(true);
        cur = winner;
        if (!cur.stripe_subscription_id && !ENDED_ATTEMPT_STATUSES.has(cur.status)) {
          const late = await this.claimUnbound(cur);
          if (!late) throw inProgress(false);
          cur = late;
          claimed = true;
        }
      }
    }
    if (cur.entitlement_active || cur.trial_started_at) throw alreadyActive(cur);
    if (ENDED_ATTEMPT_STATUSES.has(cur.status)) throw attemptExpired('timed_out');

    const terms = parseCheckoutTerms(cur.checkout_terms);
    if (terms && !termsStillOffered(terms, offered, pkgTrial)) {
      if ((await this.retireAttempt(cur)) === 'settled') throw alreadyActive(cur);
      throw attemptExpired('terms_changed');
    }
    if (claimed || !cur.stripe_subscription_id) return this.mintSubscription(cur, pkg, true);

    if (cur.stripe_client_secret) {
      // C-654-3 — the secret may be spent: the card was saved or the first
      // invoice paid a moment ago, before the webhook. Never hand it back.
      const state = await this.replaySecretState(cur);
      if (state === 'settled') throw alreadyActive(cur);
      if (state === 'unconfirmed') throw inProgress(true);
      if (state === 'dead') {
        await this.expireAttempt(cur.id);
        throw attemptExpired('timed_out');
      }
      return intentResult(cur, pkg, true);
    }
    let sub: StripeSubscriptionCheckoutObject;
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(cur.stripe_subscription_id);
    } catch (err) {
      // C-679-3 — Stripe has no such subscription: the attempt is over.
      if (!isResourceMissing(err)) throw stripeFailure(err);
      await this.expireAttempt(cur.id);
      throw attemptExpired('timed_out');
    }
    return this.finishBound(cur, sub, pkg, `tgp-${cur.idempotency_key}`, true);
  }

  /**
   * B-654-5 — take over an unbound reservation whose create ended
   * uncertainly (retry marker) or whose request died (in-flight marker older
   * than STALE_RESERVATION_MS). Atomic: exactly one request wins and resends
   * the pinned request. null = not claimable (still in flight, bound, ended).
   */
  private async claimUnbound(row: ClientPurchase): Promise<ClientPurchase | null> {
    if (row.stripe_subscription_id || row.stripe_client_secret) return null;
    if (row.entitlement_active || row.status !== 'pending') return null;
    const key = row.idempotency_key;
    const marker = row.stripe_checkout_session_id;
    const stale =
      marker === reservedMarker(key) &&
      row.updated_at instanceof Date &&
      Date.now() - row.updated_at.getTime() > STALE_RESERVATION_MS;
    if (marker !== retryMarker(key) && !stale) return null;
    const res = await this.prisma.clientPurchase.updateMany({
      where: {
        id: row.id,
        stripe_subscription_id: null,
        stripe_checkout_session_id: marker,
        ...(stale ? { updated_at: row.updated_at } : {}),
      },
      data: { stripe_checkout_session_id: reservedMarker(key) },
    });
    if (res.count !== 1) return null;
    this.logger.log(`billing.subscription_attempt_resumed purchase=${row.id} stale=${stale}`);
    return this.prisma.clientPurchase.findUnique({ where: { id: row.id } });
  }

  /** B-654-5 — the create ended without a clear answer: the next request resends it. */
  private async markRetryable(row: ClientPurchase): Promise<void> {
    try {
      await this.prisma.clientPurchase.updateMany({
        where: { id: row.id, stripe_subscription_id: null, status: 'pending' },
        data: { stripe_checkout_session_id: retryMarker(row.idempotency_key) },
      });
    } catch (err) {
      // The in-flight marker turns stale after STALE_RESERVATION_MS anyway.
      this.logger.error(`could not mark purchase=${row.id} for retry error=${errorLabel(err)}`);
    }
  }

  /** End an attempt that was never paid (its key answers ATTEMPT_EXPIRED). */
  private async expireAttempt(id: string): Promise<void> {
    await this.prisma.clientPurchase.updateMany({
      where: { id, entitlement_active: false, trial_started_at: null },
      data: { status: 'expired', stripe_client_secret: null, stripe_ephemeral_key: null },
    });
  }

  /**
   * B-654-5 — the subscription Stripe made for this attempt, found by
   * metadata.tgp_purchase_id among the customer's subscriptions. null =
   * Stripe has none; 'unreadable' = Stripe could not be read now.
   */
  private async findAttemptSubscription(
    row: ClientPurchase,
  ): Promise<StripeSubscriptionCheckoutObject | null | 'unreadable'> {
    if (!row.stripe_customer_id) return null;
    try {
      let list = await this.stripe.listSubscriptionsForCustomer(row.stripe_customer_id);
      const own = (l: typeof list) =>
        (l.data ?? []).find((s) => s.metadata?.tgp_purchase_id === row.id);
      let hit = own(list);
      if (!hit && list.has_more) {
        // C-679-2 — a full page without it: read only what was created since
        // this attempt began (5 min clock margin); its own subscription is newer.
        const createdGte = Math.floor(row.created_at.getTime() / 1000) - 300;
        list = await this.stripe.listSubscriptionsForCustomer(row.stripe_customer_id, {
          createdGte,
        });
        hit = own(list);
      }
      if (!hit) return list.has_more ? 'unreadable' : null;
      return await this.stripe.retrieveSubscriptionForCheckout(hit.id);
    } catch (err) {
      this.logger.warn(
        `attempt subscription lookup failed purchase=${row.id} error=${errorLabel(err)}`,
      );
      return 'unreadable';
    }
  }

  /**
   * B-654-7 — retire an attempt whose terms are no longer offered. Its
   * subscription (bound, or found by metadata when its create was uncertain)
   * is read first: paid, processing or a saved trial card answers 'settled'
   * and nothing is canceled. Otherwise the unpaid subscription is canceled
   * and the row ended. Stripe unreadable: a retryable error, nothing
   * canceled or ended.
   */
  private async retireAttempt(row: ClientPurchase): Promise<'retired' | 'settled'> {
    let sub: StripeSubscriptionCheckoutObject | null = null;
    if (row.stripe_subscription_id) {
      try {
        sub = await this.stripe.retrieveSubscriptionForCheckout(row.stripe_subscription_id);
      } catch (err) {
        // C-679-3 — Stripe has no such subscription: nothing can charge.
        if (!isResourceMissing(err)) throw stripeFailure(err);
      }
    } else if (parseCheckoutTerms(row.checkout_terms)) {
      const found = await this.findAttemptSubscription(row);
      if (found === 'unreadable') {
        await this.markRetryable(row);
        throw inProgress(true);
      }
      sub = found;
    }
    if (sub && (await this.attemptSettled(row, sub))) return 'settled';
    // B-654-8 — never end the attempt while its subscription may still charge.
    if (sub && (sub.status === 'incomplete' || sub.status === 'trialing')) {
      const end = await this.endUnpaid(row, sub);
      if (end === 'settled') return 'settled';
      if (end === 'unconfirmed') {
        await this.markRetryable(row);
        throw inProgress(true);
      }
    }
    await this.expireAttempt(row.id);
    this.logger.log(`billing.subscription_attempt_retired purchase=${row.id} reason=terms_changed`);
    return 'retired';
  }

  /**
   * True when the attempt's subscription was paid, its payment is in flight,
   * or its trial card was saved (B-654-1: the card is made the default).
   * Throws a retryable error when the trial's SetupIntent cannot be read.
   */
  private async attemptSettled(
    row: ClientPurchase,
    sub: StripeSubscriptionCheckoutObject,
  ): Promise<boolean> {
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return false;
    if (sub.status === 'trialing') {
      // B-679-8 (Opus) — with the create-time end still set, a default card
      // may not be the attempt's own: its SetupIntent decides.
      if (sub.default_payment_method && !sub.cancel_at_period_end) return true;
      let setup: TrialSetupState | null;
      try {
        setup = await readTrialSetup(this.stripe, row.stripe_client_secret, sub);
      } catch (err) {
        throw stripeFailure(err);
      }
      if (trialCardSaved(setup)) {
        await this.attachTrialCardQuietly(sub.id, setup.payment_method, row.id);
        return true;
      }
      // A default card whose SetupIntent cannot be found is never canceled.
      return setup ? setup.status === 'processing' : !!sub.default_payment_method;
    }
    return !subscriptionUnpaid(sub);
  }

  /**
   * Reuse an open attempt when Stripe still has it payable at the same
   * terms. Otherwise retire it (cancel on Stripe, mark expired) and return
   * null so the caller reserves a fresh attempt.
   */
  private async tryReuse(
    open: ClientPurchase,
    pkg: CoachPackage,
    pkgTrial: number,
    offered: PlanPrice,
    clientId: string,
    clientKey: string,
  ): Promise<SubscriptionIntentResult | null> {
    let cur = open;
    if (!cur.stripe_subscription_id) {
      // B-654-5 — its create ended uncertainly or its request died: finish it
      // under its own pinned request (never a second subscription).
      const own = await this.claimUnbound(cur);
      if (own) {
        const terms = parseCheckoutTerms(own.checkout_terms);
        if (terms && !termsStillOffered(terms, offered, pkgTrial)) {
          if ((await this.retireAttempt(own)) === 'settled') throw alreadyActive(own);
          return null;
        }
        try {
          return await this.mintSubscription(own, pkg, true);
        } catch (err) {
          // That attempt ended (nothing was created): reserve a fresh one.
          if (codeOfHttp(err) === 'SUBSCRIPTION_ATTEMPT_EXPIRED') return null;
          throw err;
        }
      }
      // Another request reserved it a moment ago and is still talking to
      // Stripe: wait for it and return the same Subscription.
      const winner = await this.waitForSecret(cur.idempotency_key);
      if (!winner || ENDED_ATTEMPT_STATUSES.has(winner.status)) return null;
      if (winner.stripe_client_secret && winner.stripe_subscription_id) {
        return intentResult(winner, pkg, true);
      }
      if (!winner.stripe_subscription_id) throw inProgress(false);
      cur = winner;
    }
    const subscriptionId = cur.stripe_subscription_id;
    if (!subscriptionId) throw inProgress(false);
    let sub: StripeSubscriptionCheckoutObject;
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
    } catch (err) {
      // C-679-3 — Stripe has no such subscription: end it, start a fresh one.
      if (!isResourceMissing(err)) throw stripeFailure(err);
      await this.expireAttempt(cur.id);
      return null;
    }
    // Paid (or card saved) a moment ago; the webhook will grant access.
    // B-654-8 — past_due / unpaid were active and still charge: the plan.
    // B-679-8 (Opus) — a trial default counts once its create-time end is lifted.
    const live = sub.status === 'active' || sub.status === 'past_due' || sub.status === 'unpaid';
    const trialSaved =
      sub.status === 'trialing' && !!sub.default_payment_method && !sub.cancel_at_period_end;
    if (live || trialSaved) {
      throw alreadyActive({ ...cur, status: sub.status });
    }
    // B-654-6 — a first payment already in flight or paid is never canceled.
    if (sub.status === 'incomplete' && !subscriptionUnpaid(sub)) {
      throw alreadyActive({ ...cur, status: sub.status });
    }
    let ownSheet: ReturnType<typeof sheetSecret> = null;
    if (sub.status === 'trialing') {
      // B-654-1 — the card may be saved although the subscription has no
      // default yet (pending_setup_intent is null after success). Such a
      // trial is never reused or retired: the card becomes the default and
      // the webhook grants the trial.
      let setup: TrialSetupState | null;
      try {
        setup = await readTrialSetup(this.stripe, cur.stripe_client_secret, sub);
      } catch (err) {
        throw stripeFailure(err);
      }
      if (trialCardSaved(setup)) {
        await this.attachTrialCardQuietly(sub.id, setup.payment_method, cur.id);
        throw alreadyActive({ ...cur, status: sub.status });
      }
      // B-679-10 — with no SetupIntent at all, no sheet was ever handed out:
      // a default card is not the attempt's own.
      if (setup?.status === 'processing') throw alreadyActive({ ...cur, status: sub.status });
      try {
        ownSheet = await ownTrialSheet(this.stripe, cur, sub, setup);
      } catch (err) {
        throw stripeFailure(err);
      }
    }
    const secret = sheetSecret(sub) ?? ownSheet;
    const terms = parseCheckoutTerms(cur.checkout_terms);
    const expectedPrice =
      terms?.recurring_price_id ??
      (pkg.billing_type !== 'recurring' ? pkg.recurring_stripe_price_id : pkg.stripe_price_id);
    const currentPrice =
      pkg.billing_type !== 'recurring' ? pkg.recurring_stripe_price_id : pkg.stripe_price_id;
    const itemPrice = sub.items?.data?.[0]?.price?.id ?? null;
    // R1-4 — today's charge must still match: a combo's first invoice carries
    // its one-time price, which the renewal-price check cannot see.
    const invoice =
      sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
    const firstChargeMatches =
      sub.status !== 'incomplete' ||
      typeof invoice?.amount_due !== 'number' ||
      invoice.amount_due === offered.first_charge_cents;
    // C-654-2 — a trial attempt is reusable only while the package still
    // offers that same trial (the coach removed or changed it: start over).
    const trialUnchanged = cur.trial_days == null || cur.trial_days === pkgTrial;
    // B-654-7 — the attempt's pinned terms must be today's terms.
    const termsUnchanged = !terms || termsStillOffered(terms, offered, pkgTrial);
    const stillPayable =
      (sub.status === 'incomplete' || sub.status === 'trialing') &&
      !!secret &&
      trialUnchanged &&
      termsUnchanged &&
      cur.amount_cents === offered.amount_cents &&
      firstChargeMatches &&
      (!itemPrice || !expectedPrice || expectedPrice === itemPrice) &&
      (!itemPrice || !currentPrice || currentPrice === itemPrice);
    if (stillPayable && secret) {
      let ephemeral: { secret: string };
      try {
        ephemeral = await this.stripe.createEphemeralKey(
          cur.stripe_customer_id ?? '',
          `tgp-sub-${clientId}-${clientKey}-ephkey`,
        );
      } catch (err) {
        throw stripeFailure(err);
      }
      const row = await this.storeCredentials(cur, sub, secret.client_secret, ephemeral.secret);
      // Ended meanwhile: the caller reserves a fresh attempt.
      return row ? intentResult(row, pkg, true, sub.status) : null;
    }
    // Stale: retire it so incomplete subscriptions never pile up. B-654-8 —
    // only once Stripe shows it ended; else retryable, never a second one.
    if (sub.status === 'incomplete' || sub.status === 'trialing') {
      const end = await this.endUnpaid(cur, sub);
      if (end === 'settled') throw alreadyActive({ ...cur, status: sub.status });
      if (end === 'unconfirmed') throw inProgress(true);
    }
    await this.expireAttempt(cur.id);
    return null;
  }

  private async packagesById(ids: string[]): Promise<Map<string, CoachPackage>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.coachPackage.findMany({ where: { id: { in: unique } } });
    return new Map(rows.map((p) => [p.id, p]));
  }

  private async waitForSecret(
    idempotencyKey: string,
    timeoutMs = 5_000,
    intervalMs = 100,
  ): Promise<ClientPurchase | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = await this.prisma.clientPurchase.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      if (!row) return null;
      if (row.stripe_client_secret && row.stripe_subscription_id) return row;
      // Over, or its create ended uncertainly (claimable now): stop waiting.
      if (
        row.status !== 'pending' ||
        row.stripe_checkout_session_id === retryMarker(idempotencyKey)
      ) {
        return row;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return this.prisma.clientPurchase.findUnique({ where: { idempotency_key: idempotencyKey } });
  }

  private async dropReservation(id: string): Promise<void> {
    try {
      await this.prisma.clientPurchase.deleteMany({
        where: { id, entitlement_active: false, stripe_client_secret: null },
      });
    } catch (err) {
      this.logger.error(`could not drop reservation purchase=${id} error=${errorLabel(err)}`);
    }
  }

  /**
   * C-679-1 — end an unpaid attempt's subscription without racing a payment
   * that lands after the caller's read: an incomplete subscription's open,
   * payable first invoice is voided first (Stripe never voids a paid one) and
   * a trial's pending SetupIntent is canceled first (Stripe refuses once the
   * card was saved). A refusal re-reads Stripe: paid, processing or a saved
   * card is 'settled' and nothing is canceled. 'ended' only once confirmed.
   */
  private async endUnpaid(
    row: ClientPurchase,
    sub: StripeSubscriptionCheckoutObject,
  ): Promise<'ended' | 'settled' | 'unconfirmed'> {
    const inv =
      sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
    const pi = inv && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
    const si = sub.pending_setup_intent;
    const siId =
      (si && typeof si === 'object' ? si.id : typeof si === 'string' ? si : null) ??
      setupIntentIdOf(row.stripe_client_secret);
    const siOpen = !(
      si &&
      typeof si === 'object' &&
      (si.status === 'canceled' || si.status === 'succeeded')
    );
    try {
      if (
        sub.status === 'incomplete' &&
        inv?.id &&
        inv.status === 'open' &&
        pi?.status &&
        PAYABLE_PI_STATUSES.has(pi.status)
      ) {
        await this.stripe.voidInvoice(inv.id, `tgp-void-${inv.id}`);
      } else if (sub.status === 'trialing' && siId && siOpen) {
        await this.stripe.cancelSetupIntent(siId, `tgp-seti-cancel-${siId}`);
      }
    } catch (err) {
      this.logger.warn(`cancel guard refused subscription=${sub.id} error=${errorLabel(err)}`);
      try {
        const now = await this.stripe.retrieveSubscriptionForCheckout(sub.id);
        if (now.status === 'canceled' || now.status === 'incomplete_expired') return 'ended';
        return (await this.attemptSettled(row, now)) ? 'settled' : 'unconfirmed';
      } catch (readErr) {
        this.logger.warn(
          `cancel guard unconfirmed subscription=${sub.id} error=${errorLabel(readErr)}`,
        );
        return 'unconfirmed';
      }
    }
    return (await this.cancelConfirmed(sub.id)) ? 'ended' : 'unconfirmed';
  }

  /**
   * B-654-8 — cancel an unpaid subscription; true only once Stripe shows it
   * ended. A failed or lost cancel is reconciled by reading it back.
   */
  private async cancelConfirmed(subscriptionId: string): Promise<boolean> {
    try {
      await this.stripe.cancelSubscription(subscriptionId);
      return true;
    } catch (err) {
      this.logger.warn(`cancel failed subscription=${subscriptionId} error=${errorLabel(err)}`);
    }
    try {
      const now = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
      return now.status === 'canceled' || now.status === 'incomplete_expired';
    } catch (err) {
      this.logger.warn(
        `cancel unconfirmed subscription=${subscriptionId} error=${errorLabel(err)}`,
      );
      return false;
    }
  }

  /**
   * R1-6 — cancel trial attempts older than the reuse window whose card was
   * never saved (Stripe `trialing`, no default payment method) and mark them
   * expired. A trial whose card WAS saved is left alone (its webhook is only
   * late; the webhook grants it). Bounded, out of any DB transaction, and
   * never throws: a failure leaves the attempt to end with its trial
   * (`missing_payment_method=cancel`), exactly as before.
   */
  private async retireStaleTrialAttempts(
    clientId: string,
    coachId: string,
    packageId: string,
  ): Promise<ClientPurchase[]> {
    const cardSaved: ClientPurchase[] = [];
    try {
      const before = new Date(Date.now() - OPEN_ATTEMPT_MAX_AGE_MS);
      const stale = await this.prisma.clientPurchase.findMany({
        where: {
          client_user_id: clientId,
          coach_user_id: coachId,
          billing_type: 'recurring',
          entitlement_active: false,
          trial_started_at: null,
          trial_days: { not: null },
          status: { in: [...OPEN_ATTEMPT_STATUSES] },
          idempotency_key: { startsWith: `sub-${clientId}-` },
          created_at: { lte: before },
        },
        orderBy: { created_at: 'desc' },
        take: STALE_TRIAL_RETIRE_LIMIT,
      });
      for (const row of stale) {
        try {
          const subscriptionId =
            row.stripe_subscription_id ?? (await this.resolveStaleUnbound(row, packageId));
          if (!subscriptionId) continue;
          const outcome = await this.retireOneStaleTrial(row, subscriptionId);
          if (outcome === 'card_saved') cardSaved.push(row);
        } catch (err) {
          // One unreadable attempt never stops the others or the checkout.
          this.logger.warn(`stale trial attempt kept purchase=${row.id} error=${errorLabel(err)}`);
        }
      }
    } catch (err) {
      this.logger.warn(
        `stale trial attempt cleanup skipped client=${clientId} error=${errorLabel(err)}`,
      );
    }
    return cardSaved;
  }

  /**
   * B-679-1 — an old unbound trial attempt holds its one-trial reservation
   * until Stripe answers for it: its subscription (found by metadata) is
   * bound, then reused for this same plan (never a second one) or retired
   * like any stale trial for another plan; none at all (past the key window)
   * releases it; unreadable or still in flight keeps it. null = nothing to
   * retire now.
   */
  private async resolveStaleUnbound(
    row: ClientPurchase,
    packageId: string,
  ): Promise<string | null> {
    const inFlight =
      row.stripe_checkout_session_id === reservedMarker(row.idempotency_key) &&
      Date.now() - row.updated_at.getTime() <= STALE_RESERVATION_MS;
    if (inFlight || row.status !== 'pending') return null;
    const found = parseCheckoutTerms(row.checkout_terms)
      ? await this.findAttemptSubscription(row)
      : null;
    if (found === 'unreadable') return null;
    if (!found) {
      // Sol B-679-7 — only the attempt as read (same marker and stamp): one a
      // request claimed meanwhile is that request's.
      const res = await this.prisma.clientPurchase.updateMany({
        where: {
          id: row.id,
          status: 'pending',
          stripe_subscription_id: null,
          stripe_checkout_session_id: row.stripe_checkout_session_id,
          updated_at: row.updated_at,
        },
        data: { status: 'expired', stripe_client_secret: null, stripe_ephemeral_key: null },
      });
      if (res.count === 1) this.logger.log(`billing.trial_attempt_released purchase=${row.id}`);
      return null;
    }
    const res = await this.prisma.clientPurchase.updateMany({
      where: { id: row.id, stripe_subscription_id: null, status: 'pending' },
      data: {
        stripe_subscription_id: found.id,
        stripe_checkout_session_id: found.id,
        current_period_end:
          typeof found.current_period_end === 'number'
            ? new Date(found.current_period_end * 1000)
            : null,
      },
    });
    return res.count === 1 && row.package_id !== packageId ? found.id : null;
  }

  /**
   * B-654-1 — retire one stale trial attempt. Cancels on Stripe only when the
   * trial's SetupIntent shows no card was ever saved (requires_payment_method
   * or canceled). A saved card (succeeded) is made the default instead, and
   * any other or unreadable state leaves the attempt alone.
   */
  private async retireOneStaleTrial(
    row: ClientPurchase,
    subscriptionId: string,
  ): Promise<'kept' | 'card_saved' | 'retired'> {
    let sub: StripeSubscriptionCheckoutObject | null = null;
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
    } catch (err) {
      // C-679-3 — Stripe has no such subscription: release its reservation.
      if (!isResourceMissing(err)) throw err;
    }
    if (sub && sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
      if (sub.status !== 'trialing') return 'kept';
      // B-679-8 (Opus) — a default counts once its create-time end is lifted.
      if (sub.default_payment_method && !sub.cancel_at_period_end) return 'card_saved';
      const setup = await readTrialSetup(this.stripe, row.stripe_client_secret, sub);
      if (trialCardSaved(setup)) {
        await attachTrialCard(this.stripe, sub.id, setup.payment_method);
        this.logger.log(`billing.trial_card_attached purchase=${row.id} via=retire`);
        return 'card_saved';
      }
      if (!setup || (setup.status !== 'requires_payment_method' && setup.status !== 'canceled')) {
        return 'kept';
      }
      const end = await this.endUnpaid(row, sub);
      if (end !== 'ended') return end === 'settled' ? 'card_saved' : 'kept';
    }
    await this.prisma.clientPurchase.updateMany({
      where: { id: row.id, entitlement_active: false, trial_started_at: null },
      data: { status: 'expired', stripe_client_secret: null, stripe_ephemeral_key: null },
    });
    this.logger.log(
      `billing.trial_attempt_retired purchase=${row.id} stripe_status=${sub?.status ?? 'missing'}`,
    );
    return 'retired';
  }

  /**
   * C-654-3 — is a replayed attempt's stored sheet secret still usable?
   * 'settled': the card was saved / the first invoice paid or is processing
   * (the webhook grants access); 'dead': the intent was canceled or the
   * subscription ended; 'usable' otherwise, and on a Stripe read error (the
   * previous behaviour: hand back the stored secret). Opus B-679-9: a
   * canceled SetupIntent is 'dead' only once its trial ended ('unconfirmed'
   * while that is not confirmed).
   */
  private async replaySecretState(
    row: ClientPurchase,
  ): Promise<'usable' | 'settled' | 'dead' | 'unconfirmed'> {
    const subscriptionId = row.stripe_subscription_id;
    if (!subscriptionId || !this.state.ready) return 'usable';
    try {
      if (setupIntentIdOf(row.stripe_client_secret)) {
        const setup = await readTrialSetup(this.stripe, row.stripe_client_secret);
        if (trialCardSaved(setup)) {
          await this.attachTrialCardQuietly(subscriptionId, setup.payment_method, row.id);
          return 'settled';
        }
        if (setup?.status === 'processing') return 'settled';
        if (setup?.status === 'canceled') return this.canceledSetupState(row, subscriptionId);
        return 'usable';
      }
      const sub = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'dead';
      if (sub.status === 'active' || sub.status === 'past_due') return 'settled';
      const inv = sub.latest_invoice;
      const pi = inv && typeof inv === 'object' ? inv.payment_intent : null;
      const piStatus = pi && typeof pi === 'object' ? pi.status : undefined;
      if (piStatus === 'succeeded' || piStatus === 'processing') return 'settled';
      if (piStatus === 'canceled') return 'dead';
      return 'usable';
    } catch (err) {
      // C-679-3 — Stripe has no such subscription: the attempt is over.
      if (isResourceMissing(err) && !setupIntentIdOf(row.stripe_client_secret)) return 'dead';
      this.logger.warn(`replay secret check skipped purchase=${row.id} error=${errorLabel(err)}`);
      return 'usable';
    }
  }

  /** Opus B-679-9 — end the trial of a canceled SetupIntent, guarded; never assumed. */
  private async canceledSetupState(
    row: ClientPurchase,
    subscriptionId: string,
  ): Promise<'settled' | 'dead' | 'unconfirmed'> {
    try {
      const sub = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'dead';
      const end = await this.endUnpaid(row, sub);
      return end === 'ended' ? 'dead' : end;
    } catch (err) {
      if (isResourceMissing(err)) return 'dead';
      this.logger.warn(`replay trial end unconfirmed purchase=${row.id} error=${errorLabel(err)}`);
      return 'unconfirmed';
    }
  }

  /** attachTrialCard that only logs on failure (the webhook path retries). */
  private async attachTrialCardQuietly(
    subscriptionId: string,
    paymentMethodId: string,
    purchaseId: string,
  ): Promise<void> {
    try {
      await attachTrialCard(this.stripe, subscriptionId, paymentMethodId);
    } catch (err) {
      this.logger.warn(
        `trial card attach deferred purchase=${purchaseId} error=${errorLabel(err)}`,
      );
    }
  }

  /**
   * R1-2 — an entitled row for this package that is not a subscription: an
   * invite-code grant (free / prepaid), a free claim, or a one-time purchase
   * still inside its access window.
   */
  private findIncluded(
    db: Tx | PrismaService,
    clientId: string,
    packageId: string,
  ): Promise<ClientPurchase | null> {
    return db.clientPurchase.findFirst({
      where: {
        client_user_id: clientId,
        package_id: packageId,
        entitlement_active: true,
        stripe_subscription_id: null,
        OR: [{ access_expires_at: null }, { access_expires_at: { gt: new Date() } }],
      },
      orderBy: { created_at: 'desc' },
    });
  }

  private assertReady(): void {
    if (!this.state.ready) {
      throw new ServiceUnavailableException({
        code: 'CONNECT_NOT_CONFIGURED',
        error: 'CONNECT_NOT_CONFIGURED',
        message:
          'Payments are not switched on here yet, so this plan cannot start. Nothing was charged.',
      });
    }
  }
}
