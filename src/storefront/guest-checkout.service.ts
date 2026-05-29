import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CoachPackage,
  GuestCheckout,
  User,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  DestinationAccountMissingError,
  SupabaseCreateUserError,
  SupabaseExistingUserNotFoundError,
  SupabaseTimeoutError,
} from './errors/guest-conversion.error';
import { isConnectAccountReadyForCheckout } from './storefront.service';
import type { GuestCheckoutDto } from './storefront.dto';
import type { GuestCheckoutResult } from './storefront.types';
import { CheckoutIdempotencyService } from './checkout-idempotency.service';
import { ConnectPreflightService } from './connect-preflight.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { CheckoutService } from '../checkout/checkout.service';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { type GuestCheckoutStatus } from './guest-checkout-status';

// Platform cut on every guest checkout. Stripe's minimum application_fee
// is 50 cents — packages priced low enough that 2% falls below the floor
// get bumped up so Stripe accepts the charge.
//
// Audit #3 P2-5 — application_fee is also clamped to the charge amount
// so a sub-floor price can never produce a fee greater than the charge.
//
// Audit #4 P1-4 — the application_fee_amount we set on Stripe is what
// stays on the platform AFTER Stripe deducts its processing fee from
// the gross. To keep a true 2% margin we add a pass-through estimate
// of Stripe's own fee (2.9% + 30¢ for US card, the same numbers Stripe
// publishes in https://stripe.com/pricing) on top of the 2% slice.
// The destination connected account therefore receives:
//   gross  - (platform 2% + Stripe 2.9% + 30¢)
// which matches what the coach's UI quotes.
const PLATFORM_FEE_PERCENT = 0.02;
const PLATFORM_FEE_MIN_CENTS = 50;
const STRIPE_PASS_THROUGH_PERCENT = 0.029;
const STRIPE_PASS_THROUGH_FIXED_CENTS = 30;

// Audit #4 P1-5 — Stripe rejects PaymentIntent.amount < 50 cents in USD
// before we ever set foot in the API. Validate up front for a clean 400.
// The upper bound is a defence-in-depth cap to prevent a typo or a
// runaway script from minting a million-dollar checkout against a coach
// account that never asked for one. $50,000 covers every legitimate
// one-time package we have seen; exceptions can be raised on request.
const MIN_CHARGE_CENTS = 50;
const MAX_CHARGE_CENTS = 5_000_000;

// Audit #3 P2-6 — Phase 1 storefront accepts USD only. The platform-fee
// floor is denominated in US cents and zero-decimal currencies (JPY,
// KRW, …) would treat 50 as 50 yen, not 50¢. Per-currency floors are a
// Phase 2 follow-up; until then we reject non-USD checkouts up front
// with a deterministic error code the storefront can surface.
const SUPPORTED_CURRENCY = 'usd';

// PaymentIntents live indefinitely on Stripe's side, but the storefront's
// branded checkout session has a tighter contract: the link expires 24h
// after the first POST /checkout call. Older idempotency keys must be
// replaced rather than reused.
const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

// Audit #3 P2-3 — PII retention deadline applied to every new
// GuestCheckout row. 13 months follows the default GDPR-style retention
// window for transactional purchase records — long enough to handle
// disputes and reconciliation, short enough to limit identity data
// exposure on a public-checkout table. The daily scrub job
// (GuestCheckoutPiiScrubService) hashes guest_email and redacts
// guest_name on rows past this deadline that never converted.
const PII_RETENTION_MS = 13 * 30 * 24 * 60 * 60 * 1000;

// P1-4 — Supabase admin calls have no built-in timeout. Race them against a
// 10s deadline so a hung Supabase request cannot leave a paid checkout
// stuck in conversion forever.
const SUPABASE_ADMIN_TIMEOUT_MS = 10_000;

// P1-5 — Cap pagination of Supabase listUsers when recovering an existing
// account. 50 pages × 200 users = 10k users, well above any plausible TGP
// tenant; the total scan is also wrapped in an 8s deadline.
const SUPABASE_LIST_USERS_PAGE_SIZE = 200;
const SUPABASE_LIST_USERS_MAX_PAGES = 50;
const SUPABASE_LIST_USERS_TIMEOUT_MS = 8_000;

// Audit #3 P1-5 — Phase 1 cannot honour recurring billing. Stripe
// subscription lifecycle (renewal webhooks, dunning, cancellation) is not
// implemented for the guest path; selling a recurring package as a
// one-off PI would silently misbill. The check uses the canonical schema
// value `recurring` (CoachPackage.billing_type ∈ { 'one_time', 'recurring'
// }) — display labels like `monthly`/`quarterly`/`annual` live in the
// interval columns and must NEVER be load-bearing for this guard.
const CANONICAL_RECURRING_BILLING_TYPE = 'recurring';

// Audit #3 P1-6 — reconciliation retry cap. After 5 consecutive failures
// the row moves to `conversion_failed_terminal` and the operator
// dashboard pages on-call. The cap exists to bound how long a stuck row
// can churn through Supabase / DB before a human looks at it.
export const RECONCILIATION_MAX_ATTEMPTS = 5;

// Used by BillingService to detect a guest-checkout PaymentIntent without
// pulling GuestCheckoutService into its constructor. The same key is
// attached to every Stripe PaymentIntent we create in createIntent().
export const GUEST_CHECKOUT_METADATA_KEY = 'guest_checkout_idempotency_key';

// Helper — never leak provider error details to the client. Stripe / Resend /
// Supabase messages can include account IDs and partial keys.
function safeErrorTag(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; name?: string };
    if (typeof e.code === 'string' && e.code.length > 0) return e.code;
    if (typeof e.name === 'string' && e.name.length > 0) return e.name;
  }
  return 'unknown';
}

// P1-4 — bounded promise race so a hung Supabase admin call cannot stall
// the conversion path. Throws a tagged Error on timeout so the catch site
// flips the checkout to 'failed' instead of leaving it 'paid'.
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  tag: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SupabaseTimeoutError(tag));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

type CheckoutWithRelations = GuestCheckout & {
  package: CoachPackage & {
    coach: User;
  };
};

@Injectable()
export class GuestCheckoutService {
  private readonly logger = new Logger(GuestCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    // A276-P1-4 (refix) — NotificationsService is the system-wide
    // in-app + push notification gateway. We use it to surface refund
    // + dispute events to the coach who sold the package.
    //
    // HARD dependency: a missing notifier is a wiring bug, not a
    // graceful degradation. Under the previous @Optional() wiring a
    // misconfigured deploy (StorefrontModule not importing
    // NotificationsModule) would let refunds succeed, entitlements
    // flip, and the coach receive ZERO signal — with no log line
    // distinguishing "no notifier" from "notifier called fine". Audit
    // P1-4 called this the missing safety net. Failing module boot
    // surfaces the wiring bug immediately; tests that exercise this
    // service inject an explicit stub.
    //
    // Declared before the @Optional() params because TypeScript forbids
    // a required parameter after an optional one. Nest DI is type-based
    // so the parameter order has no effect at injection time.
    private readonly notifications: NotificationsService,
    // PR-14 R2 P2-1 — shared Stripe Product/Price helpers + FeePolicy
    // for the recurring/combo guest mint path. HARD dependencies (no
    // @Optional()) so a future module-wiring regression fails fast at
    // Nest boot — same pattern as the NotificationsService dependency
    // above (see lines 169-186 for the original rationale). Previously
    // these were @Optional() and the recurring path 503'd silently on
    // a misconfigured deploy; that observability gap is now closed at
    // boot.
    //
    // Declared before the @Optional() params for the same TypeScript
    // ordering reason. Test suites that hand-construct
    // GuestCheckoutService outside the Nest DI container MUST provide
    // explicit stubs (the PR-14 spec already does; the legacy
    // guest-checkout.service.spec.ts now provides minimal stubs as well
    // since the legacy tests do not exercise the recurring path).
    private readonly checkout: CheckoutService,
    private readonly feePolicy: FeePolicyService,
    // r48 #3 — content-addressable PI cache so a network-dropped
    // retry that rolled a fresh idempotency_key still reuses the
    // existing Stripe PaymentIntent.  @Optional() so legacy unit
    // tests that hand-construct this service via Test.createTestingModule
    // don't need to register a stub.
    @Optional()
    private readonly idempotencyCache?: CheckoutIdempotencyService,
    // r48 #7 + #8 — live Stripe Connect preflight (60s cache).  Same
    // optional wiring as above.
    @Optional()
    private readonly preflight?: ConnectPreflightService,
    // PR-4 — fan-out seam fired inside convertGuestToUser's $transaction
    // the moment ClientPurchase.entitlement_active flips true. @Optional()
    // for hand-constructed unit tests.
    @Optional()
    private readonly fanout?: PurchaseFanoutService,
  ) {}

  // POST /v1/packages/public/join/:token/checkout
  //
  // Idempotency contract:
  // 1. Resolve the token to a live package.
  // 2. Attempt a Prisma create with the client-supplied idempotency_key as
  //    a sentinel row (PI id is filled in later by an UPDATE). If a row
  //    with the same key already exists, P2002 fires — we read it back
  //    and return the existing PaymentIntent.
  // 3. Mint a Stripe PaymentIntent with our own Idempotency-Key header so
  //    Stripe-side retries also collapse.
  // 4. Update the sentinel row with the PaymentIntent id + client secret.
  //
  // This is the "create-first, catch P2002, re-read" pattern called out in
  // operator rule R19. The check-then-act alternative leaves a race where
  // two simultaneous calls both mint a Stripe PI.
  async createIntent(
    token: string,
    dto: GuestCheckoutDto,
    landingPageId?: string,
  ): Promise<GuestCheckoutResult> {
    const pkg = await this.prisma.coachPackage.findUnique({
      where: { share_token: token },
      include: {
        coach: { include: { connect_account: true } },
      },
    });

    if (
      !pkg ||
      !pkg.is_active ||
      pkg.archived_at !== null ||
      !pkg.share_link_enabled ||
      // PR-6 — DRAFT packages (published_at IS NULL) are not purchasable.
      !pkg.published_at
    ) {
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }
    const connectAccount = pkg.coach.connect_account;
    // Audit #3 P1-8 — gate on full readiness, not just charges_enabled.
    // Reuse the storefront predicate so the GET and POST surfaces can't
    // disagree about who can be sold.
    if (!connectAccount || !isConnectAccountReadyForCheckout(connectAccount)) {
      if (connectAccount) {
        this.logger.warn(
          `Checkout gate: connect account not ready (charges=${connectAccount.charges_enabled} payouts=${connectAccount.payouts_enabled} details=${connectAccount.details_submitted} disabled_reason=${connectAccount.disabled_reason ?? 'null'})`,
        );
      }
      throw new NotFoundException({
        error: 'PACKAGE_UNAVAILABLE',
        message: 'This coach is not currently accepting new clients.',
      });
    }

    // r48 #7 — live Stripe preflight (60s Redis cache).  The mirror
    // check above is the stable baseline; this catches a coach who
    // disconnected Stripe after the GET resolved but before the POST.
    // Cache lookups are O(1); cache miss is one Stripe API call per
    // 60s per connected account.
    let walletSupports: { apple: boolean; google: boolean } = {
      apple: false,
      google: false,
    };
    if (this.preflight) {
      const live = await this.preflight.getReadiness(
        connectAccount.stripe_account_id,
      );
      if (!live.charges_enabled) {
        this.logger.warn(
          `Checkout preflight: live charges disabled for ${connectAccount.stripe_account_id} (disabled_reason=${live.disabled_reason ?? 'null'})`,
        );
        throw new ServiceUnavailableException({
          error: 'COACH_PAYOUT_DISABLED',
          message:
            'This coach is not currently accepting payments. Please contact them directly.',
        });
      }
      walletSupports = {
        apple: live.supports_apple_pay,
        google: live.supports_google_pay,
      };
    }

    // PR-14 — master-plan §1 decision #1 puts recurring + one-time+recurring
    // combo packages back on the web/guest storefront. The OLD guard
    // refused ALL recurring + non-USD checkouts. We split the two
    // restrictions cleanly:
    //
    //   - Non-USD stays REJECTED. The platform-fee floor is denominated
    //     in US cents and zero-decimal currencies (JPY, KRW, …) would
    //     treat the 50¢ floor as 50 yen. Master-plan defers multi-currency
    //     to a later phase ("(phase) non-USD on storefront"); building a
    //     per-currency floor + FX path is out of scope for this PR.
    //   - Recurring (and one-time+recurring combo) are NOW SUPPORTED:
    //     we mint a Stripe Subscription (default_incomplete) and return
    //     the latest_invoice.payment_intent.client_secret so the guest
    //     confirms client-side just like the one-time PI flow. Combo
    //     packages add an invoice item for the one-off price on the
    //     first invoice so the guest is charged one + first period in
    //     a single confirmation.
    //
    // Canonical billing_type values: 'one_time' | 'recurring'. The
    // separate `recurring_amount_cents` etc. columns model the optional
    // companion price (PR-6 decision #1).
    if ((pkg.currency ?? '').toLowerCase() !== SUPPORTED_CURRENCY) {
      throw new UnprocessableEntityException({
        error: 'CURRENCY_NOT_SUPPORTED',
        message:
          'This package is priced in a currency we cannot yet accept on the storefront. Please contact your coach to join.',
      });
    }

    const hasRecurringComponent =
      pkg.billing_type === CANONICAL_RECURRING_BILLING_TYPE ||
      (pkg.recurring_amount_cents != null && pkg.recurring_interval != null);
    const isCombo =
      pkg.billing_type === 'one_time' &&
      pkg.recurring_amount_cents != null &&
      pkg.recurring_interval != null;

    // Audit #4 P1-5 — Stripe's hard floor for a USD PaymentIntent is 50¢;
    // anything below produces an opaque 400 from the Stripe SDK. Reject
    // up front with a typed error. Defence-in-depth ceiling rejects
    // runaway prices before we ever hit the network.
    if (pkg.amount_cents < MIN_CHARGE_CENTS) {
      throw new UnprocessableEntityException({
        error: 'AMOUNT_BELOW_MIN',
        message: `This package is priced below the storefront's $0.50 minimum charge.`,
      });
    }
    if (pkg.amount_cents > MAX_CHARGE_CENTS) {
      throw new UnprocessableEntityException({
        error: 'AMOUNT_ABOVE_MAX',
        message: `This package is priced above the storefront's maximum charge of $${MAX_CHARGE_CENTS / 100}.`,
      });
    }

    const normalisedEmail = dto.guest_email.toLowerCase().trim();
    const normalisedName = dto.guest_name.trim();

    // R47 / Audit #6 P0-5 — validate the optional landing_page_id query
    // param. We must defend against three classes of abuse:
    //   (a) a malformed string (cuid shape only),
    //   (b) a page owned by a DIFFERENT coach (cross-coach attribution
    //       theft — attacker pastes their own landing page id onto a
    //       competitor's storefront URL to steal credit), and
    //   (c) a page that does not list this package (visitor went to a
    //       page that doesn't sell this tier; refuse to credit it).
    // Any failure quietly clears the value to null; we never throw, so
    // the checkout still succeeds — we just don't record bogus
    // attribution. CUID shape is the same prefix Prisma uses elsewhere.
    let validatedLandingPageId: string | null = null;
    if (typeof landingPageId === 'string' && /^[a-z0-9]{20,40}$/i.test(landingPageId)) {
      const lp = await this.prisma.coachLandingPage.findFirst({
        where: { id: landingPageId, coach_id: pkg.coach.id, status: 'published' },
        select: { id: true, package_ids: true },
      });
      if (lp && Array.isArray(lp.package_ids) && lp.package_ids.includes(pkg.id)) {
        validatedLandingPageId = lp.id;
      } else {
        this.logger.warn(
          `Checkout: landing_page_id ${landingPageId} rejected (coach mismatch or page does not list package ${pkg.id}).`,
        );
      }
    }

    // r48 #3 — content-addressable idempotency check.  When the
    // storefront supplies a session_id, hash (token + email + session_id)
    // and look up a previously-minted PaymentIntent.  This rescues the
    // network-drop case where the client rolled a fresh idempotency_key
    // but is conceptually retrying the same checkout.
    const contentHash =
      this.idempotencyCache && dto.session_id
        ? this.idempotencyCache.computeHash(token, normalisedEmail, dto.session_id)
        : null;
    if (this.idempotencyCache && contentHash) {
      const cached = await this.idempotencyCache.lookupDecrypted(contentHash);
      if (cached) {
        // Cross-reference the DB row to make sure the cached PI hasn't
        // been moved to a terminal state by Stripe.  If the row no longer
        // exists or is no longer eligible for retry, fall through to the
        // normal path and let the DB+Stripe checks decide.
        const cachedRow = await this.prisma.guestCheckout.findUnique({
          where: { stripe_payment_intent_id: cached.payment_intent_id },
        });
        if (
          cachedRow &&
          (cachedRow.status === 'pending' || cachedRow.status === 'paid') &&
          cachedRow.expires_at > new Date()
        ) {
          return {
            client_secret: cached.client_secret,
            payment_intent_id: cached.payment_intent_id,
            guest_checkout_id: cachedRow.id,
            supports_apple_pay: walletSupports.apple,
            supports_google_pay: walletSupports.google,
          };
        }
      }
    }

    // Fast-path: existing row for the same idempotency_key. We do this
    // BEFORE minting a Stripe PI so honest retries from the storefront
    // (network blips, double-tap) never burn a Stripe API call.
    const existing = await this.prisma.guestCheckout.findUnique({
      where: { idempotency_key: dto.idempotency_key },
    });
    if (existing) {
      const replayed = await this.replayExistingIntent(
        existing,
        pkg.id,
        normalisedEmail,
      );
      if (replayed) return replayed;
      // P2-2 — the prior attempt left a `pending_<key>` sentinel and no
      // real PaymentIntent. Treat the sentinel as stale: delete it so
      // this retry can mint a fresh PaymentIntent against the same
      // idempotency_key.
      await this.prisma.guestCheckout
        .deleteMany({
          where: {
            id: existing.id,
            status: 'pending',
            stripe_payment_intent_id: { startsWith: 'pending_' },
          },
        })
        .catch((err) => {
          this.logger.error(
            `Failed to clear stale pending sentinel ${existing.id} (tag=${safeErrorTag(err)})`,
          );
        });
    }

    // Audit #4 P1-4 — application_fee_amount = our 2% slice + a
    // pass-through estimate of Stripe's own processing fee (2.9% + 30¢
    // for US cards). The pass-through is an estimate because Stripe's
    // actual fee depends on the card brand and may differ slightly for
    // international cards, AmEx, etc.; reconciliation against
    // BalanceTransaction.fee in the connect-webhook handler is where
    // the books are finally squared. Math.floor on the slice avoids a
    // fractional cent that could push application_fee_amount above the
    // gross. The full sum is clamped at the gross so a degenerate price
    // (e.g. $0.50, where 30¢ + 2.9% + 2% > 50¢) still satisfies
    // Stripe's invariant application_fee_amount <= amount.
    const platformSliceCents = Math.max(
      Math.floor(pkg.amount_cents * PLATFORM_FEE_PERCENT),
      PLATFORM_FEE_MIN_CENTS,
    );
    const stripePassThroughCents =
      Math.floor(pkg.amount_cents * STRIPE_PASS_THROUGH_PERCENT) +
      STRIPE_PASS_THROUGH_FIXED_CENTS;
    const platformFeeCents = Math.min(
      pkg.amount_cents,
      platformSliceCents + stripePassThroughCents,
    );

    // Create the GuestCheckout sentinel row FIRST so we own the
    // idempotency key. If two concurrent callers hit this branch with
    // the same key, the second loses on the @unique constraint and
    // falls back into the replay path below.
    let sentinel: GuestCheckout;
    try {
      sentinel = await this.prisma.guestCheckout.create({
        data: {
          package_id: pkg.id,
          // Placeholder PaymentIntent id — we'll patch it after Stripe
          // responds. The column is @unique so we synthesise a value
          // derived from the idempotency_key (also @unique) to dodge a
          // unique-constraint clash if two concurrent callers reach
          // this point with different keys.
          stripe_payment_intent_id: `pending_${dto.idempotency_key}`,
          stripe_customer_id: null,
          guest_email: normalisedEmail,
          guest_name: normalisedName,
          status: 'pending',
          idempotency_key: dto.idempotency_key,
          expires_at: new Date(Date.now() + CHECKOUT_TTL_MS),
          // Audit #3 P2-3 — PII retention deadline. Daily scrub job
          // hashes guest_email and redacts guest_name past this
          // deadline if the row never converted to a User.
          data_retention_at: new Date(Date.now() + PII_RETENTION_MS),
          // R47 / Audit #6 P0-5 — landing_page_id is the source page that
          // sent the visitor to checkout. Validated above against
          // CoachLandingPage.coach_id == pkg.coach_id AND the page's
          // package_ids list contains pkg.id; failed validation leaves
          // the column null so the analytics rollup ignores it (rather
          // than miscrediting the conversion to an arbitrary page).
          landing_page_id: validatedLandingPageId,
          // r48 #6 — package snapshot at PI create time so a coach
          // editing the package mid-checkout does not change what the
          // guest is billed.  The amount, currency, and platform fee
          // already capture in the Stripe PaymentIntent itself; the
          // snapshot is what the receipt + admin tools render against.
          package_snapshot: {
            name: pkg.name,
            price_cents: pkg.amount_cents,
            currency: pkg.currency,
            description: pkg.description ?? null,
            billing_type: pkg.billing_type,
            interval: pkg.interval ?? null,
            interval_count: pkg.interval_count ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Lost the race against another concurrent caller with the same
      // key. Re-read and replay.
      if (this.isUniqueViolation(err)) {
        const winner = await this.prisma.guestCheckout.findUnique({
          where: { idempotency_key: dto.idempotency_key },
        });
        if (winner) {
          const replayed = await this.replayExistingIntent(
            winner,
            pkg.id,
            normalisedEmail,
          );
          if (replayed) return replayed;
        }
        // Lost the race but the winner is itself a stale pending_ stub.
        // Surface 503 so the storefront retries — the next attempt will
        // either delete the stub or find a real PI on the winner row.
        throw new ServiceUnavailableException({
          error: 'STRIPE_UNAVAILABLE',
          message: 'Payment processing temporarily unavailable. Please try again.',
        });
      }
      throw err;
    }

    // PR-14 — branch on recurring vs one-time. Pure one-time keeps the
    // existing direct PaymentIntent path (no behaviour change). Recurring
    // and one-time+recurring combo mint a Stripe Subscription whose first
    // invoice's PaymentIntent the guest confirms client-side. Stripe
    // calls (and any helper that issues them) MUST stay outside any
    // Prisma $transaction — sentinel writes above already committed, the
    // mint below is plain async, and we patch the sentinel with the
    // Stripe ids OUTSIDE any tx (50-Failures #44 / A276-P1-3).
    let paymentIntent: { id: string; client_secret: string };
    let mintedSubscriptionId: string | null = null;
    let mintedCustomerId: string | null = null;
    try {
      if (hasRecurringComponent) {
        const minted = await this.mintRecurringForGuest({
          pkg,
          connectAccount,
          sentinelId: sentinel.id,
          idempotencyKey: dto.idempotency_key,
          guestEmail: normalisedEmail,
          guestName: normalisedName,
          isCombo,
        });
        paymentIntent = minted.paymentIntent;
        mintedSubscriptionId = minted.subscriptionId;
        mintedCustomerId = minted.customerId;
      } else {
        const created = await this.stripe.createPaymentIntent({
          amount: pkg.amount_cents,
          currency: pkg.currency,
          // Guest checkout never reuses cards — omit `customer` entirely
          // rather than passing an empty string (P2-3).
          applicationFeeAmount: platformFeeCents,
          transferDestination: connectAccount.stripe_account_id,
          // Audit #3 P1-10 — connected coach is the merchant of record
          // for the destination charge.
          onBehalfOf: connectAccount.stripe_account_id,
          // Audit #3 P2-4 — only non-PII correlation identifiers go in
          // Stripe metadata. guest_email / guest_name used to be sent
          // here so Stripe Dashboard could match charges to buyers, but
          // Stripe metadata is visible in dashboards, exports, and
          // downstream integrations. We keep the join in our own
          // database via guest_checkout_id instead.
          metadata: {
            [GUEST_CHECKOUT_METADATA_KEY]: dto.idempotency_key,
            package_id: pkg.id,
            guest_checkout_id: sentinel.id,
          },
          idempotencyKey: `guest-checkout-pi-${dto.idempotency_key}`,
        });
        paymentIntent = {
          id: created.id,
          client_secret: created.client_secret,
        };
      }
    } catch (err) {
      // Stripe rejected the PI / Subscription. Mark the sentinel as
      // failed so future requests with the same key don't re-attempt an
      // obviously-broken configuration (e.g. unsupported currency); the
      // storefront must generate a fresh key to retry.
      await this.prisma.guestCheckout.updateMany({
        where: { id: sentinel.id, status: 'pending' },
        data: { status: 'failed' },
      });
      if (err instanceof StripeConnectApiError) {
        this.logger.error(
          `Stripe createPaymentIntent failed (code=${
            err.stripeCode ?? 'unknown'
          } http=${err.httpStatus})`,
        );
        throw new ServiceUnavailableException({
          error: 'STRIPE_UNAVAILABLE',
          message:
            'Payment processing temporarily unavailable. Please try again.',
        });
      }
      // PR-14 — a missing CheckoutService / FeePolicyService dependency on
      // a recurring mint surfaces as a configuration error from
      // mintRecurringForGuest; map to 503 just like Stripe errors so the
      // storefront retries instead of leaking the trace.
      if (err instanceof ServiceUnavailableException) throw err;
      throw err;
    }

    // Patch the sentinel with the real PaymentIntent id (and subscription
    // / customer ids when minted). We tolerate a P2002 here in the case
    // where Stripe re-issues the same PI id via its own idempotency-key
    // dedup — unlikely but defended against.
    try {
      await this.prisma.guestCheckout.update({
        where: { id: sentinel.id },
        data: {
          stripe_payment_intent_id: paymentIntent.id,
          ...(mintedSubscriptionId
            ? { stripe_subscription_id: mintedSubscriptionId }
            : {}),
          ...(mintedCustomerId
            ? { stripe_customer_id: mintedCustomerId }
            : {}),
        },
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }

    // r48 #3 — record the (PI id, secret) in the content-addressable
    // cache so a future retry with the same (token, email, session_id)
    // gets the existing secret back instead of minting a new PI.  KMS
    // encrypts the secret at rest.  Best-effort: a cache write failure
    // does NOT roll back the checkout.
    if (this.idempotencyCache && contentHash) {
      this.idempotencyCache
        .checkOrStore(contentHash, paymentIntent.id, paymentIntent.client_secret)
        .catch((err) => {
          this.logger.warn(
            `idempotency cache store failed (tag=${safeErrorTag(err)})`,
          );
        });
    }

    return {
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      guest_checkout_id: sentinel.id,
      subscription_id: mintedSubscriptionId,
      supports_apple_pay: walletSupports.apple,
      supports_google_pay: walletSupports.google,
    };
  }

  // PR-14 — recurring (and one-time+recurring combo) Stripe mint path
  // for the guest storefront. Mirrors the in-app subscription contract:
  //
  //   1. ensure a Stripe Customer for the guest (no DB ConnectCustomer
  //      row — that's reserved for authenticated clients);
  //   2. resolve the recurring Stripe Price via the SHARED CheckoutService
  //      helper (master-plan #1 forbids duplicating price-creation logic);
  //   3. for combo, additionally resolve the one-time Stripe Price;
  //   4. mint a Subscription with payment_behavior=default_incomplete so
  //      the first invoice's PaymentIntent is created but unconfirmed —
  //      the guest confirms client-side exactly like the one-time flow;
  //   5. return the PI client_secret + subscription id + customer id so
  //      the caller can patch the sentinel and return them to the SSR
  //      storefront layer.
  //
  // Every Stripe call uses an idempotency_key derived from
  // dto.idempotency_key so a webhook-driven replay collapses to the same
  // Customer / Subscription / PaymentIntent. The convertGuestToUser
  // $transaction will later copy stripe_subscription_id from the
  // GuestCheckout row onto ClientPurchase; the existing
  // applySubscriptionUpdated / invoice.paid webhook handlers then claim
  // renewals and cancellations off stripe_subscription_id with no
  // divergent guest-only path.
  private async mintRecurringForGuest(args: {
    pkg: CoachPackage;
    connectAccount: { stripe_account_id: string };
    sentinelId: string;
    idempotencyKey: string;
    guestEmail: string;
    guestName: string;
    isCombo: boolean;
  }): Promise<{
    paymentIntent: { id: string; client_secret: string };
    subscriptionId: string;
    customerId: string;
  }> {
    // PR-14 R2 P2-1 — DI is now HARD; the defensive @Optional() runtime
    // guard that previously lived here is removed because a missing
    // CheckoutService / FeePolicyService now fails at module boot, not
    // silently inside a money path. See the constructor doc-comment.

    const { pkg, connectAccount, sentinelId, idempotencyKey, guestEmail, guestName, isCombo } = args;

    // 1. Customer. Stripe Customer is required for subscriptions; guest
    //    has no client_user_id so we don't write a ConnectCustomer row.
    const customer = await this.stripe.createCustomer({
      email: guestEmail,
      name: guestName,
      metadata: {
        tgp_guest_checkout_id: sentinelId,
        tgp_package_id: pkg.id,
        tgp_coach_user_id: pkg.coach_id,
      },
      idempotencyKey: `guest-customer-${idempotencyKey}`,
    });

    // 2. Recurring price. Combo packages put the recurring half in the
    //    companion fields; pure-recurring puts it in the primary fields.
    //    The shared helper handles BOTH lazily-mint and cache-hit paths.
    const recurringPriceId = isCombo
      ? await this.checkout.ensureRecurringPriceForPackage(pkg)
      : await this.checkout.ensurePriceForPackage(pkg);

    // 3. Combo: also resolve the one-time price as a first-invoice add-on.
    const oneTimePriceId = isCombo
      ? await this.checkout.ensurePriceForPackage(pkg)
      : undefined;

    // 4. Compute the platform fee percent. The percent is what Stripe
    //    applies to the WHOLE invoice — for combo first invoices that's
    //    `amount_cents + recurring_amount_cents`, not just the recurring
    //    half. PR-14 R2 P1-1 fix: size the percent against the first-
    //    invoice total so the platform/head-coach collect their
    //    contracted slice and the selling coach receives what they were
    //    quoted. Renewals are recurring-only invoices and use the same
    //    percent applied to the recurring-only basis — that math
    //    naturally collapses back to the per-leg contract because we
    //    derive the fee CENTS from a per-leg plan sum and re-express
    //    them as a percent of the *first-invoice* total.
    //
    //    Concretely:
    //      contractedFeeCents (first invoice) = plan(amount_cents).fee
    //                                         + plan(recurring_amount_cents).fee
    //      firstInvoiceCents               = amount_cents + recurring_amount_cents
    //      percent = ceil(contractedFeeCents / firstInvoiceCents)  (2dp)
    //
    //    On renewals Stripe applies that percent to the recurring-only
    //    invoice (recurring_amount_cents) — which over-collects by the
    //    one-time half's proportional contribution. To avoid that, when
    //    in combo we set the percent to the WEIGHTED basis but ALSO size
    //    the per-renewal expected fee against the recurring leg only.
    //    Solving for a single percent that satisfies both invoices is
    //    impossible (Stripe accepts only ONE application_fee_percent per
    //    subscription), so we accept the renewal under-/over-collection
    //    inside the contracted rate's tolerance — the platform recon
    //    sweeper squares the books per renewal via the SplitLedgerEntry
    //    + Transfer reconciliation that already runs in PR-2/PR-9.
    //
    //    Net behaviour: first-invoice fee is correct to the contracted
    //    rate (no shortfall to the selling coach); renewals are sized at
    //    the same percent and reconciled per-leg downstream — exactly
    //    the existing in-app behaviour for subscription packages.
    const recurringAmountCents = pkg.recurring_amount_cents ?? 0;
    const oneTimeAmountCents = isCombo ? pkg.amount_cents : 0;
    const firstInvoiceCents = isCombo
      ? oneTimeAmountCents + recurringAmountCents
      : pkg.amount_cents;

    // Per-leg fee plan sum. In one_time-only or recurring-only flows we
    // call planFor once on the relevant leg. In combo we call planFor
    // twice and sum the cents so the FeePolicy's bps math is applied to
    // each leg's amount independently (matches §4 FeePolicy contract).
    let combinedApplicationFeeCents: number;
    if (isCombo) {
      const recurringPlan = await this.feePolicy.planFor(
        pkg.coach_id,
        recurringAmountCents,
      );
      const oneTimePlan = await this.feePolicy.planFor(
        pkg.coach_id,
        oneTimeAmountCents,
      );
      combinedApplicationFeeCents =
        recurringPlan.application_fee_cents +
        recurringPlan.head_coach_split_cents +
        oneTimePlan.application_fee_cents +
        oneTimePlan.head_coach_split_cents;
    } else {
      const plan = await this.feePolicy.planFor(pkg.coach_id, pkg.amount_cents);
      combinedApplicationFeeCents =
        plan.application_fee_cents + plan.head_coach_split_cents;
    }
    const applicationFeePercent =
      combinedApplicationFeeCents > 0 && firstInvoiceCents > 0
        ? CheckoutService.toStripeApplicationFeePercent(
            combinedApplicationFeeCents,
            firstInvoiceCents,
          )
        : undefined;

    // 5. Mint subscription. payment_behavior=default_incomplete returns
    //    a latest_invoice.payment_intent with a client_secret the guest
    //    confirms client-side — same shape the storefront already drives
    //    for the one-time path. Idempotency-key derives from
    //    dto.idempotency_key so a Stripe webhook replay never double-mints.
    const subscription = await this.stripe.createSubscription({
      customer: customer.id,
      recurringPriceId,
      oneTimePriceId,
      transferDestination: connectAccount.stripe_account_id,
      onBehalfOf: connectAccount.stripe_account_id,
      applicationFeePercent,
      metadata: {
        [GUEST_CHECKOUT_METADATA_KEY]: idempotencyKey,
        tgp_package_id: pkg.id,
        tgp_coach_user_id: pkg.coach_id,
        tgp_guest_checkout_id: sentinelId,
        // tgp_client_user_id is filled in at convertGuestToUser time —
        // intentionally absent here.
      },
      idempotencyKey: `guest-subscription-${idempotencyKey}`,
    });

    // Extract the PaymentIntent client_secret from the expanded invoice.
    const inv = (subscription as { latest_invoice?: unknown }).latest_invoice;
    const expandedPi =
      inv && typeof inv === 'object'
        ? (inv as { payment_intent?: unknown }).payment_intent
        : null;
    if (
      !expandedPi ||
      typeof expandedPi !== 'object' ||
      typeof (expandedPi as { client_secret?: unknown }).client_secret !==
        'string' ||
      typeof (expandedPi as { id?: unknown }).id !== 'string'
    ) {
      this.logger.error(
        `mintRecurringForGuest: subscription ${subscription.id} returned without expanded payment_intent — refusing to surface broken client_secret`,
      );
      throw new ServiceUnavailableException({
        error: 'STRIPE_UNAVAILABLE',
        message:
          'Payment processing temporarily unavailable. Please try again.',
      });
    }
    const piId = (expandedPi as { id: string }).id;
    const clientSecret = (expandedPi as { client_secret: string }).client_secret;

    // PR-14 R2 P1-2 / P1-4 — patch the sentinel row with the Stripe ids
    // RIGHT NOW, BEFORE returning to createIntent. The outer caller also
    // patches the sentinel (line ~636), but a process crash between
    // here and that outer patch leaves the sentinel stuck on the
    // synthetic `pending_<key>` PI placeholder, which would prevent the
    // lost-webhook reconciler and the P0-1 PI-id fallback from finding
    // the row. We tolerate a P2002 here in the case where Stripe re-issues
    // the same PI id via its own idempotency-key dedup and an earlier
    // attempt already populated the row — same defensive pattern the
    // outer patch uses. The outer patch is now a no-op on the recurring
    // path (the same data is already persisted), so it stays idempotent.
    try {
      await this.prisma.guestCheckout.update({
        where: { id: sentinelId },
        data: {
          stripe_payment_intent_id: piId,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: customer.id,
        },
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) {
        this.logger.warn(
          `mintRecurringForGuest: sentinel patch failed for ${sentinelId} (will retry via outer patch / reconciler): ${(err as Error).message}`,
        );
      }
    }

    return {
      paymentIntent: { id: piId, client_secret: clientSecret },
      subscriptionId: subscription.id,
      customerId: customer.id,
    };
  }

  // Replay path: a GuestCheckout row already exists for this key. We
  // re-fetch the live client secret from Stripe rather than caching it
  // (PaymentIntent secrets can be invalidated by Stripe-side state).
  //
  // Returns null when the row is a stale `pending_<key>` sentinel that
  // the caller should reset (P2-2). Throws for terminal failures.
  private async replayExistingIntent(
    existing: GuestCheckout,
    expectedPackageId: string,
    normalisedEmail: string,
  ): Promise<GuestCheckoutResult | null> {
    if (existing.package_id !== expectedPackageId) {
      // Same key, different package — caller programming error.
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }
    if (existing.guest_email.toLowerCase() !== normalisedEmail) {
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }
    if (
      existing.status === 'failed' ||
      existing.status === 'converted' ||
      existing.status === 'conversion_failed_terminal'
    ) {
      // Spent key — storefront must roll a new UUID. `paid` and
      // `conversion_failed_retryable` are intentionally NOT spent: the
      // reconciliation worker still owns those rows. Returning a fresh
      // client secret for a paid row would create a second charge.
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This checkout link has expired. Please request a new one.',
      });
    }
    if (existing.expires_at < new Date()) {
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This checkout link has expired. Please request a new one.',
      });
    }
    // P2-2 — a `pending_<key>` placeholder means the prior request
    // crashed between sentinel insert and the Stripe call. Return null
    // so the caller can delete the stale row and mint a fresh PI rather
    // than 503-looping the key forever.
    if (existing.stripe_payment_intent_id.startsWith('pending_')) {
      return null;
    }
    try {
      const pi = await this.stripe.retrievePaymentIntent(
        existing.stripe_payment_intent_id,
      );
      const clientSecret = (pi as { client_secret?: string }).client_secret;
      if (!clientSecret) {
        throw new ServiceUnavailableException({
          error: 'STRIPE_UNAVAILABLE',
          message: 'Payment processing temporarily unavailable.',
        });
      }
      return {
        client_secret: clientSecret,
        payment_intent_id: existing.stripe_payment_intent_id,
        guest_checkout_id: existing.id,
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(
        `Failed to retrieve PaymentIntent during idempotent replay (tag=${safeErrorTag(err)})`,
      );
      throw new ServiceUnavailableException({
        error: 'STRIPE_UNAVAILABLE',
        message: 'Payment processing temporarily unavailable. Please try again.',
      });
    }
  }

  // ── Stripe webhook entry points ─────────────────────────────────────────
  //
  // Both handlers are called from BillingService.handleEvent (which is
  // itself called from StripeWebhookController). They MUST NOT throw —
  // every error is caught, logged, and silenced so the webhook returns
  // 200 to Stripe. Stripe retries non-2xx responses, and a duplicate
  // delivery against a converted row would attempt to create a second
  // Supabase user.

  // A276-P0-2 — chargeInfo carries the Stripe-hosted receipt URL (or the
  // charge id we'd retrieve to look it up). Both are optional so legacy
  // callers without the upgraded billing dispatcher still work; the
  // receipt simply ends up null and gets filled in by a later replay or
  // operator-driven backfill.
  //
  // A276-F2-P2-1 — `preResolveAttempted` is set by BillingService when it
  // already ran the outside-tx receipt lookup (success OR failure). When
  // true and `receiptUrl` is null, the inner resolveReceiptUrl MUST NOT
  // attempt another Stripe HTTP call (otherwise we re-introduce the
  // in-transaction HTTP anti-pattern P1-3 was supposed to eliminate, on
  // the Stripe-blip degraded path). The welcome email simply ships
  // without the receipt line and an outbox/backfill job can fill it in
  // later.
  async handlePaymentSucceeded(
    paymentIntentId: string,
    chargeInfo?: {
      chargeId: string | null;
      receiptUrl: string | null;
      preResolveAttempted?: boolean;
    },
  ): Promise<void> {
    try {
      // Atomic pending→paid transition. updateMany with WHERE status =
      // 'pending' is the canonical "claim once" pattern: if count = 0,
      // either we never owned this PI or another handler already moved
      // it forward, and we return silently.
      //
      // P2-4 — refuse to fulfill rows whose checkout link has already
      // expired. A buyer who retained a stale client secret cannot push
      // a paid status past expires_at.
      const claim = await this.prisma.guestCheckout.updateMany({
        where: {
          stripe_payment_intent_id: paymentIntentId,
          status: 'pending',
          expires_at: { gt: new Date() },
        },
        data: { status: 'paid' },
      });
      if (claim.count === 0) {
        this.logger.log(
          `handlePaymentSucceeded: no pending row for ${paymentIntentId} — duplicate, expired, or unrelated`,
        );
        return;
      }

      const checkout = await this.prisma.guestCheckout.findUnique({
        where: { stripe_payment_intent_id: paymentIntentId },
        include: { package: { include: { coach: true } } },
      });
      if (!checkout) {
        this.logger.error(
          `handlePaymentSucceeded: row vanished after claim for ${paymentIntentId}`,
        );
        return;
      }

      // A276-P0-2 — resolve the Stripe-hosted receipt_url and persist it
      // on the GuestCheckout row BEFORE convertGuestToUser, so the
      // welcome-email path (which reads the row) ships the receipt link
      // in the same outgoing email. resolveReceiptUrl is best-effort:
      // failures (Stripe blip, missing charge id) leave receipt_url null
      // and the welcome email omits the "View receipt" line.
      const receiptUrl = await this.resolveReceiptUrl(
        paymentIntentId,
        chargeInfo,
      );
      if (receiptUrl) {
        await this.prisma.guestCheckout
          .updateMany({
            where: {
              stripe_payment_intent_id: paymentIntentId,
              receipt_url: null,
            },
            data: { receipt_url: receiptUrl },
          })
          .catch((err) => {
            // Receipt URL persistence is non-critical — log and continue
            // so a DB blip here never blocks the conversion path.
            this.logger.warn(
              `receipt_url persist failed for ${paymentIntentId} (tag=${safeErrorTag(err)})`,
            );
          });
      }

      // P1-4 — Guest conversion runs INLINE, before the webhook returns.
      // The previous setImmediate path acknowledged Stripe before account
      // creation finished; if the process exited (Fly redeploy, OOM, hard
      // crash) the entitlement was lost and Stripe wouldn't retry because
      // BillingService had already inserted the event into
      // StripeProcessedEvent. Running inline means a failure leaves the
      // event un-acknowledged and Stripe will retry the delivery.
      //
      // Any unrecoverable error inside convertGuestToUser flips the row
      // to 'failed' so the reconciliation job has a clear signal.
      const checkoutWithReceipt = receiptUrl
        ? { ...checkout, receipt_url: receiptUrl }
        : checkout;
      await this.convertGuestToUser(checkoutWithReceipt);
    } catch (err) {
      // Webhook MUST return 200 — log + swallow.
      this.logger.error(
        `handlePaymentSucceeded crashed (tag=${safeErrorTag(err)})`,
      );
    }
  }

  // A276-P0-2 — Stripe Connect destination charges generate a hosted,
  // signed, branded receipt URL on every Charge (pay.stripe.com/receipts/…).
  // We prefer the URL handed in from the webhook payload (no extra Stripe
  // round-trip); fall back to retrieving the Charge by id when the event
  // only carried a charge id; final fallback is to retrieve the
  // PaymentIntent and chase its latest_charge. Returns null when none of
  // those paths produced a usable https URL.
  //
  // A276-P1-3 — made public so BillingService can pre-resolve the URL
  // BEFORE opening its outer $transaction. Stripe API 2024-09-30.acacia
  // event payloads carry latest_charge only as a string id, which means
  // this method always falls through to a synchronous retrieveCharge HTTP
  // call. Running that call inside a Prisma interactive transaction
  // holds the Postgres connection for the full Stripe round-trip and
  // saturates the pool under any Stripe latency — the canonical Prisma
  // anti-pattern. BillingService now invokes this OUTSIDE its tx and
  // hands the result back via the chargeInfo argument so the inner call
  // (still made from handlePaymentSucceeded) short-circuits on the https
  // guard at the top of the method.
  //
  // A276-F2-P2-1 — when `preResolveAttempted` is true, BillingService
  // already issued the Stripe HTTP lookup OUTSIDE the transaction; the
  // result (success or null on Stripe blip) is final. We MUST NOT retry
  // a second Stripe HTTP call here, because this method is invoked from
  // handlePaymentSucceeded WHICH RUNS INSIDE BillingService's outer
  // `$transaction` await — holding the Postgres connection across a
  // Stripe round-trip is exactly the anti-pattern P1-3 was supposed to
  // eliminate. On the degraded path (Stripe blip during pre-resolve),
  // the receipt URL stays null, the welcome email omits the receipt
  // line, and a future reconciliation/backfill job can fill it in.
  async resolveReceiptUrl(
    paymentIntentId: string,
    chargeInfo?: {
      chargeId: string | null;
      receiptUrl: string | null;
      preResolveAttempted?: boolean;
    },
  ): Promise<string | null> {
    const fromEvent = chargeInfo?.receiptUrl;
    if (typeof fromEvent === 'string' && /^https:\/\//.test(fromEvent)) {
      return fromEvent;
    }
    // A276-F2-P2-1 — pre-resolve was attempted outside-tx. Honour the
    // null result; do not retry HTTP from inside the outer transaction.
    if (chargeInfo?.preResolveAttempted === true) {
      return null;
    }
    let chargeId = chargeInfo?.chargeId ?? null;
    try {
      if (!chargeId) {
        const pi = await this.stripe.retrievePaymentIntent(paymentIntentId);
        if (!pi || typeof pi !== 'object') return null;
        const lc = (pi as { latest_charge?: string | null }).latest_charge;
        if (typeof lc === 'string' && lc.length > 0) chargeId = lc;
        else if (
          pi.charges?.data &&
          pi.charges.data.length > 0 &&
          typeof pi.charges.data[0].id === 'string'
        ) {
          chargeId = pi.charges.data[0].id as string;
        }
      }
      if (!chargeId) return null;
      const charge = await this.stripe.retrieveCharge(chargeId);
      const url = (charge as { receipt_url?: string | null }).receipt_url;
      if (typeof url === 'string' && /^https:\/\//.test(url)) {
        return url;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `resolveReceiptUrl: Stripe lookup failed for pi=${paymentIntentId} (tag=${safeErrorTag(err)})`,
      );
      return null;
    }
  }

  async handlePaymentFailed(paymentIntentId: string): Promise<void> {
    try {
      await this.prisma.guestCheckout.updateMany({
        where: {
          stripe_payment_intent_id: paymentIntentId,
          status: 'pending',
        },
        data: { status: 'failed' },
      });
    } catch (err) {
      this.logger.error(
        `handlePaymentFailed crashed (tag=${safeErrorTag(err)})`,
      );
    }
  }

  // r48 #13 + A276-P1-4 — refund handler.
  //
  // Called by BillingService on charge.refunded webhooks AFTER the
  // existing CheckoutWebhookHandlerService has refused the event (no
  // matching ClientPurchase via stripe_checkout_session_id).  We claim
  // the event when the PaymentIntent maps either to a GuestCheckout row
  // (legacy path) or to a ClientPurchase row whose entitlement we own
  // (the storefront writes both for guest checkouts).
  //
  // Audit #5 P1-4 — a full refund MUST revoke the client's entitlement
  // and notify the coach.  The previous implementation only stamped
  // refunded_at on GuestCheckout, leaving the client with continued app
  // access and giving the coach no signal that money came back.
  //
  // All writes run inside a single $transaction so partial state is
  // never visible to a concurrent reader.  Idempotent: re-deliveries
  // collapse via the WHERE refunded_at IS NULL guard on GuestCheckout
  // and entitlement_active=true guard on ClientPurchase.
  //
  // Partial refunds DO NOT revoke entitlement — the client paid for
  // something and Stripe's amount_refunded < amount means the coach is
  // crediting back a portion, not unwinding the sale.  We still stamp
  // refunded_at and notify the coach so they have a paper trail.
  async handleChargeRefunded(
    paymentIntentId: string,
    chargeAmount: number,
    amountRefunded: number,
  ): Promise<{ claimed: boolean }> {
    try {
      const row = await this.prisma.guestCheckout.findUnique({
        where: { stripe_payment_intent_id: paymentIntentId },
        include: { package: { select: { coach_id: true } } },
      });
      // chargeAmount > 0 guards the $0-auth-capture edge case (the
      // storefront does not use $0 auths today; the guard is
      // defence-in-depth so a degenerate event payload can't claim
      // a full refund of nothing).
      const fullyRefunded = chargeAmount > 0 && amountRefunded >= chargeAmount;
      // A276 P0-1: 'refunded' is admitted by GuestCheckout_status_check
      // as of migration 20260921000000_add_refunded_disputed_to_guest_checkout_status.
      // Partial refunds keep the existing row.status (typically 'paid' or
      // 'converted'); only a fully-refunded charge transitions to 'refunded'.
      // P2-4 cleanup: when row is null we never read newStatus (the
      // updateMany is gated by `if (row)` below), so the previous
      // `?? 'refunded'` tail was unreachable; we coerce undefined to a
      // safe placeholder and rely on the gate.
      const newStatus: GuestCheckoutStatus = fullyRefunded
        ? 'refunded'
        : ((row?.status ?? 'paid') as GuestCheckoutStatus);

      // A276-P1-4 — even when there's no GuestCheckout row, an authed
      // ClientPurchase may exist (post-converted guest, or future direct-
      // checkout flows that route through this handler).  Both writes
      // share a single $transaction so a partial failure rolls back.
      //
      // A276-P1-2 — Stripe's charge.refunded delivers CUMULATIVE
      // amount_refunded. A partial-then-full sequence is two distinct
      // events; the first stamps refunded_at, the second sees fully
      // refunded but the original WHERE refunded_at:null guard would skip
      // the GuestCheckout row, leaving status='paid' even though
      // ClientPurchase has flipped to 'refunded' (P1-2 desync). To keep
      // the two tables in lockstep we emit a second updateMany for the
      // partial→full upgrade path: WHERE refunded_at IS NOT NULL AND
      // status != 'refunded'. Both updateMany calls are guarded so a pure
      // re-delivery (no state change) claims nothing in either branch.
      const result = await this.prisma.$transaction(async (tx) => {
        let guestClaimed = 0;
        if (row) {
          const firstClaim = await tx.guestCheckout.updateMany({
            where: {
              stripe_payment_intent_id: paymentIntentId,
              refunded_at: null,
            },
            data: {
              status: newStatus,
              refunded_at: new Date(),
            },
          });
          guestClaimed = firstClaim.count;

          // Partial→full upgrade. Only runs on the delivery that closes
          // out a charge that was previously partially refunded: status
          // is still 'paid'/'converted' but refunded_at is already set.
          // The status != 'refunded' guard keeps the write idempotent —
          // a third re-delivery on an already-fully-refunded row claims
          // zero. We deliberately do NOT re-stamp refunded_at (the audit
          // trail keeps the original first-refund timestamp).
          if (fullyRefunded && firstClaim.count === 0) {
            const upgrade = await tx.guestCheckout.updateMany({
              where: {
                stripe_payment_intent_id: paymentIntentId,
                status: { not: 'refunded' },
              },
              data: {
                status: 'refunded',
              },
            });
            guestClaimed = upgrade.count;
          }
        }

        // Revoke entitlement on the matching ClientPurchase row(s) when
        // the refund is full.  A partial refund leaves entitlement_active
        // alone so the client keeps the access they paid net-of-credit
        // for.  status:'refunded' is reserved for full refunds; partial
        // refunds keep the existing status (paid/active) untouched.
        let purchaseClaimed = 0;
        if (fullyRefunded) {
          const cp = await tx.clientPurchase.updateMany({
            where: {
              stripe_payment_intent_id: paymentIntentId,
              entitlement_active: true,
            },
            data: {
              entitlement_active: false,
              status: 'refunded',
            },
          });
          purchaseClaimed = cp.count;
        }
        return { guestClaimed, purchaseClaimed };
      });

      // Notify the coach.  Best-effort — a notification failure must
      // not roll the refund write back (the money already moved on
      // Stripe's side; we MUST persist the refunded_at stamp).
      // Only fire when this delivery actually claimed something so
      // duplicate webhook re-deliveries don't double-notify.
      const coachUserId = row?.package?.coach_id ?? null;
      const claimedSomething =
        result.guestClaimed > 0 || result.purchaseClaimed > 0;
      if (claimedSomething && coachUserId) {
        const dollars = (amountRefunded / 100).toFixed(2);
        const body = fullyRefunded
          ? `Refund processed: $${dollars} returned to client.`
          : `Partial refund: $${dollars} returned to client.`;
        await this.notifications
          .createNotification({
            user_id: coachUserId,
            kind: NotificationKind.COACH_ALERT,
            body,
            payload: {
              event: 'refund_processed',
              payment_intent_id: paymentIntentId,
              amount_refunded_cents: amountRefunded,
              amount_cents: chargeAmount,
              fully_refunded: fullyRefunded,
              entitlement_revoked: fullyRefunded,
            },
            deep_link: 'tgp://coach/billing/refunds',
            channel: 'inapp',
          })
          .catch((err) => {
            this.logger.warn(
              `coach refund notification failed pi=${paymentIntentId} (tag=${safeErrorTag(err)})`,
            );
          });
      }

      if (!row && result.purchaseClaimed === 0) {
        // Neither table held this PI — not our event.
        return { claimed: false };
      }
      this.logger.log(
        `guest checkout refunded: pi=${paymentIntentId} amount_refunded=${amountRefunded}/${chargeAmount} (full=${fullyRefunded}, entitlement_revoked=${result.purchaseClaimed})`,
      );
      return { claimed: true };
    } catch (err) {
      // A276-P1-5 — PROPAGATE.  BillingService.handleEvent wraps the
      // webhook dispatch in a Prisma \$transaction whose final write is
      // tx.stripeProcessedEvent.updateMany(handler_completed_at).  If we
      // swallow here, that dedup row commits with no side-effect having
      // run, Stripe ack's the delivery, and the refund row stays stuck
      // in status:'paid' forever — the money came back but the buyer
      // keeps app access.  Re-throwing rolls back the outer transaction
      // (the StripeProcessedEvent insert AND the handler_completed_at
      // stamp), Stripe sees a 5xx, and retries on its exponential backoff
      // schedule (up to 3 days).
      this.logger.error(
        `handleChargeRefunded crashed (tag=${safeErrorTag(err)}) — propagating for Stripe retry`,
      );
      throw err;
    }
  }

  // r48 #13 + A276-P1-4 — dispute opened handler.
  //
  // A dispute is NOT a refund — Stripe has only flagged the charge for
  // chargeback review.  We MUST NOT revoke entitlement here: a dispute
  // can be won, in which case the client keeps the package they paid
  // for.  The coach IS notified at high priority so they can submit
  // evidence inside Stripe's 7-day window.  Entitlement revocation
  // happens later if/when charge.refunded fires (Stripe issues an
  // automatic refund on a lost dispute).
  async handleDisputeOpened(
    paymentIntentId: string,
    reason: string | null,
  ): Promise<{ claimed: boolean }> {
    try {
      const safeReason = (reason ?? '').slice(0, 500) || null;

      const result = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.guestCheckout.updateMany({
          where: {
            stripe_payment_intent_id: paymentIntentId,
            disputed_at: null,
          },
          data: {
            status: 'disputed',
            disputed_at: new Date(),
            dispute_reason: safeReason,
          },
        });
        return { guestClaimed: claim.count };
      });

      // Look up the row for routing (coach_id) regardless of whether the
      // updateMany flipped a fresh row — a re-delivery still needs to be
      // declared claimed.
      const row = await this.prisma.guestCheckout.findUnique({
        where: { stripe_payment_intent_id: paymentIntentId },
        include: { package: { select: { coach_id: true } } },
      });
      if (!row) return { claimed: false };

      // Notify the coach (best-effort).  Only on the delivery that
      // actually flipped the row so re-deliveries don't double-notify.
      const coachUserId = row.package?.coach_id ?? null;
      if (result.guestClaimed > 0 && coachUserId) {
        await this.notifications
          .createNotification({
            user_id: coachUserId,
            kind: NotificationKind.COACH_ALERT,
            body: `Chargeback opened on a guest checkout. Submit evidence in Stripe within 7 days.`,
            payload: {
              event: 'dispute_opened',
              payment_intent_id: paymentIntentId,
              reason: safeReason,
            },
            deep_link: 'tgp://coach/billing/disputes',
            channel: 'inapp',
          })
          .catch((err) => {
            this.logger.warn(
              `coach dispute notification failed pi=${paymentIntentId} (tag=${safeErrorTag(err)})`,
            );
          });
      }

      this.logger.warn(
        `guest checkout disputed: pi=${paymentIntentId} reason=${reason ?? 'none'}`,
      );
      return { claimed: true };
    } catch (err) {
      // A276-P1-5 — PROPAGATE.  Same reasoning as handleChargeRefunded:
      // swallowing leaves StripeProcessedEvent committed with no row
      // update, and Stripe will never re-deliver the dispute notice.
      // For chargebacks specifically, missing the 7-day evidence window
      // because of a transient DB error is a direct money loss.
      this.logger.error(
        `handleDisputeOpened crashed (tag=${safeErrorTag(err)}) — propagating for Stripe retry`,
      );
      throw err;
    }
  }

  // ── Account creation flow ──────────────────────────────────────────────
  // Runs INLINE in the webhook (P1-4) so the conversion is durable. A
  // re-entry for a row already in 'converted' state is a no-op; any
  // unrecoverable error flips the row to 'failed' and surfaces in logs.

  private async convertGuestToUser(
    checkout: CheckoutWithRelations,
  ): Promise<void> {
    // Re-read the row inside the async path — a second webhook
    // delivery may have landed in the meantime.
    const fresh = await this.prisma.guestCheckout.findUnique({
      where: { id: checkout.id },
    });
    if (!fresh || fresh.status !== 'paid') {
      this.logger.log(
        `convertGuestToUser: ${checkout.id} not in paid state (current=${fresh?.status ?? 'missing'})`,
      );
      return;
    }

    let supabaseUserId: string;
    let inviteLink: string | null = null;
    try {
      const result = await this.ensureSupabaseUser(
        checkout.guest_email,
        checkout.guest_name,
        checkout.id,
      );
      supabaseUserId = result.supabaseUserId;
      inviteLink = result.inviteLink;
    } catch (err) {
      // Audit #3 P1-6 — Supabase failures are transient by default
      // (network blip, rate limit, capacity issue). Flip to
      // conversion_failed_retryable so the reconciliation worker picks
      // it up; never go to terminal `failed` from a paid state. The
      // safeErrorTag is short and PII-free.
      this.logger.error(
        `convertGuestToUser: Supabase user creation failed for ${checkout.id} (tag=${safeErrorTag(err)})`,
      );
      await this.markRetryable(checkout.id, `supabase:${safeErrorTag(err)}`);
      return;
    }

    // P2-5 — preserve the destination Connect account on ClientPurchase
    // so revenue reconciliation can join guest rows against the same
    // stripe_destination_account field the in-app flow already writes.
    //
    // Audit #4 P2-8 — a DB lookup failure here is transient (network
    // blip, connection pool exhaustion). Do NOT silently persist the
    // ClientPurchase with stripe_destination_account = null, which
    // would corrupt revenue reconciliation. Instead, flip the checkout
    // to conversion_failed_retryable so the reconciliation worker
    // retries the whole convert path; the next attempt will find the
    // Connect account row and write the correct destination.
    // Audit #5 P1-6 — resolveDestinationAccount now ALWAYS throws when
    // the destination is missing (both on a Prisma error AND on a
    // legitimately-absent ConnectAccount row). The catch routes either
    // failure mode into conversion_failed_retryable; the resolved value
    // is a non-empty stripe_account_id string when it succeeds.
    let destinationAccount: string;
    try {
      destinationAccount = await this.resolveDestinationAccount(
        checkout.package.coach_id,
      );
    } catch (err) {
      this.logger.error(
        `convertGuestToUser: destination account lookup failed for ${checkout.id} (tag=${safeErrorTag(err)})`,
      );
      await this.markRetryable(
        checkout.id,
        `dest_account:${safeErrorTag(err)}`,
      );
      return;
    }

    // PR-14 R2 P2-3 — for recurring guests, read the live subscription
    // status from Stripe BEFORE the $transaction opens (no sync Stripe
    // HTTP in-tx, 50-Failures #44 / A276-P1-3). The previous PR hard-
    // coded ClientPurchase.status='active' on the recurring branch; that
    // was load-bearing on `payment_intent.succeeded` running BEFORE we
    // ever wrote the row. After the P0-1 fix the conversion now runs
    // either on PI succeeded (subscription is `active` by then) or as a
    // backstop from the subscription/invoice events (status may still be
    // `incomplete`). Reading live here keeps the snapshot honest in
    // both flows. Best-effort: a Stripe lookup failure falls back to a
    // conservative `incomplete` snapshot, the existing
    // applySubscriptionUpdated webhook handler will refine it on first
    // delivery (it now finds the row directly via
    // ClientPurchase.stripe_subscription_id), and entitlement still
    // flips to true so the buyer is not gated out on a transient blip.
    let liveSubscriptionStatus: string | null = null;
    if (checkout.stripe_subscription_id) {
      try {
        const sub = await this.stripe.retrieveSubscription(
          checkout.stripe_subscription_id,
        );
        const raw = (sub as { status?: string }).status;
        if (typeof raw === 'string') liveSubscriptionStatus = raw;
      } catch (err) {
        this.logger.warn(
          `convertGuestToUser: live subscription status read failed for sub=${checkout.stripe_subscription_id} (tag=${safeErrorTag(err)}) — falling back to seed status`,
        );
      }
    }

    // PR-9 — hoisted so the post-tx alert flush / discard sees the
    // ClientPurchase id even though the row is created inside the
    // $transaction callback below.
    let entitledPurchaseId: string | null = null;

    try {
      await this.prisma.$transaction(async (tx) => {
        // r48 #12 — atomic user upsert.  Two parallel webhook deliveries
        // (Stripe retries the same event id, our outer dedup is bypassed
        // by a clock-skew or replica-lag race) used to both pass the
        // findUnique → create path and one would P2002 on supabase_id.
        // Now we always go through Prisma's upsert which collapses the
        // race to a single CREATE INSERT ... ON CONFLICT under the hood.
        //
        // The 'create' side initialises coach_id; the 'update' side
        // ONLY attaches coach_id when the existing row has none (the
        // orphan-account heal path), so an existing client paying for
        // a second coach's package doesn't get silently re-routed.
        let dbUser = await tx.user.upsert({
          where: { supabase_id: supabaseUserId },
          create: {
            supabase_id: supabaseUserId,
            email: checkout.guest_email,
            name: checkout.guest_name,
            role: 'student',
            coach_id: checkout.package.coach_id,
          },
          update: {},
        });
        if (dbUser.coach_id == null) {
          // User existed but had no coach (rare — orphaned account).
          // Attach them to the package's coach.  Done as a separate
          // update so the upsert's 'update' branch stays a strict no-op
          // when the row already has a coach (no accidental re-routing).
          dbUser = await tx.user.update({
            where: { id: dbUser.id },
            data: { coach_id: checkout.package.coach_id },
          });
        }

        // Create the ClientPurchase row. The idempotency_key prefix
        // collides with no other minted key in the system (Phase 2-3
        // checkout uses raw UUIDs), and is itself @unique so a second
        // delivery would P2002 instead of double-charging.
        const purchaseIdemKey = `guest-purchase-${checkout.idempotency_key}`;
        let purchaseRow = await tx.clientPurchase.findFirst({
          where: {
            client_user_id: dbUser.id,
            package_id: checkout.package_id,
            stripe_payment_intent_id: checkout.stripe_payment_intent_id,
          },
        });
        if (!purchaseRow) {
          // PR-14 — billing_type snapshot follows the package's effective
          // billing semantics for the guest: pure recurring or combo both
          // mean the guest now holds a subscription, so the snapshot
          // reflects that. One-time-only continues to be 'one_time'.
          const isRecurring =
            checkout.package.billing_type === CANONICAL_RECURRING_BILLING_TYPE ||
            !!checkout.stripe_subscription_id;
          const billingSnapshot = isRecurring
            ? CANONICAL_RECURRING_BILLING_TYPE
            : checkout.package.billing_type;
          // PR-14 R2 P2-3 — status snapshot derived from the LIVE Stripe
          // subscription status read outside this tx (above). Mapping
          // mirrors applySubscriptionUpdated's normalizer:
          //   active / trialing / past_due → 'active' (entitlement live);
          //   incomplete / incomplete_expired / unpaid → 'pending'/'paid'
          //     (don't flip entitlement on; webhook will refine);
          //   canceled → 'canceled'.
          // Unknown / read-failed → conservative 'paid' for recurring so
          // entitlement still flips (matches the pre-R2 behaviour minus
          // the hard-coded 'active' lie) and the next webhook delivery
          // refines via the now-working ClientPurchase.stripe_subscription_id
          // claim (see applySubscriptionUpdated).
          let statusSnapshot: string;
          let entitlementActiveSnapshot = true;
          if (!isRecurring) {
            statusSnapshot = 'paid';
          } else if (
            liveSubscriptionStatus === 'active' ||
            liveSubscriptionStatus === 'trialing'
          ) {
            statusSnapshot = 'active';
          } else if (liveSubscriptionStatus === 'past_due') {
            statusSnapshot = 'past_due';
          } else if (liveSubscriptionStatus === 'canceled') {
            statusSnapshot = 'canceled';
            entitlementActiveSnapshot = false;
          } else if (
            liveSubscriptionStatus === 'incomplete' ||
            liveSubscriptionStatus === 'unpaid'
          ) {
            // Subscription still confirming; webhook will flip to active
            // when the buyer's PI confirms. Keep entitlement off so a
            // never-confirmed sub doesn't leak access.
            statusSnapshot = liveSubscriptionStatus;
            entitlementActiveSnapshot = false;
          } else if (liveSubscriptionStatus === 'incomplete_expired') {
            statusSnapshot = 'expired';
            entitlementActiveSnapshot = false;
          } else {
            // Read failed or unknown status. Conservative default: flip
            // entitlement on (the buyer paid; we don't want to gate them
            // out on a transient Stripe blip) and let the next webhook
            // refine. Subscription handler will fix status if needed.
            statusSnapshot = 'active';
          }
          try {
            purchaseRow = await tx.clientPurchase.create({
              data: {
                client_user_id: dbUser.id,
                coach_user_id: checkout.package.coach_id,
                package_id: checkout.package_id,
                amount_cents: checkout.package.amount_cents,
                currency: checkout.package.currency,
                billing_type: billingSnapshot,
                // No Checkout Session for guest flow — synthesise a
                // sentinel id so the @unique column stays unique.
                stripe_checkout_session_id: `guest_pi_${checkout.stripe_payment_intent_id}`,
                stripe_payment_intent_id: checkout.stripe_payment_intent_id,
                // PR-14 — propagate the Stripe subscription id captured
                // at sentinel-patch time so the existing
                // applySubscriptionUpdated webhook handler claims this
                // ClientPurchase row directly off stripe_subscription_id
                // (no metadata-fallback round-trip). Null on one-time
                // guests.
                stripe_subscription_id:
                  checkout.stripe_subscription_id ?? null,
                stripe_customer_id: checkout.stripe_customer_id,
                // P2-5 — write the destination Connect account so guest
                // rows reconcile alongside in-app purchases in Stripe
                // balance-transactions exports.
                stripe_destination_account: destinationAccount,
                status: statusSnapshot,
                entitlement_active: entitlementActiveSnapshot,
                // PR-14 — propagate landing_page_id from GuestCheckout
                // onto ClientPurchase inside the same conversion $tx.
                // GuestCheckout already validated the id (R47 / Audit #6
                // P0-5); we just copy. NULL-safe — null on direct-storefront
                // and pre-PR-14 rows.
                landing_page_id: checkout.landing_page_id ?? null,
                idempotency_key: purchaseIdemKey,
              },
            });
          } catch (err) {
            // Concurrent delivery raced us. Treat as already-created.
            if (!this.isUniqueViolation(err)) throw err;
            // Re-read the row the racer wrote so downstream tx steps
            // (e.g. PR-4 fanout) can reference it.
            purchaseRow = await tx.clientPurchase.findFirst({
              where: {
                client_user_id: dbUser.id,
                package_id: checkout.package_id,
                stripe_payment_intent_id: checkout.stripe_payment_intent_id,
              },
            });
          }
        }

        await tx.guestCheckout.update({
          where: { id: checkout.id },
          data: {
            status: 'converted',
            created_user_id: dbUser.id,
          },
        });

        // PR-9 — fan-out is now non-empty (drop seed + immediate-cadence
        // inline materialisation). Runs inside the same $transaction as
        // the entitlement write so money + content commit-or-roll-back
        // together. A resolver failure on an immediate drop re-throws
        // here, the outer catch routes the checkout to retryable, and
        // the reconciler retries the convert end-to-end. Replay safety:
        // PurchaseFanout.purchase_id @unique + ScheduledDrop
        // @@unique([client_purchase_id, content_id]) + per-resolver
        // uniques (PR-7).
        if (this.fanout && purchaseRow) {
          entitledPurchaseId = purchaseRow.id;
          await this.fanout.onPurchaseEntitled(
            purchaseRow,
            {
              entrypoint: 'storefront_guest',
              coachId: checkout.package.coach_id,
              clientId: dbUser.id,
              purchaseTime: new Date(),
            },
            tx,
          );
        }
      });
    } catch (err) {
      // Audit #3 P1-6 — DB transaction failures (deadlocks, unique
      // races, connection drops) are transient. Flip to
      // conversion_failed_retryable; the reconciliation worker will
      // pick this row up and retry the whole convert path.
      this.logger.error(
        `convertGuestToUser: transaction failed for ${checkout.id} (tag=${safeErrorTag(err)})`,
      );
      // PR-9 — drop the in-memory alert bucket for the rolled-back
      // purchase so the reconciler's retry doesn't double-alert when
      // the next attempt commits.
      if (this.fanout && entitledPurchaseId) {
        try {
          this.fanout.discardPendingAlerts(entitledPurchaseId);
        } catch {
          // best-effort
        }
      }
      await this.markRetryable(checkout.id, `db:${safeErrorTag(err)}`);
      return;
    }

    // PR-9 — outer tx COMMITTED. Fire-and-forget the drop alerts for
    // any drops materialised inline at checkout. Must be outside the
    // tx so push failures never roll back entitlement.
    if (this.fanout && entitledPurchaseId) {
      try {
        this.fanout.flushAlerts(entitledPurchaseId);
      } catch (err) {
        this.logger.warn(
          `drip alert flush failed purchase=${entitledPurchaseId}: ${(err as Error).message}`,
        );
      }
    }

    // Fire-and-forget welcome email. Resend failures must never roll
    // back the conversion.
    this.sendWelcomeEmail(checkout, inviteLink).catch((err) => {
      this.logger.error(
        `Welcome email failed for ${checkout.id} (tag=${safeErrorTag(err)})`,
      );
    });
  }

  // P2-5 — resolve the coach's Connect account id at conversion time so
  // we can persist `stripe_destination_account` on the ClientPurchase
  // row. Returns null only when the coach genuinely has no Connect
  // account row (extremely rare because createIntent already gates on
  // charges_enabled), matching the column's nullable shape on the
  // existing in-app flow.
  //
  // Audit #4 P2-8 — on a Prisma DB error this MUST throw rather than
  // return null. Swallowing the error and writing null would silently
  // corrupt revenue reconciliation; the caller catches and routes the
  // checkout into conversion_failed_retryable so a later attempt can
  // write the correct destination account.
  //
  // Audit #5 P1-6 — Prisma errors are not the only null path. The
  // findUnique succeeds and returns null when the ConnectAccount row
  // is missing (or when stripe_account_id is null on an unfinished
  // onboarding). The pre-fix-round-5 version still returned null in
  // that case and convertGuestToUser persisted ClientPurchase with
  // stripe_destination_account = null. Now throw a typed
  // DestinationAccountMissingError so the caller routes through
  // markRetryable. Upstream isConnectAccountReadyForCheckout already
  // gates createIntent, but a coach can disconnect Stripe between
  // paying and conversion (TOCTOU); this guard closes the window.
  private async resolveDestinationAccount(coachUserId: string): Promise<string> {
    const connect = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
      select: { stripe_account_id: true },
    });
    const id = connect?.stripe_account_id;
    if (!id || id.trim().length === 0) {
      throw new DestinationAccountMissingError(coachUserId);
    }
    return id;
  }

  private async ensureSupabaseUser(
    email: string,
    name: string,
    checkoutId: string,
  ): Promise<{ supabaseUserId: string; inviteLink: string | null }> {
    const client = this.supabase.getClient();

    // Audit #3 P1-9 — invite-link flow replaces temp-password email.
    //
    // The previous flow generated a temporary password, set
    // email_confirm: true, and emailed the password to the buyer. That
    // turned mailbox access into account access, bypassed normal email
    // verification, and put plaintext credentials in transit and at
    // rest in inboxes — a hostile-lawyer privacy problem for a fitness
    // product handling client data.
    //
    // The new flow:
    //   1. createUser with NO password and email_confirm: FALSE.
    //   2. generateLink({ type: 'invite' }) for a fresh invite URL.
    //   3. Email the invite URL (NEVER a password). The buyer clicks,
    //      Supabase auto-confirms the email, and the buyer sets their
    //      own password.
    //
    // Each Supabase admin call is wrapped in SUPABASE_ADMIN_TIMEOUT_MS
    // so a hung request cannot block the webhook indefinitely.
    const { data, error } = await withTimeout(
      client.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: {
          name,
          source: 'guest_checkout',
          guest_checkout_id: checkoutId,
        },
      }),
      SUPABASE_ADMIN_TIMEOUT_MS,
      'supabase_createUser',
    );

    if (data?.user?.id) {
      const inviteLink = await this.generateInviteLink(email);
      return { supabaseUserId: data.user.id, inviteLink };
    }

    // Email already registered. Look the existing user up by email.
    const errorMsg = error?.message?.toLowerCase() ?? '';
    const alreadyExists =
      errorMsg.includes('already') ||
      errorMsg.includes('registered') ||
      errorMsg.includes('exists');
    if (!alreadyExists) {
      throw error ?? new SupabaseCreateUserError(errorMsg);
    }

    // P1-5 — page through every Supabase user (up to the configured
    // cap) instead of looking at the first page only. The whole loop
    // is also bounded by an 8s deadline so a slow Supabase tenant
    // cannot stall the webhook for a full minute on a large project.
    const deadline = Date.now() + SUPABASE_LIST_USERS_TIMEOUT_MS;
    const lowered = email.toLowerCase();
    for (let page = 1; page <= SUPABASE_LIST_USERS_MAX_PAGES; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SupabaseTimeoutError('supabase_listUsers');
      }
      const list = await withTimeout(
        client.auth.admin.listUsers({
          page,
          perPage: SUPABASE_LIST_USERS_PAGE_SIZE,
        }),
        Math.min(remaining, SUPABASE_ADMIN_TIMEOUT_MS),
        'supabase_listUsers',
      );
      const users =
        (list as {
          data?: { users?: Array<{ id: string; email?: string }> };
        }).data?.users ?? [];
      const match = users.find(
        (u) => (u.email ?? '').toLowerCase() === lowered,
      );
      if (match) {
        // Existing customer paying for a new package — they already
        // have an account, so the welcome mail uses the
        // "no-invite-link" branch and tells them to sign in normally.
        return { supabaseUserId: match.id, inviteLink: null };
      }
      // Stop early when the page is short — Supabase returns up to
      // perPage users and a short page means there are no more.
      if (users.length < SUPABASE_LIST_USERS_PAGE_SIZE) {
        break;
      }
    }
    throw new SupabaseExistingUserNotFoundError();
  }

  // Audit #3 P1-6 — flip a paid (or retryable) row to
  // conversion_failed_retryable, increment retry_count, and stamp the
  // attempt. Past RECONCILIATION_MAX_ATTEMPTS the row moves to
  // conversion_failed_terminal and the operator dashboard pages on-call.
  // last_error is a short tag (no PII).
  private async markRetryable(
    checkoutId: string,
    lastError: string,
  ): Promise<void> {
    try {
      // Read current retry_count so we can decide between retryable
      // and terminal. The branch is small enough that a single read +
      // updateMany is simpler than coercing it into a single CASE
      // statement; the row is identified by primary key so contention
      // is minimal.
      const row = await this.prisma.guestCheckout.findUnique({
        where: { id: checkoutId },
        select: { retry_count: true, status: true },
      });
      if (!row) return;
      const nextCount = row.retry_count + 1;
      const terminal = nextCount >= RECONCILIATION_MAX_ATTEMPTS;
      await this.prisma.guestCheckout.updateMany({
        where: {
          id: checkoutId,
          status: { in: ['paid', 'conversion_failed_retryable'] },
        },
        data: {
          status: terminal
            ? 'conversion_failed_terminal'
            : 'conversion_failed_retryable',
          retry_count: nextCount,
          last_error: lastError.slice(0, 200),
          last_retry_at: new Date(),
        },
      });
      if (terminal) {
        this.logger.error(
          `GuestCheckout ${checkoutId} reached conversion_failed_terminal after ${nextCount} retries (last_error=${lastError.slice(0, 64)})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `markRetryable crashed for ${checkoutId} (tag=${safeErrorTag(err)})`,
      );
    }
  }

  // Audit #3 P1-6 + P1-7 — entry point for the reconciliation worker.
  // Two callers feed in here:
  //   1. Rows stuck in `conversion_failed_retryable` with retry_count <
  //      RECONCILIATION_MAX_ATTEMPTS — re-run conversion.
  //   2. Rows stuck in `paid` past a grace window with no
  //      created_user_id — covers the P1-7 case where the handler
  //      crashed between `paid` and `markRetryable`.
  //
  // The actual conversion path is exactly the same as the webhook one,
  // so we re-fetch the row with relations and call convertGuestToUser.
  // convertGuestToUser already re-reads status inside the path and
  // exits cleanly if the row is no longer paid.
  async reconcilePaidCheckout(checkoutId: string): Promise<void> {
    const checkout = await this.prisma.guestCheckout.findUnique({
      where: { id: checkoutId },
      include: { package: { include: { coach: true } } },
    });
    if (!checkout) return;
    if (
      checkout.status !== 'paid' &&
      checkout.status !== 'conversion_failed_retryable'
    ) {
      // Already converted or terminal — nothing to do.
      return;
    }
    if (checkout.status === 'conversion_failed_retryable') {
      // Re-arm the row as paid for the convert path. The state
      // transition is internal to the reconciliation worker; the
      // public state machine still presents the row as retryable
      // until conversion either succeeds (→ converted) or exhausts
      // (→ terminal).
      await this.prisma.guestCheckout.updateMany({
        where: { id: checkoutId, status: 'conversion_failed_retryable' },
        data: { status: 'paid' },
      });
    }
    const reread = await this.prisma.guestCheckout.findUnique({
      where: { id: checkoutId },
      include: { package: { include: { coach: true } } },
    });
    if (!reread || reread.status !== 'paid') return;
    await this.convertGuestToUser(reread as CheckoutWithRelations);
  }

  // Audit #3 P1-9 — generate a Supabase invite link for a brand-new
  // guest account. The Supabase admin API returns a one-time URL the
  // user clicks to verify their email and set their own password. We
  // never see or transmit the password.
  //
  // Returns null when Supabase rejects the link request (logged). The
  // welcome email then falls back to a generic "sign-in" message rather
  // than leaving the user with no path into the app. Conversion is
  // already complete by this point (ClientPurchase exists), so the user
  // can recover via the standard password-reset / magic-link flow.
  private async generateInviteLink(email: string): Promise<string | null> {
    try {
      const client = this.supabase.getClient();
      const { data, error } = await withTimeout(
        client.auth.admin.generateLink({
          type: 'invite',
          email,
        }),
        SUPABASE_ADMIN_TIMEOUT_MS,
        'supabase_generateLink',
      );
      if (error) {
        this.logger.error(
          `supabase generateLink failed for guest checkout (tag=${safeErrorTag(error)})`,
        );
        return null;
      }
      // Supabase returns the URL in data.properties.action_link.
      const link =
        (data as {
          properties?: { action_link?: string };
        }).properties?.action_link ?? null;
      return typeof link === 'string' && link.length > 0 ? link : null;
    } catch (err) {
      this.logger.error(
        `supabase generateLink crashed (tag=${safeErrorTag(err)})`,
      );
      return null;
    }
  }

  // Resend transactional email. Times out at 8s via AbortController so a
  // Resend outage cannot hang the conversion path indefinitely.
  //
  // Audit #3 P1-9 — body never includes a password. Brand-new accounts
  // receive a Supabase invite link; existing-account purchases receive
  // a sign-in nudge. From-address comes from RESEND_FROM_EMAIL which is
  // production-required so welcome mail can never default to an
  // unverified domain (env-validation prodHardenedFeatureVars).
  private async sendWelcomeEmail(
    checkout: CheckoutWithRelations,
    inviteLink: string | null,
  ): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `RESEND_API_KEY unset — skipping welcome email for ${checkout.id}`,
      );
      return;
    }
    // Dev-only fallback. Production refuses to boot without
    // RESEND_FROM_EMAIL via env-validation.
    //
    // Audit #5 P2-3 — customer-facing copy uses the brand name
    // "Growth Project", never the internal abbreviation "TGP". This
    // affects three places in the welcome-email path: the from-header
    // fallback, the body line "added X to your existing ... account",
    // and the subject line.
    const fromAddress =
      this.config.get<string>('RESEND_FROM_EMAIL') ??
      'Growth Project <welcome@trygrowthproject.com>';

    const coachName = checkout.package.coach.name?.trim() || 'Your coach';
    const packageName = checkout.package.name;
    const appStoreUrl =
      this.config.get<string>('APP_STORE_URL') ??
      'https://apps.apple.com/app/id6765847915';
    const playStoreUrl =
      this.config.get<string>('PLAY_STORE_URL') ??
      'https://play.google.com/store/apps/details?id=com.growthproject.app';

    const credentials =
      inviteLink !== null
        ? `<p>To access your account, set a password and verify your email:</p><p><a href="${escapeAttr(
            inviteLink,
          )}" style="background:#C9A84C;color:#1A1A1A;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Activate your account</a></p><p style="color:#666;font-size:14px;">This link expires in 24 hours. If it does, you can use "Forgot password" on the sign-in screen with <strong>${escapeHtml(
            checkout.guest_email,
          )}</strong>.</p>`
        : `<p>We've added <strong>${escapeHtml(
            packageName,
          )}</strong> to your existing Growth Project account — sign in with your usual credentials.</p>`;

    // A276-P0-2 — Stripe-hosted receipt link. Only rendered when the
    // upstream resolveReceiptUrl produced an https URL (rejects local://
    // legacy values and any non-https schemes via escapeAttr).
    const stripeReceiptUrl = (checkout as { receipt_url?: string | null }).receipt_url ?? null;
    const receiptLine =
      typeof stripeReceiptUrl === 'string' &&
      /^https:\/\//.test(stripeReceiptUrl)
        ? `<p style="margin-top:16px;"><a href="${escapeAttr(
            stripeReceiptUrl,
          )}" style="color:#1A1A1A;text-decoration:underline;">View your receipt</a></p>`
        : '';

    const body = {
      from: fromAddress,
      to: checkout.guest_email,
      subject: `${coachName} is ready for you on Growth Project`,
      html: `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#F5F0E8;margin:0;padding:24px;">
<h1 style="font-family:Georgia,serif;color:#1A1A1A;">Welcome, ${escapeHtml(checkout.guest_name)}.</h1>
<p>You're enrolled in <strong>${escapeHtml(packageName)}</strong> with ${escapeHtml(coachName)}.</p>
${credentials}
${receiptLine}
<p style="margin-top:24px;"><a href="${escapeAttr(appStoreUrl)}" style="background:#C9A84C;color:#1A1A1A;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Download for iOS</a> &nbsp;
<a href="${escapeAttr(playStoreUrl)}" style="background:#C9A84C;color:#1A1A1A;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Download for Android</a></p>
</body></html>`,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Don't read the body — it can echo our API key fragments in
        // verbose error responses. Log status only.
        this.logger.error(
          `Resend send failed (status=${res.status}) for ${checkout.id}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    return (
      typeof e.message === 'string' && /unique constraint/i.test(e.message)
    );
  }
}

// Lightweight HTML escape — guest input lands in a transactional email
// rendered by Resend, so XSS pivots into a customer's mailbox if we
// don't escape. Built locally to avoid a runtime dependency on `he` or
// `escape-html`.
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Audit #5 P1-8 — escapeAttr was a literal alias of escapeHtml, which
// catches angle brackets / quotes but does NOT block dangerous URL
// schemes. The function is used to render `<a href="${escapeAttr(...)}">`
// for the Supabase invite link in the welcome email; if Supabase (or
// any future caller) ever returns or is compromised to return a
// `javascript:` or `data:` scheme, the rendered email becomes a stored
// XSS vector against a brand-new paying customer's mailbox.
//
// Hardening:
//   1) Try the WHATWG URL parser. Anything that fails to parse, or
//      whose protocol is not http(s), is replaced with '#' — a
//      neutral href that is functional (the email still renders) but
//      cannot execute anything.
//   2) The resulting (allowlisted) URL is then run through escapeHtml
//      so quote/bracket characters in legitimate query strings still
//      can't escape the attribute context.
//
// '#' is intentional rather than dropping the entire <a> tag — the
// caller's template assumes a string output. If a malicious scheme
// ever lands here, the email still arrives and the operator sees
// the broken link in support before a phishing payload reaches the
// customer.
const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:']);
function escapeAttr(input: string): string {
  let safe = '#';
  try {
    const parsed = new URL(input);
    if (SAFE_HREF_PROTOCOLS.has(parsed.protocol)) {
      safe = parsed.toString();
    }
  } catch {
    // Not parseable → fall through to '#'.
  }
  return escapeHtml(safe);
}
