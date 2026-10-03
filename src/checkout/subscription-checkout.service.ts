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
import {
  attachTrialCard,
  readTrialSetup,
  setupIntentIdOf,
  trialCardSaved,
  type TrialSetupState,
} from './trial-card';
import {
  checkoutTermsFor,
  parseCheckoutTerms,
  planPriceFromTerms,
  termsStillOffered,
  type CheckoutTermsSnapshot,
} from './subscription-terms';

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

/**
 * Statuses of a row that is an attempt nobody has paid for yet (with
 * entitlement_active=false and trial_started_at=null). 'trialing' is one of
 * them: a trial attempt mirrors Stripe 'trialing' as soon as its $0 trial
 * invoice is paid, before the client saved a card (B-RECUR-BE R1-1).
 */
const OPEN_ATTEMPT_STATUSES = ['pending', 'incomplete', 'payment_failed', 'trialing'] as const;

/**
 * Statuses that mean the client already has this plan. 'trialing' counts
 * only once the trial started (trial_started_at set, card saved).
 */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'unpaid'] as const;

/** Statuses of an attempt that is over; its key can never start a plan again. */
const ENDED_ATTEMPT_STATUSES = new Set(['expired', 'canceled', 'incomplete_expired']);

/** Most stale trial attempts retired per checkout call (bounded Stripe work). */
const STALE_TRIAL_RETIRE_LIMIT = 3;

/**
 * B-654-5 — a reservation still marked in flight after this long belongs to
 * a request that died (every Stripe call is bounded by a 10 s client
 * timeout, and one mint makes at most four). A later request may take it
 * over and finish it with the same pinned request.
 */
const STALE_RESERVATION_MS = 120_000;

/** Marker of a reservation whose request is running right now. */
function reservedMarker(purchaseKey: string): string {
  return `sub-reserved-${purchaseKey}`;
}

/**
 * Marker of a reservation whose Subscription create ended without a clear
 * answer (timeout, 5xx, 429, connection drop): Stripe may or may not have
 * created it. The next request for the attempt resends the pinned request.
 */
function retryMarker(purchaseKey: string): string {
  return `sub-retry-${purchaseKey}`;
}

/**
 * True when Stripe answered a create definitively, so nothing was created and
 * Stripe stored that answer under the Idempotency-Key (4xx other than a key
 * conflict, an in-use key or a rate limit).
 */
function isDefinitiveRefusal(err: unknown): boolean {
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
function codeOfHttp(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const body: unknown = err.getResponse();
  if (!body || typeof body !== 'object') return null;
  const code: unknown = Reflect.get(body, 'code');
  return typeof code === 'string' ? code : null;
}

/** Stripe kept this Idempotency-Key for a request with other parameters. */
function isIdempotencyMismatch(err: unknown): boolean {
  return (
    err instanceof StripeConnectApiError &&
    err.httpStatus === 400 &&
    err.stripeType === 'idempotency_error'
  );
}

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

type Tx = Prisma.TransactionClient;

type Decision =
  | { kind: 'included'; purchase: ClientPurchase }
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
    if (!pkg || !pkg.is_active || pkg.archived_at || !pkg.published_at) {
      throw this.packageUnavailable();
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
        throw this.coachNotConnected(client.coach_id ? 'other_coach' : 'no_coach');
      }
      throw this.packageUnavailable();
    }
    // $0 packages and invite-code grants never create Stripe objects. A
    // recurring package priced $0 is free too (claimable through
    // /v1/packages/:id/claim-free, which keys on amount_cents = 0).
    if (pkg.amount_cents === 0 && (!isRecurringPackage(pkg) || pkg.billing_type === 'recurring')) {
      throw this.packageIsFree();
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
      throw this.packageIsFree();
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
      return this.replayAttempt(replay, pkg, pkgTrial, offeredPrice);
    }

    // R1-2 — already included (invite grant, free claim, one-time purchase):
    // answered before any Stripe object (customer, subscription) exists.
    const included = await this.findIncluded(this.prisma, client.id, pkg.id);
    if (included) throw this.alreadyIncluded(included);

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

    // R1-6 — trial attempts abandoned before the card was saved stay
    // `trialing` on Stripe until the trial ends (Stripe expires only
    // `incomplete` ones after 23 h). Retire the stale ones now. Best effort:
    // it never blocks this checkout.
    const cardSaved = await this.retireStaleTrialAttempts(client.id, coach.id);
    // B-654-1 — a stale trial of THIS package whose card turned out saved is
    // the client's plan (the webhook grants it); never start a second one.
    const savedHere = cardSaved.find((r) => r.package_id === pkg.id);
    if (savedHere) throw this.alreadyActive(savedHere);

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
      if (decision.kind === 'included') throw this.alreadyIncluded(decision.purchase);
      if (decision.kind === 'active') throw this.alreadyActive(decision.purchase);
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
    const checkoutState = await this.readCheckoutState(row);
    return { ...this.toPlanView(row, pkg), checkout_state: checkoutState };
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
        if (sub.default_payment_method) return 'card_saved';
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
      this.logger.warn(`checkout state read skipped purchase=${row.id}: ${(err as Error).message}`);
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

      // 2. An open attempt for the same package (any key) -> reuse it.
      const since = new Date(Date.now() - OPEN_ATTEMPT_MAX_AGE_MS);
      const open = await tx.clientPurchase.findFirst({
        where: {
          client_user_id: args.clientId,
          package_id: args.pkg.id,
          billing_type: 'recurring',
          entitlement_active: false,
          trial_started_at: null,
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
                entitlement_active: false,
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
   *      retry; the next request for it resends the pinned request, and if
   *      Stripe reports the key was used with other parameters, the
   *      subscription is found by metadata.tgp_purchase_id or the attempt
   *      ends (nothing was created).
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
      throw this.stripeFailure(err);
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
    let sub: StripeSubscriptionCheckoutObject;
    try {
      sub = await this.stripe.createSubscription({
        customer: customerId,
        recurringPriceId: terms.recurring_price_id,
        oneTimePriceId: terms.one_time_price_id ?? undefined,
        onBehalfOf: destination,
        metadata,
        trialPeriodDays: terms.trial_days > 0 ? terms.trial_days : undefined,
        idempotencyKey: stripeKey,
      });
    } catch (err) {
      if (isIdempotencyMismatch(err)) {
        const found = await this.findAttemptSubscription(reservation);
        if (found === 'unreadable') {
          await this.markRetryable(reservation);
          throw this.inProgress(true);
        }
        if (!found) {
          // Stripe holds the key for another request and has no
          // subscription for this attempt: nothing was created or charged.
          await this.expireAttempt(reservation.id);
          throw this.attemptExpired('timed_out');
        }
        sub = found;
      } else if (isDefinitiveRefusal(err)) {
        await this.expireAttempt(reservation.id);
        throw this.stripeFailure(err);
      } else {
        await this.markRetryable(reservation);
        throw this.stripeFailure(err);
      }
    }

    // Bind before anything else can fail. Only a row still pending binds: an
    // attempt retired meanwhile (terms changed) gives its subscription up.
    const piId = expandedId(
      sub.latest_invoice && typeof sub.latest_invoice === 'object'
        ? sub.latest_invoice.payment_intent
        : null,
    );
    let bound: ClientPurchase | null;
    try {
      const res = await this.prisma.clientPurchase.updateMany({
        where: { id: reservation.id, status: 'pending', entitlement_active: false },
        data: {
          stripe_checkout_session_id: sub.id,
          stripe_subscription_id: sub.id,
          stripe_payment_intent_id: piId,
          current_period_end:
            typeof sub.current_period_end === 'number'
              ? new Date(sub.current_period_end * 1000)
              : null,
        },
      });
      bound =
        res.count === 1
          ? await this.prisma.clientPurchase.findUnique({ where: { id: reservation.id } })
          : null;
    } catch (err) {
      // Stripe has the subscription; the pinned retry returns it again.
      this.logger.error(
        `subscription ${sub.id} could not be bound to purchase=${reservation.id}: ${(err as Error).message}`,
      );
      await this.markRetryable(reservation);
      throw this.inProgress(true);
    }
    if (!bound) {
      const again = await this.prisma.clientPurchase.findUnique({ where: { id: reservation.id } });
      if (again && (again.entitlement_active || again.trial_started_at))
        throw this.alreadyActive(again);
      if (again && again.stripe_subscription_id === sub.id) {
        bound = again;
      } else {
        if (this.subscriptionUnpaid(sub)) await this.cancelQuietly(sub.id);
        throw this.attemptExpired('terms_changed');
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
    const secret = this.sheetSecret(sub);
    if (secret) {
      let ephemeral: { secret: string };
      try {
        ephemeral = await this.stripe.createEphemeralKey(
          row.stripe_customer_id ?? '',
          `${ephemeralKeyBase}-ephkey`,
        );
      } catch (err) {
        throw this.stripeFailure(err);
      }
      const updated = await this.prisma.clientPurchase.update({
        where: { id: row.id },
        data: {
          stripe_client_secret: secret.client_secret,
          stripe_ephemeral_key: ephemeral.secret,
        },
      });
      return this.resultFromRow(updated, pkg, reusedFlag, sub.status);
    }
    const outcome = this.classifyWithoutSheet(sub);
    if (outcome === 'complete') {
      this.logger.log(
        `billing.subscription_needs_no_sheet purchase=${row.id} stripe_status=${sub.status}`,
      );
      return this.resultFromRow(row, pkg, reusedFlag, sub.status, 'none');
    }
    if (outcome === 'ended') {
      await this.expireAttempt(row.id);
      throw this.attemptExpired('timed_out');
    }
    this.logger.error(
      `subscription ${sub.id} has no payable PaymentIntent or SetupIntent and is not paid; canceling it`,
    );
    await this.cancelQuietly(sub.id);
    await this.expireAttempt(row.id);
    throw new ServiceUnavailableException({
      code: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
      error: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
      message:
        'The card screen could not be prepared for this plan. Nothing was charged. Try again in a minute.',
    });
  }

  /** B-654-6 — a subscription with no sheet secret: paid/processing, ended, or stuck. */
  private classifyWithoutSheet(
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
  private subscriptionUnpaid(sub: StripeSubscriptionCheckoutObject): boolean {
    if (sub.status !== 'incomplete' && sub.status !== 'trialing') return false;
    if (sub.status === 'trialing' && sub.default_payment_method) return false;
    const inv =
      sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
    const pi = inv && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
    return !(pi?.status === 'succeeded' || pi?.status === 'processing' || inv?.status === 'paid');
  }

  /**
   * B-654-5 / B-654-7 — a same-key retry. The key is bound to its attempt
   * and to the terms that attempt was started with:
   *   * still being created by another request: wait for it (bounded);
   *   * its create ended uncertainly (or its request died): resend the pinned
   *     request and finish it;
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
        if (!winner) throw this.inProgress(true);
        cur = winner;
        if (!cur.stripe_subscription_id && !ENDED_ATTEMPT_STATUSES.has(cur.status)) {
          const late = await this.claimUnbound(cur);
          if (!late) throw this.inProgress(false);
          cur = late;
          claimed = true;
        }
      }
    }
    if (cur.entitlement_active || cur.trial_started_at) throw this.alreadyActive(cur);
    if (ENDED_ATTEMPT_STATUSES.has(cur.status)) throw this.attemptExpired('timed_out');

    const terms = parseCheckoutTerms(cur.checkout_terms);
    if (terms && !termsStillOffered(terms, offered, pkgTrial)) {
      if ((await this.retireAttempt(cur)) === 'settled') throw this.alreadyActive(cur);
      throw this.attemptExpired('terms_changed');
    }
    if (claimed || !cur.stripe_subscription_id) return this.mintSubscription(cur, pkg, true);

    if (cur.stripe_client_secret) {
      // C-654-3 — the secret may be spent: the card was saved or the first
      // invoice paid a moment ago, before the webhook. Never hand it back.
      const state = await this.replaySecretState(cur);
      if (state === 'settled') throw this.alreadyActive(cur);
      if (state === 'dead') {
        await this.expireAttempt(cur.id);
        throw this.attemptExpired('timed_out');
      }
      return this.resultFromRow(cur, pkg, true);
    }
    let sub: StripeSubscriptionCheckoutObject;
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(cur.stripe_subscription_id);
    } catch (err) {
      throw this.stripeFailure(err);
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
      this.logger.error(`could not mark purchase=${row.id} for retry: ${(err as Error).message}`);
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
      const list = await this.stripe.listSubscriptionsForCustomer(row.stripe_customer_id);
      const hit = (list.data ?? []).find((s) => s.metadata?.tgp_purchase_id === row.id);
      if (!hit) return list.has_more ? 'unreadable' : null;
      return await this.stripe.retrieveSubscriptionForCheckout(hit.id);
    } catch (err) {
      this.logger.warn(
        `attempt subscription lookup failed purchase=${row.id}: ${(err as Error).message}`,
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
        throw this.stripeFailure(err);
      }
    } else if (parseCheckoutTerms(row.checkout_terms)) {
      const found = await this.findAttemptSubscription(row);
      if (found === 'unreadable') throw this.inProgress(true);
      sub = found;
    }
    if (sub && (await this.attemptSettled(row, sub))) return 'settled';
    if (sub && (sub.status === 'incomplete' || sub.status === 'trialing')) {
      await this.cancelQuietly(sub.id);
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
      if (sub.default_payment_method) return true;
      let setup: TrialSetupState | null;
      try {
        setup = await readTrialSetup(this.stripe, row.stripe_client_secret, sub);
      } catch (err) {
        throw this.stripeFailure(err);
      }
      if (trialCardSaved(setup)) {
        await this.attachTrialCardQuietly(sub.id, setup.payment_method, row.id);
        return true;
      }
      return setup?.status === 'processing';
    }
    return !this.subscriptionUnpaid(sub);
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
          if ((await this.retireAttempt(own)) === 'settled') throw this.alreadyActive(own);
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
        return this.resultFromRow(winner, pkg, true);
      }
      if (!winner.stripe_subscription_id) throw this.inProgress(false);
      cur = winner;
    }
    const subscriptionId = cur.stripe_subscription_id;
    if (!subscriptionId) throw this.inProgress(false);
    let sub: StripeSubscriptionCheckoutObject;
    try {
      sub = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
    } catch (err) {
      throw this.stripeFailure(err);
    }
    if (sub.status === 'active' || (sub.status === 'trialing' && !!sub.default_payment_method)) {
      // Paid (or card saved) a moment ago; the webhook will grant access.
      throw this.alreadyActive({ ...cur, status: sub.status });
    }
    // B-654-6 — a first payment already in flight or paid is never canceled.
    if (sub.status === 'incomplete' && !this.subscriptionUnpaid(sub)) {
      throw this.alreadyActive({ ...cur, status: sub.status });
    }
    if (sub.status === 'trialing') {
      // B-654-1 — the card may be saved although the subscription has no
      // default yet (pending_setup_intent is null after success). Such a
      // trial is never reused or retired: the card becomes the default and
      // the webhook grants the trial.
      let setup: TrialSetupState | null;
      try {
        setup = await readTrialSetup(this.stripe, cur.stripe_client_secret, sub);
      } catch (err) {
        throw this.stripeFailure(err);
      }
      if (trialCardSaved(setup)) {
        await this.attachTrialCardQuietly(sub.id, setup.payment_method, cur.id);
        throw this.alreadyActive({ ...cur, status: sub.status });
      }
      if (setup && setup.status === 'processing') {
        throw this.alreadyActive({ ...cur, status: sub.status });
      }
    }
    const secret = this.sheetSecret(sub);
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
        throw this.stripeFailure(err);
      }
      const row = await this.prisma.clientPurchase.update({
        where: { id: cur.id },
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
    await this.expireAttempt(cur.id);
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

  /**
   * The answer for one attempt. B-654-7: the plan terms are the attempt's
   * pinned terms (what its subscription actually charges), never today's
   * package terms; only an attempt without a pin (none exist after this
   * round's first write) falls back to the package.
   */
  private resultFromRow(
    row: ClientPurchase,
    pkg: CoachPackage,
    reused: boolean,
    stripeStatus?: string,
    sheet: 'auto' | 'none' = 'auto',
  ): SubscriptionIntentResult {
    const pinned: CheckoutTermsSnapshot | null = parseCheckoutTerms(row.checkout_terms);
    const price = pinned ? planPriceFromTerms(pinned) : planPriceFor(pkg, row.trial_days ?? 0);
    const trialDays = price.trial_days;
    const secret = sheet === 'none' ? '' : (row.stripe_client_secret ?? '');
    // A SetupIntent client secret starts with `seti_`; a PaymentIntent's with `pi_`.
    const mode: 'payment' | 'setup' | 'none' =
      sheet === 'none' ? 'none' : secret.startsWith('seti_') ? 'setup' : 'payment';
    return {
      mode,
      client_secret: secret,
      ephemeral_key: sheet === 'none' ? '' : (row.stripe_ephemeral_key ?? ''),
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
      checkout_state: null,
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
          stripe_subscription_id: { not: null },
          status: { in: [...OPEN_ATTEMPT_STATUSES] },
          idempotency_key: { startsWith: `sub-${clientId}-` },
          created_at: { lte: before },
        },
        orderBy: { created_at: 'desc' },
        take: STALE_TRIAL_RETIRE_LIMIT,
      });
      for (const row of stale) {
        if (!row.stripe_subscription_id) continue;
        try {
          const outcome = await this.retireOneStaleTrial(row, row.stripe_subscription_id);
          if (outcome === 'card_saved') cardSaved.push(row);
        } catch (err) {
          // One unreadable attempt never stops the others or the checkout.
          this.logger.warn(
            `stale trial attempt kept purchase=${row.id}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `stale trial attempt cleanup skipped client=${clientId}: ${(err as Error).message}`,
      );
    }
    return cardSaved;
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
    const sub = await this.stripe.retrieveSubscriptionForCheckout(subscriptionId);
    const ended = sub.status === 'canceled' || sub.status === 'incomplete_expired';
    if (!ended) {
      if (sub.status !== 'trialing') return 'kept';
      if (sub.default_payment_method) return 'card_saved';
      const setup = await readTrialSetup(this.stripe, row.stripe_client_secret, sub);
      if (trialCardSaved(setup)) {
        await attachTrialCard(this.stripe, sub.id, setup.payment_method);
        this.logger.log(`billing.trial_card_attached purchase=${row.id} via=retire`);
        return 'card_saved';
      }
      if (!setup || (setup.status !== 'requires_payment_method' && setup.status !== 'canceled')) {
        return 'kept';
      }
      await this.stripe.cancelSubscription(sub.id);
    }
    await this.prisma.clientPurchase.updateMany({
      where: { id: row.id, entitlement_active: false, trial_started_at: null },
      data: { status: 'expired', stripe_client_secret: null, stripe_ephemeral_key: null },
    });
    this.logger.log(`billing.trial_attempt_retired purchase=${row.id} stripe_status=${sub.status}`);
    return 'retired';
  }

  /**
   * C-654-3 — is a replayed attempt's stored sheet secret still usable?
   * 'settled': the card was saved / the first invoice paid or is processing
   * (the webhook grants access); 'dead': the intent was canceled or the
   * subscription ended; 'usable' otherwise, and on a Stripe read error (the
   * previous behaviour: hand back the stored secret).
   */
  private async replaySecretState(row: ClientPurchase): Promise<'usable' | 'settled' | 'dead'> {
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
        if (setup?.status === 'canceled') return 'dead';
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
      this.logger.warn(`replay secret check skipped purchase=${row.id}: ${(err as Error).message}`);
      return 'usable';
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
        `trial card attach deferred purchase=${purchaseId}: ${(err as Error).message}`,
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

  private alreadyIncluded(row: ClientPurchase): HttpException {
    const source = row.source ?? '';
    const includedBy: 'invite' | 'free_claim' | 'purchase' = source.startsWith('invite_grant')
      ? 'invite'
      : source === 'free_package_claim'
        ? 'free_claim'
        : 'purchase';
    return new ConflictException({
      code: 'PACKAGE_ALREADY_INCLUDED',
      error: 'PACKAGE_ALREADY_INCLUDED',
      message:
        includedBy === 'purchase'
          ? 'You already have this plan, so nothing was charged. Open Your plan to see it.'
          : 'This plan is already included for you through your coach, so there is nothing to pay. Open Your plan to see it.',
      purchase_id: row.id,
      included_by: includedBy,
      access_expires_at: iso(row.access_expires_at),
    });
  }

  private coachNotConnected(reason: 'no_coach' | 'other_coach'): HttpException {
    return new ConflictException({
      code: 'PACKAGE_COACH_NOT_CONNECTED',
      error: 'PACKAGE_COACH_NOT_CONNECTED',
      message:
        reason === 'no_coach'
          ? 'This plan is from a coach you are not connected with yet, so it cannot be started from this account. Nothing was charged. Ask that coach for their invite code, join with it, then open the link again.'
          : 'This plan is from a different coach than yours, so it cannot be started from this account. Nothing was charged. Message the coach who shared the link.',
      reason,
    });
  }

  private attemptExpired(reason: 'timed_out' | 'terms_changed'): HttpException {
    return new ConflictException({
      code: 'SUBSCRIPTION_ATTEMPT_EXPIRED',
      error: 'SUBSCRIPTION_ATTEMPT_EXPIRED',
      message:
        reason === 'terms_changed'
          ? 'The terms of this plan changed after this checkout started, so it was closed. Nothing was charged. Start again to see the current terms.'
          : 'This checkout timed out before it was paid. Nothing was charged. Start again to see the current price.',
      reason,
    });
  }

  private packageIsFree(): HttpException {
    return new BadRequestException({
      code: 'PACKAGE_IS_FREE',
      error: 'PACKAGE_IS_FREE',
      message: 'This plan is free. Claim it from the plan screen; no card is needed.',
    });
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
