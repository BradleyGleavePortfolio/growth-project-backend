import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import { ConnectModuleState } from '../connect/connect.module-state';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeSubscriptionCheckoutObject,
} from '../connect/stripe-connect-api.service';
import { PackagesService } from '../packages/packages.service';
import { PrismaService } from '../prisma.service';
import { CheckoutService, isRecurringPackage } from './checkout.service';

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

/** pg_advisory_xact_lock namespace: ASCII 'subc'. */
export const ADVISORY_LOCK_NAMESPACE_SUBSCRIPTION_CHECKOUT = 0x73_75_62_63;

/** Stripe expires an unpaid `incomplete` subscription after 23 hours. */
const OPEN_ATTEMPT_MAX_AGE_MS = 23 * 3600 * 1000;

/** Statuses of a row that is an attempt nobody has paid for yet. */
const OPEN_ATTEMPT_STATUSES = ['pending', 'incomplete', 'payment_failed'] as const;

/** Statuses that mean the client already has this plan. */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'] as const;

/** PaymentIntent statuses a PaymentSheet can still complete. */
const PAYABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

/** Longest trial the checkout will start (B-TRIALS validates the package side). */
export const MAX_TRIAL_DAYS = 730;

export interface SubscriptionIntentInput {
  package_id: string;
  idempotency_key: string;
  expected_amount_cents?: number;
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
  /** PaymentSheet mode: 'payment' charges now; 'setup' saves a card for a trial. */
  mode: 'payment' | 'setup';
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
}

type Tx = Prisma.TransactionClient;

type Decision =
  | { kind: 'active'; purchase: ClientPurchase }
  | { kind: 'reuse'; purchase: ClientPurchase }
  | { kind: 'reserved'; purchase: ClientPurchase; trialDays: number };

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

function asInterval(v: string | null | undefined): 'week' | 'month' | 'year' | null {
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

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function expandedId(v: { id?: string } | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : (v.id ?? null);
}

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
    if (!client) {
      throw new NotFoundException({
        code: 'CLIENT_NOT_FOUND',
        error: 'CLIENT_NOT_FOUND',
        message: 'Your account was not found. Sign out and sign back in, then try again.',
      });
    }
    const pkg = await this.packages.getById(input.package_id);
    // Same visibility rule as the one-time path: unpublished, archived,
    // inactive, or another coach's package is a non-leaking 404.
    if (
      !pkg ||
      !pkg.is_active ||
      pkg.archived_at ||
      !pkg.published_at ||
      !client.coach_id ||
      pkg.coach_id !== client.coach_id
    ) {
      throw this.packageUnavailable();
    }
    // $0 packages and invite-code grants never create Stripe objects.
    if (pkg.amount_cents === 0 && !isRecurringPackage(pkg)) {
      throw new BadRequestException({
        code: 'PACKAGE_IS_FREE',
        error: 'PACKAGE_IS_FREE',
        message: 'This plan is free. Claim it from the plan screen; no card is needed.',
      });
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
      // A recurring price of $0 is not a subscription Stripe can bill; the
      // package side (#629) refuses it, this is the defensive backstop.
      throw this.packageUnavailable();
    }
    if (
      typeof input.expected_amount_cents === 'number' &&
      input.expected_amount_cents !== offeredPrice.amount_cents
    ) {
      throw new ConflictException({
        code: 'PACKAGE_PRICE_CHANGED',
        error: 'PACKAGE_PRICE_CHANGED',
        message:
          'The price of this plan changed since you opened it. Review the new price before you start.',
        amount_cents: offeredPrice.amount_cents,
        currency: offeredPrice.currency,
      });
    }

    const purchaseKey = `sub-${client.id}-${input.idempotency_key}`;

    // Fast path: exact same attempt (retry after a timeout, double tap with
    // the same key). Returns the same Subscription without any Stripe write.
    const replay = await this.prisma.clientPurchase.findUnique({
      where: { idempotency_key: purchaseKey },
    });
    if (replay && replay.client_user_id === client.id) {
      if (replay.stripe_client_secret && replay.stripe_subscription_id) {
        return this.resultFromRow(replay, pkg, true);
      }
      const winner = await this.waitForSecret(purchaseKey);
      if (winner?.stripe_client_secret && winner.stripe_subscription_id) {
        return this.resultFromRow(winner, pkg, true);
      }
      throw this.inProgress(winner === null);
    }

    const coach = await this.prisma.user.findUnique({
      where: { id: pkg.coach_id },
      select: { id: true, email: true, name: true },
    });
    if (!coach) throw this.packageUnavailable();
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
      if (decision.kind === 'active') throw this.alreadyActive(decision.purchase);
      if (decision.kind === 'reserved') {
        return this.mintSubscription({
          reservation: decision.purchase,
          pkg,
          trialDays: decision.trialDays,
          clientId: client.id,
          coachId: coach.id,
          customerId: customer.stripe_customer_id,
          destination: connectAccount.stripe_account_id,
          clientKey: input.idempotency_key,
        });
      }
      // Reuse candidate: an open attempt for the same package.
      const reused = await this.tryReuse(decision.purchase, pkg, client.id, input.idempotency_key);
      if (reused) return reused;
    }
    // Two stale attempts in a row means Stripe and the database disagree.
    throw this.inProgress(true);
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
    return real.map((r) => this.toPlanView(r, pkgs.get(r.package_id) ?? null));
  }

  async getPlan(clientUserId: string, purchaseId: string): Promise<ClientPlanView> {
    const row = await this.prisma.clientPurchase.findFirst({
      where: { id: purchaseId, client_user_id: clientUserId },
    });
    if (!row || row.billing_type !== 'recurring' || !row.stripe_subscription_id) {
      throw this.planNotFound();
    }
    const pkg = await this.prisma.coachPackage.findUnique({ where: { id: row.package_id } });
    await this.syncTrialCard(row);
    return this.toPlanView(row, pkg);
  }

  /**
   * Trial backstop while the app waits on "Confirming your plan": when the
   * trial's SetupIntent succeeded but the subscription has no default card
   * yet, set it on Stripe. Stripe then sends customer.subscription.updated
   * and the webhook grants the trial. Never grants access itself; any
   * failure is logged and the webhook path stays the source of truth.
   */
  private async syncTrialCard(row: ClientPurchase): Promise<void> {
    if (
      row.trial_days == null ||
      row.entitlement_active ||
      row.trial_started_at ||
      !row.stripe_subscription_id ||
      row.status === 'expired' ||
      row.status === 'canceled' ||
      !this.state.ready
    ) {
      return;
    }
    try {
      const sub = await this.stripe.retrieveSubscriptionForCheckout(row.stripe_subscription_id);
      const si = sub.pending_setup_intent;
      if (
        sub.status === 'trialing' &&
        !sub.default_payment_method &&
        si &&
        typeof si === 'object' &&
        si.status === 'succeeded' &&
        typeof si.payment_method === 'string'
      ) {
        await this.stripe.setSubscriptionDefaultPaymentMethod({
          subscriptionId: sub.id,
          paymentMethodId: si.payment_method,
          idempotencyKey: `tgp-trial-card-${sub.id}-${si.payment_method}`,
        });
      }
    } catch (err) {
      this.logger.warn(`trial card sync skipped purchase=${row.id}: ${(err as Error).message}`);
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
      throw this.planNotFound();
    }
    const pkg = await this.prisma.coachPackage.findUnique({ where: { id: row.package_id } });
    if (!row.cancel_at_period_end) return this.toPlanView(row, pkg);
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
      throw this.stripeFailure(err);
    }
    const periodEnd =
      typeof sub.current_period_end === 'number'
        ? new Date(sub.current_period_end * 1000)
        : row.current_period_end;
    const updated = await this.prisma.clientPurchase.update({
      where: { id: row.id },
      data: { cancel_at_period_end: !!sub.cancel_at_period_end, current_period_end: periodEnd },
    });
    this.logger.log(`billing.client_plan_resumed purchase=${row.id}`);
    return this.toPlanView(updated, pkg);
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

      // 1. Already on this plan -> coded 409 the app explains.
      const live = await tx.clientPurchase.findFirst({
        where: {
          client_user_id: args.clientId,
          package_id: args.pkg.id,
          billing_type: 'recurring',
          stripe_subscription_id: { not: null },
          OR: [{ entitlement_active: true }, { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } }],
        },
        orderBy: { created_at: 'desc' },
      });
      if (live) return { kind: 'active', purchase: live };

      // 2. An open attempt for the same package (any key) -> reuse it.
      const since = new Date(Date.now() - OPEN_ATTEMPT_MAX_AGE_MS);
      const open = await tx.clientPurchase.findFirst({
        where: {
          client_user_id: args.clientId,
          package_id: args.pkg.id,
          billing_type: 'recurring',
          entitlement_active: false,
          status: { in: [...OPEN_ATTEMPT_STATUSES] },
          idempotency_key: { startsWith: `sub-${args.clientId}-` },
          created_at: { gt: since },
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
                status: { in: [...OPEN_ATTEMPT_STATUSES] },
                created_at: { gt: since },
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

  private async mintSubscription(args: {
    reservation: ClientPurchase;
    pkg: CoachPackage;
    trialDays: number;
    clientId: string;
    coachId: string;
    customerId: string;
    destination: string;
    clientKey: string;
  }): Promise<SubscriptionIntentResult> {
    const { reservation, pkg } = args;
    const stripeKey = `tgp-sub-${args.clientId}-${args.clientKey}`;
    let sub: StripeSubscriptionCheckoutObject;
    let ephemeral: { secret: string };
    try {
      const isCombo = pkg.billing_type !== 'recurring';
      const recurringPriceId = isCombo
        ? await this.checkout.ensureRecurringPriceForPackage(pkg)
        : await this.checkout.ensurePriceForPackage(pkg);
      const oneTimePriceId = isCombo ? await this.checkout.ensurePriceForPackage(pkg) : undefined;
      // Pre-charge preview only (metadata + fee-policy validation), exactly
      // like the one-time path. Settlement reads Stripe's actual fee later.
      const plan = await this.feePolicy.planFor(args.coachId, reservation.amount_cents);
      const metadata = {
        tgp_client_user_id: args.clientId,
        tgp_coach_user_id: args.coachId,
        tgp_package_id: pkg.id,
        tgp_purchase_id: reservation.id,
        tgp_head_coach_user_id: plan.head_coach_id ?? '',
        tgp_fee_mechanism: 'separate_charge_transfer',
        tgp_checkout: 'native_subscription',
      };
      sub = await this.stripe.createSubscription({
        customer: args.customerId,
        recurringPriceId,
        oneTimePriceId,
        onBehalfOf: args.destination,
        metadata,
        trialPeriodDays: args.trialDays > 0 ? args.trialDays : undefined,
        idempotencyKey: stripeKey,
      });
      ephemeral = await this.stripe.createEphemeralKey(args.customerId, `${stripeKey}-ephkey`);
    } catch (err) {
      // Free the key so a same-key retry becomes the new winner. If Stripe
      // did create the Subscription, the retry's identical Stripe
      // Idempotency-Key returns that same Subscription (no duplicate).
      await this.dropReservation(reservation.id);
      throw this.stripeFailure(err);
    }

    const secret = this.sheetSecret(sub);
    if (!secret) {
      this.logger.error(
        `subscription ${sub.id} returned without a payable PaymentIntent or SetupIntent; canceling it`,
      );
      await this.cancelQuietly(sub.id);
      await this.dropReservation(reservation.id);
      throw new ServiceUnavailableException({
        code: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
        error: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
        message:
          'The card screen could not be prepared for this plan. Nothing was charged. Try again in a minute.',
      });
    }

    const piId = expandedId(
      sub.latest_invoice && typeof sub.latest_invoice === 'object'
        ? sub.latest_invoice.payment_intent
        : null,
    );
    const updated = await this.prisma.clientPurchase.update({
      where: { id: reservation.id },
      data: {
        stripe_checkout_session_id: sub.id,
        stripe_subscription_id: sub.id,
        stripe_payment_intent_id: piId,
        stripe_client_secret: secret.client_secret,
        stripe_ephemeral_key: ephemeral.secret,
        status: 'pending',
        current_period_end:
          typeof sub.current_period_end === 'number'
            ? new Date(sub.current_period_end * 1000)
            : null,
      },
    });
    return this.resultFromRow(updated, pkg, false, sub.status);
  }

  /**
   * Reuse an open attempt when Stripe still has it payable at the same
   * price. Otherwise retire it (cancel on Stripe, mark expired) and return
   * null so the caller reserves a fresh attempt.
   */
  private async tryReuse(
    open: ClientPurchase,
    pkg: CoachPackage,
    clientId: string,
    clientKey: string,
  ): Promise<SubscriptionIntentResult | null> {
    if (!open.stripe_subscription_id || !open.stripe_client_secret) {
      // Another request reserved it a moment ago and is still talking to
      // Stripe: wait for it and return the same Subscription.
      const winner = await this.waitForSecret(open.idempotency_key);
      if (winner?.stripe_client_secret && winner.stripe_subscription_id) {
        return this.resultFromRow(winner, pkg, true);
      }
      throw this.inProgress(winner === null);
    }
    let sub: StripeSubscriptionCheckoutObject;
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(open.stripe_subscription_id);
    } catch (err) {
      throw this.stripeFailure(err);
    }
    if (sub.status === 'active' || (sub.status === 'trialing' && !!sub.default_payment_method)) {
      // Paid (or card saved) a moment ago; the webhook will grant access.
      throw this.alreadyActive({ ...open, status: sub.status });
    }
    const secret = this.sheetSecret(sub);
    const expectedPrice =
      pkg.billing_type !== 'recurring' ? pkg.recurring_stripe_price_id : pkg.stripe_price_id;
    const itemPrice = sub.items?.data?.[0]?.price?.id ?? null;
    const stillPayable =
      (sub.status === 'incomplete' || sub.status === 'trialing') &&
      !!secret &&
      open.amount_cents === planPriceFor(pkg, 0).amount_cents &&
      (!expectedPrice || !itemPrice || expectedPrice === itemPrice);
    if (stillPayable && secret) {
      let ephemeral: { secret: string };
      try {
        ephemeral = await this.stripe.createEphemeralKey(
          open.stripe_customer_id ?? '',
          `tgp-sub-${clientId}-${clientKey}-ephkey`,
        );
      } catch (err) {
        throw this.stripeFailure(err);
      }
      const row = await this.prisma.clientPurchase.update({
        where: { id: open.id },
        data: {
          stripe_client_secret: secret.client_secret,
          stripe_ephemeral_key: ephemeral.secret,
        },
      });
      return this.resultFromRow(row, pkg, true, sub.status);
    }
    // Stale: retire it so incomplete subscriptions never pile up.
    if (sub.status === 'incomplete' || sub.status === 'trialing') {
      await this.cancelQuietly(sub.id);
    }
    await this.prisma.clientPurchase.updateMany({
      where: { id: open.id, entitlement_active: false },
      data: { status: 'expired', stripe_client_secret: null, stripe_ephemeral_key: null },
    });
    return null;
  }

  private sheetSecret(
    sub: StripeSubscriptionCheckoutObject,
  ): { mode: 'payment' | 'setup'; client_secret: string } | null {
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

  private resultFromRow(
    row: ClientPurchase,
    pkg: CoachPackage,
    reused: boolean,
    stripeStatus?: string,
  ): SubscriptionIntentResult {
    const trialDays = row.trial_days ?? 0;
    const price = planPriceFor(pkg, trialDays);
    const secret = row.stripe_client_secret ?? '';
    // A SetupIntent client secret starts with `seti_`; a PaymentIntent's with `pi_`.
    const mode: 'payment' | 'setup' = secret.startsWith('seti_') ? 'setup' : 'payment';
    return {
      mode,
      client_secret: secret,
      ephemeral_key: row.stripe_ephemeral_key ?? '',
      customer_id: row.stripe_customer_id ?? '',
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
      purchase_id: row.id,
      subscription_id: row.stripe_subscription_id ?? '',
      status: stripeStatus ?? row.status,
      reused,
      plan: {
        ...price,
        package_id: pkg.id,
        package_name: pkg.name,
        trial_ends_at: trialDays > 0 ? iso(row.current_period_end) : null,
      },
    };
  }

  toPlanView(row: ClientPurchase, pkg: CoachPackage | null): ClientPlanView {
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
          (pkg.billing_type === 'recurring' ? pkg.interval_count : pkg.recurring_interval_count) ??
            1,
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
    };
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
      this.logger.error(`could not drop subscription reservation ${id}: ${(err as Error).message}`);
    }
  }

  private async cancelQuietly(subscriptionId: string): Promise<void> {
    try {
      await this.stripe.cancelSubscription(subscriptionId);
    } catch (err) {
      this.logger.warn(
        `could not cancel stale subscription ${subscriptionId}: ${(err as Error).message}; Stripe expires it after 23 h`,
      );
    }
  }

  private alreadyActive(row: ClientPurchase): HttpException {
    return new ConflictException({
      code: 'SUBSCRIPTION_ALREADY_ACTIVE',
      error: 'SUBSCRIPTION_ALREADY_ACTIVE',
      message: row.cancel_at_period_end
        ? 'You already have this plan, and it is set to end at the close of this period. Keep it from Your plan instead of starting it again.'
        : 'You already have this plan, so nothing more was charged. Open Your plan to see your next charge date.',
      purchase_id: row.id,
      cancel_at_period_end: row.cancel_at_period_end,
      current_period_end: iso(row.current_period_end),
    });
  }

  private packageUnavailable(): HttpException {
    return new NotFoundException({
      code: 'PACKAGE_NOT_FOUND',
      error: 'PACKAGE_NOT_FOUND',
      message:
        'This plan is no longer available. Pull down to refresh your coach’s plans, or message your coach.',
    });
  }

  private planNotFound(): HttpException {
    return new NotFoundException({
      code: 'PURCHASE_NOT_FOUND',
      error: 'PURCHASE_NOT_FOUND',
      message: 'That plan was not found on your account. Pull down to refresh your plans.',
    });
  }

  private inProgress(retryable: boolean): HttpException {
    return retryable
      ? new ServiceUnavailableException({
          code: 'PAYMENT_RETRY',
          error: 'PAYMENT_RETRY',
          message:
            'The last attempt to start this plan did not finish. Nothing was charged. Try again.',
        })
      : new ServiceUnavailableException({
          code: 'PAYMENT_IN_PROGRESS',
          error: 'PAYMENT_IN_PROGRESS',
          message: 'This plan is still being set up. Give it a few seconds, then try again.',
        });
  }

  private stripeFailure(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof StripeConnectApiError) {
      const status = err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
      return new HttpException(
        {
          code: 'STRIPE_CHECKOUT_ERROR',
          error: 'STRIPE_CHECKOUT_ERROR',
          message:
            'The payment service did not answer as expected. Nothing was charged. Try again in a minute.',
          stripeCode: err.stripeCode,
        },
        status === 400 || status === 402 ? 502 : status,
      );
    }
    throw err;
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
