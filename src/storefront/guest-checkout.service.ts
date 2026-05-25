import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CoachPackage,
  GuestCheckout,
  User,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  SupabaseCreateUserError,
  SupabaseExistingUserNotFoundError,
  SupabaseTimeoutError,
} from './errors/guest-conversion.error';
import type { GuestCheckoutDto } from './storefront.dto';
import type { GuestCheckoutResult } from './storefront.types';

// Platform cut on every guest checkout. Stripe's minimum application_fee
// is 50 cents — packages priced low enough that 2% falls below the floor
// get bumped up so Stripe accepts the charge.
const PLATFORM_FEE_PERCENT = 0.02;
const PLATFORM_FEE_MIN_CENTS = 50;

// PaymentIntents live indefinitely on Stripe's side, but the storefront's
// branded checkout session has a tighter contract: the link expires 24h
// after the first POST /checkout call. Older idempotency keys must be
// replaced rather than reused.
const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

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
      !pkg.share_link_enabled
    ) {
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }
    const connectAccount = pkg.coach.connect_account;
    if (!connectAccount || !connectAccount.charges_enabled) {
      throw new NotFoundException({
        error: 'PACKAGE_UNAVAILABLE',
        message: 'This coach is not currently accepting new clients.',
      });
    }

    // Audit #3 P1-5 — recurring packages cannot be sold through Phase 1
    // guest checkout. The previous guard checked the display labels
    // (`monthly`/`quarterly`/`annual`) which live in the interval
    // columns, not the canonical schema value, and let any package whose
    // billing_type was the canonical 'recurring' slip through and get
    // charged as a one-off PI with no subscription lifecycle. The check
    // now uses the canonical schema value directly.
    if (pkg.billing_type === CANONICAL_RECURRING_BILLING_TYPE) {
      throw new UnprocessableEntityException({
        error: 'RECURRING_NOT_SUPPORTED',
        message:
          'Recurring packages are not yet supported via share links. Please contact your coach to join.',
      });
    }

    const normalisedEmail = dto.guest_email.toLowerCase().trim();
    const normalisedName = dto.guest_name.trim();

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

    // Platform fee. Math.floor guards a fractional cent from rounding up
    // and exceeding the package amount; clamp to Stripe's 50¢ minimum.
    const platformFeeCents = Math.max(
      Math.floor(pkg.amount_cents * PLATFORM_FEE_PERCENT),
      PLATFORM_FEE_MIN_CENTS,
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

    // Mint Stripe PaymentIntent. AbortController(10s) is wired inside
    // StripeConnectApiService — see src/connect/stripe-connect-api.service.ts
    // `fetchImpl`.
    let paymentIntent: { id: string; client_secret: string };
    try {
      const created = await this.stripe.createPaymentIntent({
        amount: pkg.amount_cents,
        currency: pkg.currency,
        // Guest checkout never reuses cards — omit `customer` entirely
        // rather than passing an empty string (P2-3).
        applicationFeeAmount: platformFeeCents,
        transferDestination: connectAccount.stripe_account_id,
        metadata: {
          [GUEST_CHECKOUT_METADATA_KEY]: dto.idempotency_key,
          package_id: pkg.id,
          share_token: token,
          guest_email: normalisedEmail,
          guest_name: normalisedName,
          coach_user_id: pkg.coach_id,
          guest_checkout_id: sentinel.id,
        },
        idempotencyKey: `guest-checkout-pi-${dto.idempotency_key}`,
      });
      paymentIntent = {
        id: created.id,
        client_secret: created.client_secret,
      };
    } catch (err) {
      // Stripe rejected the PI. Mark the sentinel as failed so future
      // requests with the same key don't re-attempt an obviously-broken
      // configuration (e.g. unsupported currency); the storefront must
      // generate a fresh key to retry.
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
      throw err;
    }

    // Patch the sentinel with the real PaymentIntent id. We tolerate a
    // P2002 here in the case where Stripe re-issues the same PI id via
    // its own idempotency-key dedup — unlikely but defended against.
    try {
      await this.prisma.guestCheckout.update({
        where: { id: sentinel.id },
        data: { stripe_payment_intent_id: paymentIntent.id },
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }

    return {
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      guest_checkout_id: sentinel.id,
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

  async handlePaymentSucceeded(paymentIntentId: string): Promise<void> {
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
      await this.convertGuestToUser(checkout);
    } catch (err) {
      // Webhook MUST return 200 — log + swallow.
      this.logger.error(
        `handlePaymentSucceeded crashed (tag=${safeErrorTag(err)})`,
      );
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
    let tempPassword: string | null = null;
    try {
      const result = await this.ensureSupabaseUser(
        checkout.guest_email,
        checkout.guest_name,
        checkout.id,
      );
      supabaseUserId = result.supabaseUserId;
      tempPassword = result.tempPassword;
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
    const destinationAccount = await this.resolveDestinationAccount(
      checkout.package.coach_id,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        // Upsert the Prisma User row mirrored from Supabase. If a User
        // already exists (existing customer paying with the same email),
        // we keep their coach_id intact rather than re-routing them
        // to a new coach.
        let dbUser = await tx.user.findUnique({
          where: { supabase_id: supabaseUserId },
        });
        if (!dbUser) {
          dbUser = await tx.user.create({
            data: {
              supabase_id: supabaseUserId,
              email: checkout.guest_email,
              name: checkout.guest_name,
              role: 'student',
              coach_id: checkout.package.coach_id,
            },
          });
        } else if (dbUser.coach_id == null) {
          // User existed but had no coach (rare — orphaned account).
          // Attach them to the package's coach.
          await tx.user.update({
            where: { id: dbUser.id },
            data: { coach_id: checkout.package.coach_id },
          });
        }

        // Create the ClientPurchase row. The idempotency_key prefix
        // collides with no other minted key in the system (Phase 2-3
        // checkout uses raw UUIDs), and is itself @unique so a second
        // delivery would P2002 instead of double-charging.
        const purchaseIdemKey = `guest-purchase-${checkout.idempotency_key}`;
        const existingPurchase = await tx.clientPurchase.findFirst({
          where: {
            client_user_id: dbUser.id,
            package_id: checkout.package_id,
            stripe_payment_intent_id: checkout.stripe_payment_intent_id,
          },
        });
        if (!existingPurchase) {
          try {
            await tx.clientPurchase.create({
              data: {
                client_user_id: dbUser.id,
                coach_user_id: checkout.package.coach_id,
                package_id: checkout.package_id,
                amount_cents: checkout.package.amount_cents,
                currency: checkout.package.currency,
                billing_type: checkout.package.billing_type,
                // No Checkout Session for guest flow — synthesise a
                // sentinel id so the @unique column stays unique.
                stripe_checkout_session_id: `guest_pi_${checkout.stripe_payment_intent_id}`,
                stripe_payment_intent_id: checkout.stripe_payment_intent_id,
                stripe_customer_id: checkout.stripe_customer_id,
                // P2-5 — write the destination Connect account so guest
                // rows reconcile alongside in-app purchases in Stripe
                // balance-transactions exports.
                stripe_destination_account: destinationAccount,
                status: 'paid',
                entitlement_active: true,
                idempotency_key: purchaseIdemKey,
              },
            });
          } catch (err) {
            // Concurrent delivery raced us. Treat as already-created.
            if (!this.isUniqueViolation(err)) throw err;
          }
        }

        await tx.guestCheckout.update({
          where: { id: checkout.id },
          data: {
            status: 'converted',
            created_user_id: dbUser.id,
          },
        });
      });
    } catch (err) {
      // Audit #3 P1-6 — DB transaction failures (deadlocks, unique
      // races, connection drops) are transient. Flip to
      // conversion_failed_retryable; the reconciliation worker will
      // pick this row up and retry the whole convert path.
      this.logger.error(
        `convertGuestToUser: transaction failed for ${checkout.id} (tag=${safeErrorTag(err)})`,
      );
      await this.markRetryable(checkout.id, `db:${safeErrorTag(err)}`);
      return;
    }

    // Fire-and-forget welcome email. Resend failures must never roll
    // back the conversion.
    this.sendWelcomeEmail(checkout, tempPassword).catch((err) => {
      this.logger.error(
        `Welcome email failed for ${checkout.id} (tag=${safeErrorTag(err)})`,
      );
    });
  }

  // P2-5 — resolve the coach's Connect account id at conversion time so
  // we can persist `stripe_destination_account` on the ClientPurchase
  // row. Returns null if the coach has no Connect account (extremely
  // rare here because createIntent already gates on charges_enabled),
  // matching the column's nullable shape on the existing in-app flow.
  private async resolveDestinationAccount(
    coachUserId: string,
  ): Promise<string | null> {
    try {
      const connect = await this.prisma.connectAccount.findUnique({
        where: { coach_user_id: coachUserId },
        select: { stripe_account_id: true },
      });
      return connect?.stripe_account_id ?? null;
    } catch (err) {
      this.logger.error(
        `resolveDestinationAccount failed for coach ${coachUserId} (tag=${safeErrorTag(err)})`,
      );
      return null;
    }
  }

  private async ensureSupabaseUser(
    email: string,
    name: string,
    checkoutId: string,
  ): Promise<{ supabaseUserId: string; tempPassword: string | null }> {
    const client = this.supabase.getClient();

    // Try to create unconditionally — Supabase returns a typed error code
    // when the email already exists, which we handle below. P1-4 wraps
    // each admin call in a 10s timeout so a hung Supabase request cannot
    // block the webhook indefinitely.
    const tempPassword = this.generateTempPassword();
    const { data, error } = await withTimeout(
      client.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
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
      return { supabaseUserId: data.user.id, tempPassword };
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
        return { supabaseUserId: match.id, tempPassword: null };
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

  // 24-char password drawn from a curated alphabet (no look-alike
  // characters). The temp password is mailed to the guest exactly once;
  // they're prompted to rotate on first login. crypto.randomInt gives a
  // CSPRNG-grade selection — Math.random would be biased.
  private generateTempPassword(): string {
    const alphabet =
      'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    const { randomInt } = require('crypto') as typeof import('crypto');
    let out = '';
    for (let i = 0; i < 24; i += 1) {
      out += alphabet[randomInt(0, alphabet.length)];
    }
    return out;
  }

  // Resend transactional email. Times out at 8s via AbortController so a
  // Resend outage cannot hang the conversion path indefinitely.
  private async sendWelcomeEmail(
    checkout: CheckoutWithRelations,
    tempPassword: string | null,
  ): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `RESEND_API_KEY unset — skipping welcome email for ${checkout.id}`,
      );
      return;
    }

    const coachName = checkout.package.coach.name?.trim() || 'Your coach';
    const packageName = checkout.package.name;
    const appStoreUrl =
      this.config.get<string>('APP_STORE_URL') ??
      'https://apps.apple.com/app/id6765847915';
    const playStoreUrl =
      this.config.get<string>('PLAY_STORE_URL') ??
      'https://play.google.com/store/apps/details?id=com.growthproject.app';

    const credentials =
      tempPassword !== null
        ? `<p>Your login details:</p><p><strong>Email:</strong> ${escapeHtml(
            checkout.guest_email,
          )}<br/><strong>Temporary Password:</strong> ${escapeHtml(
            tempPassword,
          )}</p><p style="color:#666;font-size:14px;">You'll be prompted to set a new password the first time you log in.</p>`
        : `<p>We've added <strong>${escapeHtml(
            packageName,
          )}</strong> to your existing TGP account — sign in with your usual credentials.</p>`;

    const body = {
      from: 'TGP Fitness <welcome@tgp.app>',
      to: checkout.guest_email,
      subject: `You're in! ${coachName} is ready for you on TGP`,
      html: `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#F5F0E8;margin:0;padding:24px;">
<h1 style="font-family:Georgia,serif;color:#1A1A1A;">Welcome, ${escapeHtml(checkout.guest_name)}.</h1>
<p>You're enrolled in <strong>${escapeHtml(packageName)}</strong> with ${escapeHtml(coachName)}.</p>
${credentials}
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

function escapeAttr(input: string): string {
  return escapeHtml(input);
}
