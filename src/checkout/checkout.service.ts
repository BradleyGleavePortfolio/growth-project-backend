import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientPurchase, CoachPackage, ConnectCustomer } from '@prisma/client';
import { ConnectModuleState } from '../connect/connect.module-state';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';
import { PackagesService } from '../packages/packages.service';

// CheckoutService — Stripe Checkout session minting + ClientPurchase row
// lifecycle. This is the entry point clients hit to actually buy a package.
//
// Flow:
//   1. Resolve client + coach + package; coach must have a fully-onboarded
//      ConnectAccount (charges_enabled).
//   2. Ensure ConnectCustomer exists for the client; create if missing.
//   3. Ensure Stripe Product + Price exist for the package; create lazily
//      and cache on the package row. Re-create when package fields changed.
//   4. Mint a Stripe Checkout Session in mode=payment (one_time) or
//      mode=subscription (recurring) with `transfer_data[destination]` set
//      to the coach's connected account.
//   5. Persist a ClientPurchase row in status=pending with the session id.
//   6. Return the hosted URL + session id to the caller.
//
// Idempotency:
//   - The Stripe Checkout Session create call uses idempotency_key
//     `purchase-{clientId}-{packageId}-{slot}` where slot is a daily
//     bucket (UTC date). Stripe collapses retries to the same session
//     within the same UTC day. The same key is stored on the ClientPurchase
//     row (`idempotency_key`, @unique) so a duplicate Prisma create lands
//     on the existing row and we re-return it.

export interface CreateCheckoutInput {
  package_id: string;
  success_url?: string;
  cancel_url?: string;
}

export interface CheckoutCreatedView {
  session_id: string;
  url: string;
  purchase_id: string;
  status: string;
  package: CoachPackage;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private prisma: PrismaService,
    private stripeConnect: StripeConnectApiService,
    private packages: PackagesService,
    private state: ConnectModuleState,
    private feePolicy: FeePolicyService,
  ) {}

  async createCheckoutForClient(
    clientUserId: string,
    input: CreateCheckoutInput,
  ): Promise<CheckoutCreatedView> {
    this.assertReady();

    if (!input?.package_id) {
      throw new BadRequestException({
        error: 'PACKAGE_ID_REQUIRED',
        message: 'package_id is required',
      });
    }

    const client = await this.prisma.user.findUnique({
      where: { id: clientUserId },
      select: { id: true, email: true, name: true, coach_id: true },
    });
    if (!client) {
      throw new NotFoundException({
        error: 'CLIENT_NOT_FOUND',
        message: 'Client account not found',
      });
    }

    if (!client.coach_id) {
      throw new BadRequestException({ error: 'COACH_NOT_ASSIGNED', message: 'No coach assigned to this client.' });
    }

    const packageId = input.package_id;
    const pkg = await this.prisma.coachPackage.findFirst({
      where: {
        id: packageId,
        coach_id: client.coach_id,
        is_active: true,
        archived_at: null,
      },
    });
    if (!pkg) throw new NotFoundException({ error: 'PACKAGE_NOT_FOUND', message: 'Package not found or not available.' });

    const coach = await this.prisma.user.findUnique({
      where: { id: pkg.coach_id },
      select: { id: true, email: true, name: true },
    });
    if (!coach) {
      throw new NotFoundException({
        error: 'COACH_NOT_FOUND',
        message: 'Coach for this package no longer exists',
      });
    }

    const connectAccount = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: pkg.coach_id },
    });
    if (!connectAccount) {
      throw new ConflictException({
        error: 'COACH_NOT_CONNECTED',
        message:
          'The coach has not connected a Stripe account yet. Ask them to complete Stripe Connect onboarding.',
      });
    }
    if (!connectAccount.charges_enabled || connectAccount.deauthorized_at) {
      throw new ConflictException({
        error: 'COACH_NOT_PAYOUT_READY',
        message:
          'The coach has not finished Stripe onboarding. Charges are not yet enabled on their account.',
      });
    }

    const customer = await this.ensureCustomer(client.id, client.email, client.name);
    const priceId = await this.ensurePriceForPackage(pkg);

    const successUrl =
      input.success_url ??
      process.env.STRIPE_CHECKOUT_SUCCESS_URL ??
      'com.growthproject.app://checkout/success?session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl =
      input.cancel_url ??
      process.env.STRIPE_CHECKOUT_CANCEL_URL ??
      'com.growthproject.app://checkout/cancel';

    const dayBucket = new Date().toISOString().slice(0, 10);
    const idempotencyKey = `purchase-${client.id}-${pkg.id}-${dayBucket}`;

    // Pre-check for a same-day duplicate so we can return the existing row
    // without re-hitting Stripe.
    const existing = await this.prisma.clientPurchase.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    if (existing && existing.status === 'pending') {
      // Fetch the session URL from Stripe (the hosted page expires after
      // 24h so we may need to re-mint, but Stripe accepts identical
      // idempotency keys with identical params and returns the same row).
      try {
        const session = await this.stripeConnect.retrieveCheckoutSession(
          existing.stripe_checkout_session_id,
        );
        if (session.url) {
          return {
            session_id: session.id,
            url: session.url,
            purchase_id: existing.id,
            status: existing.status,
            package: pkg,
          };
        }
      } catch (err) {
        // Session expired on Stripe's side; fall through and create new.
        this.logger.warn(
          `Re-using purchase ${existing.id} failed (${(err as Error).message}); will create new session`,
        );
      }
    }

    const mode: 'payment' | 'subscription' =
      pkg.billing_type === 'recurring' ? 'subscription' : 'payment';

    // Phase 4: resolve the fee split BEFORE minting the checkout session
    // so the platform application fee can be attached to the Stripe call.
    //
    // For mode=payment (one_time), Stripe accepts an absolute
    // application_fee_amount in cents — we pass the platform's slice
    // directly. The optional head-coach 5% slice is NOT attached here;
    // it's minted as a follow-on Transfer after the charge succeeds
    // (Stripe only supports one application fee + one destination per
    // session). We add the head-coach amount on top of the platform fee
    // and KEEP that delta on the platform balance until the follow-on
    // Transfer drains it to the head coach.
    //
    // For mode=subscription, Stripe accepts only application_fee_percent
    // (not amount). We compute the effective percent from the combined
    // platform + head-coach bps, then mint the head-coach follow-on
    // transfer per renewal off the invoice.paid webhook.
    const plan = await this.feePolicy.planFor(coach.id, pkg.amount_cents);
    const applicationFeeForStripe =
      plan.application_fee_cents + plan.head_coach_split_cents;

    let session;
    try {
      session = await this.stripeConnect.createCheckoutSession({
        mode,
        customer: customer.stripe_customer_id,
        priceId,
        quantity: 1,
        successUrl,
        cancelUrl,
        destinationAccount: connectAccount.stripe_account_id,
        // One-time: pass an absolute cents amount.
        applicationFeeAmount:
          mode === 'payment' && applicationFeeForStripe > 0
            ? applicationFeeForStripe
            : undefined,
        // Subscription: pass a percent. Stripe only accepts up to 2
        // decimal places of precision on application_fee_percent. The
        // bps math from FeePolicyService gives us a target *cents*
        // figure (applicationFeeForStripe); the percent we send must
        // collect AT LEAST that many cents per renewal.
        //
        // Rounding doctrine (P0 fix): `.toFixed(2)` is banker's-rounding
        // through Number's IEEE-754 path and was demonstrably under-
        // collecting by 1¢ on amounts like $9.99 + 2% (≈19.98¢ →
        // floor=19, naive .toFixed(2)=19.98 which Stripe rounds back
        // to 19¢ on a one-time but DRIFTS on recurring renewals over
        // many months). We now ceiling-round the percent to 2 dp so
        // the platform never under-collects across renewals. The
        // worst-case over-collection is < 1¢ on the first renewal and
        // self-corrects within a year via the reconciliation worker.
        //
        // See test: test/checkout-subscription-fee-rounding.spec.ts
        applicationFeePercent:
          mode === 'subscription' && applicationFeeForStripe > 0
            ? this.toStripeApplicationFeePercent(
                applicationFeeForStripe,
                pkg.amount_cents,
              )
            : undefined,
        clientReferenceId: client.id,
        metadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_platform_fee_cents: String(plan.application_fee_cents),
          tgp_head_coach_split_cents: String(plan.head_coach_split_cents),
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
        },
        subscriptionMetadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
        },
        paymentIntentMetadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_platform_fee_cents: String(plan.application_fee_cents),
          tgp_head_coach_split_cents: String(plan.head_coach_split_cents),
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
        },
        idempotencyKey,
      });
    } catch (err) {
      if (err instanceof StripeConnectApiError) {
        // Re-throw with a clean shape; the controller maps to HTTP.
        throw err;
      }
      throw err;
    }

    // Upsert by idempotency_key so Stripe-retry-collapsed sessions land on
    // the same row even if our DB write loses a race.
    const purchase = await this.prisma.clientPurchase.upsert({
      where: { idempotency_key: idempotencyKey },
      create: {
        client_user_id: client.id,
        coach_user_id: coach.id,
        package_id: pkg.id,
        amount_cents: pkg.amount_cents,
        currency: pkg.currency,
        billing_type: pkg.billing_type,
        stripe_checkout_session_id: session.id,
        stripe_customer_id: customer.stripe_customer_id,
        stripe_destination_account: connectAccount.stripe_account_id,
        status: 'pending',
        entitlement_active: false,
        idempotency_key: idempotencyKey,
      },
      update: {
        // If Stripe returned the same session id on retry, just touch
        // updated_at by re-affirming a no-op-ish field. We keep the
        // original status; webhooks will move it forward.
        stripe_checkout_session_id: session.id,
      },
    });

    return {
      session_id: session.id,
      url: session.url,
      purchase_id: purchase.id,
      status: purchase.status,
      package: pkg,
    };
  }

  // Phase 7 — Payment Sheet: mint a PaymentIntent + EphemeralKey so the
  // mobile client can complete a payment without a browser redirect.
  async createPaymentIntentForClient(
    clientUserId: string,
    input: { package_id: string },
  ): Promise<{
    client_secret: string;
    ephemeral_key: string;
    customer_id: string;
    publishable_key: string;
  }> {
    this.assertReady();

    if (!input?.package_id) {
      throw new BadRequestException({
        error: 'PACKAGE_ID_REQUIRED',
        message: 'package_id is required',
      });
    }

    const client = await this.prisma.user.findUnique({
      where: { id: clientUserId },
      select: { id: true, email: true, name: true, coach_id: true },
    });
    if (!client) {
      throw new NotFoundException({
        error: 'CLIENT_NOT_FOUND',
        message: 'Client account not found',
      });
    }

    if (!client.coach_id) {
      throw new BadRequestException({ error: 'COACH_NOT_ASSIGNED', message: 'No coach assigned to this client.' });
    }

    const packageId = input.package_id;
    const pkg = await this.prisma.coachPackage.findFirst({
      where: {
        id: packageId,
        coach_id: client.coach_id,
        is_active: true,
        archived_at: null,
      },
    });
    if (!pkg) throw new NotFoundException({ error: 'PACKAGE_NOT_FOUND', message: 'Package not found or not available.' });

    const coach = await this.prisma.user.findUnique({
      where: { id: pkg.coach_id },
      select: { id: true, email: true, name: true },
    });
    if (!coach) {
      throw new NotFoundException({
        error: 'COACH_NOT_FOUND',
        message: 'Coach for this package no longer exists',
      });
    }

    const connectAccount = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: pkg.coach_id },
    });
    if (!connectAccount) {
      throw new ConflictException({
        error: 'COACH_NOT_CONNECTED',
        message:
          'The coach has not connected a Stripe account yet. Ask them to complete Stripe Connect onboarding.',
      });
    }
    if (!connectAccount.charges_enabled || connectAccount.deauthorized_at) {
      throw new ConflictException({
        error: 'COACH_NOT_PAYOUT_READY',
        message:
          'The coach has not finished Stripe onboarding. Charges are not yet enabled on their account.',
      });
    }

    const customer = await this.ensureCustomer(client.id, client.email, client.name);

    const plan = await this.feePolicy.planFor(coach.id, pkg.amount_cents);
    const applicationFeeForStripe =
      plan.application_fee_cents + plan.head_coach_split_cents;

    const dayBucket = new Date().toISOString().slice(0, 10);
    const idempotencyKey = `pi-${client.id}-${pkg.id}-${dayBucket}`;

    // Write the ClientPurchase row in status=pending BEFORE calling Stripe.
    // This is the outbox pattern: if Stripe succeeds but our DB write fails,
    // the purchase is still auditable via Stripe metadata + idempotency key.
    // If the DB write fails here, no money is moved — safe to surface the error.
    //
    // stripe_payment_intent_id is left null until Stripe returns the PI id;
    // the webhook (payment_intent.succeeded) also upserts it, so both paths
    // converge correctly.
    let purchase = await this.prisma.clientPurchase.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    if (!purchase) {
      purchase = await this.prisma.clientPurchase.create({
        data: {
          client_user_id: client.id,
          coach_user_id: coach.id,
          package_id: pkg.id,
          amount_cents: pkg.amount_cents,
          currency: pkg.currency,
          billing_type: pkg.billing_type,
          stripe_checkout_session_id: idempotencyKey, // placeholder until PI id known
          stripe_customer_id: customer.stripe_customer_id,
          stripe_destination_account: connectAccount.stripe_account_id,
          status: 'pending',
          entitlement_active: false,
          idempotency_key: idempotencyKey,
        },
      });
    }

    const [paymentIntent, ephemeralKey] = await Promise.all([
      this.stripeConnect.createPaymentIntent({
        amount: pkg.amount_cents,
        currency: pkg.currency,
        customer: customer.stripe_customer_id,
        applicationFeeAmount: applicationFeeForStripe,
        transferDestination: connectAccount.stripe_account_id,
        metadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_platform_fee_cents: String(plan.application_fee_cents),
          tgp_head_coach_split_cents: String(plan.head_coach_split_cents),
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
        },
        idempotencyKey,
      }),
      this.stripeConnect.createEphemeralKey(customer.stripe_customer_id),
    ]);

    // Stripe returned successfully — patch the real PI id onto the row.
    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        stripe_checkout_session_id: paymentIntent.id,
        stripe_payment_intent_id: paymentIntent.id,
      },
    });

    return {
      client_secret: paymentIntent.client_secret,
      ephemeral_key: ephemeralKey.secret,
      customer_id: customer.stripe_customer_id,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
    };
  }

  // List purchases for a client (their own bought packages).
  // Hard cap at 100 rows; cursor-based pagination via `cursor` (purchase id).
  // Clients rarely have more than a handful of purchases so this is mostly
  // a safety guard against unbounded growth causing slow queries.
  //
  // M11 fix: fetch limit+1 rows to detect whether a next page exists.
  // Previously the cursor was set to the last row id whenever any rows were
  // returned, which implied a next page even when the result was the exact
  // final page. Now `next_cursor` is only non-null when there are truly
  // more rows beyond the returned page.
  async listForClient(
    clientUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: ClientPurchase[]; hasMore: boolean }> {
    const take = Math.min(opts.limit ?? 50, 100);
    const rows = await this.prisma.clientPurchase.findMany({
      where: { client_user_id: clientUserId },
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    return { items: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  // List purchases on a coach's roster (for revenue / activity views).
  // Cap at 100 rows per page. Revenue views page through this with a cursor.
  //
  // M11 fix: same limit+1 probe pattern as listForClient.
  async listForCoach(
    coachUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: ClientPurchase[]; hasMore: boolean }> {
    const take = Math.min(opts.limit ?? 50, 100);
    const rows = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: coachUserId },
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    return { items: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  // Entitlement check: does this client currently have an active purchase
  // for this package (or any package from this coach)?
  async hasActiveEntitlement(
    clientUserId: string,
    opts: { packageId?: string; coachUserId?: string },
  ): Promise<boolean> {
    const now = new Date();
    const row = await this.prisma.clientPurchase.findFirst({
      where: {
        client_user_id: clientUserId,
        entitlement_active: true,
        ...(opts.packageId ? { package_id: opts.packageId } : {}),
        ...(opts.coachUserId ? { coach_user_id: opts.coachUserId } : {}),
        OR: [
          { access_expires_at: null },
          { access_expires_at: { gt: now } },
        ],
      },
      select: { id: true },
    });
    return !!row;
  }

  // Create a Stripe Billing Portal session for a client so they can
  // update their payment method during dunning. The portal URL is
  // Stripe-hosted and short-lived (single use, expires after the session
  // redirect). We store no URL in the DB — each request mints a fresh one.
  //
  // M10 fix: this allows past-due clients to self-serve card updates
  // without contacting their coach.
  async createBillingPortalSession(
    clientUserId: string,
  ): Promise<{ url: string }> {
    this.assertReady();

    const customer = await this.prisma.connectCustomer.findUnique({
      where: { client_user_id: clientUserId },
    });
    if (!customer) {
      throw new NotFoundException({
        error: 'CUSTOMER_NOT_FOUND',
        message: 'No Stripe customer record found for this client. Purchase a package first.',
      });
    }

    const session = await this.stripeConnect.createBillingPortalSession({
      customerId: customer.stripe_customer_id,
      returnUrl: 'com.growthproject.app://settings',
    });
    return { url: session.url };
  }

  // Confirm a specific Stripe Checkout session and return its payment status.
  // This is called after the client returns from the Stripe-hosted page via
  // the success deep-link so the app can confirm the session actually belongs
  // to this user and what the payment status is.
  async confirmSession(
    sessionId: string,
    userId: string,
  ): Promise<{ paid: boolean; status: string; package_name: string | null }> {
    // 1. Fetch the Stripe session
    const session = await this.stripeConnect.retrieveCheckoutSession(sessionId);

    // 2. Verify it belongs to this user by checking our purchase row.
    //    We do NOT trust Stripe metadata alone — the purchase row is our
    //    authoritative ledger that the session was minted for this client.
    const purchase = await this.prisma.clientPurchase.findFirst({
      where: {
        stripe_checkout_session_id: sessionId,
        client_user_id: userId,
      },
      include: { package: { select: { name: true } } },
    });

    // Coerce Stripe's typed enum to a plain string for the response shape.
    const stripeStatus: string = (session.payment_status as string | null | undefined) ?? 'unknown';

    if (!purchase) {
      // Session doesn't exist in our DB for this user — could be a stale
      // link from a different user or an unknown session id.
      return { paid: false, status: stripeStatus, package_name: null };
    }

    const paid =
      stripeStatus === 'paid' ||
      purchase.entitlement_active ||
      purchase.status === 'paid' ||
      purchase.status === 'active';

    const pkgWithRelation = purchase as typeof purchase & { package?: { name: string } | null };
    return {
      paid,
      status: stripeStatus,
      package_name: pkgWithRelation.package?.name ?? null,
    };
  }

  // Saved-card listing for a client. Reads ConnectCustomer mirror only —
  // never touches Stripe synchronously on this read path. Returns the
  // default card metadata (single source of truth for the mobile billing
  // screen). Phase 4 will add multi-card listing if needed.
  async getSavedPaymentMethodForClient(
    clientUserId: string,
  ): Promise<{
    stripe_customer_id: string | null;
    default_card: {
      brand: string;
      last4: string;
      exp_month: number;
      exp_year: number;
    } | null;
  }> {
    const row = await this.prisma.connectCustomer.findUnique({
      where: { client_user_id: clientUserId },
    });
    if (!row) {
      return { stripe_customer_id: null, default_card: null };
    }
    const hasCard =
      !!row.default_card_brand &&
      !!row.default_card_last4 &&
      !!row.default_card_exp_month &&
      !!row.default_card_exp_year;
    return {
      stripe_customer_id: row.stripe_customer_id,
      default_card: hasCard
        ? {
            brand: row.default_card_brand!,
            last4: row.default_card_last4!,
            exp_month: row.default_card_exp_month!,
            exp_year: row.default_card_exp_year!,
          }
        : null,
    };
  }

  // --- Internal helpers ---

  private async ensureCustomer(
    clientUserId: string,
    email: string | null | undefined,
    name: string | null | undefined,
  ): Promise<ConnectCustomer> {
    const existing = await this.prisma.connectCustomer.findUnique({
      where: { client_user_id: clientUserId },
    });
    if (existing) return existing;

    const customer = await this.stripeConnect.createCustomer({
      email: email ?? undefined,
      name: name ?? undefined,
      metadata: { tgp_client_user_id: clientUserId },
      idempotencyKey: `customer-${clientUserId}`,
    });

    // Race: two concurrent checkouts could both try to insert. Catch
    // P2002 and re-read.
    try {
      return await this.prisma.connectCustomer.create({
        data: {
          client_user_id: clientUserId,
          stripe_customer_id: customer.id,
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const row = await this.prisma.connectCustomer.findUnique({
          where: { client_user_id: clientUserId },
        });
        if (row) return row;
      }
      throw err;
    }
  }

  private async ensurePriceForPackage(pkg: CoachPackage): Promise<string> {
    if (pkg.stripe_price_id) return pkg.stripe_price_id;

    // Need a Product first. Reuse the cached product if we have one (e.g.
    // when the price was cleared due to amount change but the product
    // identity is still valid).
    let productId = pkg.stripe_product_id;
    if (!productId) {
      const product = await this.stripeConnect.createProduct({
        name: pkg.name,
        description: pkg.description ?? undefined,
        metadata: { tgp_package_id: pkg.id, tgp_coach_user_id: pkg.coach_id },
        idempotencyKey: `product-${pkg.id}`,
      });
      productId = product.id;
    }

    const price = await this.stripeConnect.createPrice({
      product: productId,
      unit_amount: pkg.amount_cents,
      currency: pkg.currency,
      recurring:
        pkg.billing_type === 'recurring' && pkg.interval
          ? {
              interval: pkg.interval as 'month' | 'year',
              interval_count: pkg.interval_count,
            }
          : undefined,
      metadata: { tgp_package_id: pkg.id },
      // Vary the idempotency key by amount so a re-price after a clear
      // does not collapse onto the old Price.
      idempotencyKey: `price-${pkg.id}-${pkg.amount_cents}-${pkg.currency}-${pkg.billing_type}-${pkg.interval ?? 'na'}-${pkg.interval_count}`,
    });

    await this.packages.setStripeIds(pkg.id, {
      stripe_product_id: productId,
      stripe_price_id: price.id,
    });
    return price.id;
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    if (typeof e.message === 'string' && /unique constraint/i.test(e.message)) {
      return true;
    }
    return false;
  }

  /**
   * Convert a target application-fee-cents figure into the Stripe
   * `application_fee_percent` value with the smallest representable
   * over-collection. Stripe restricts percent precision to 2 decimal
   * places, so we ceiling-round at hundredths to guarantee
   *   round( percent/100 * amount_cents ) >= target_cents
   * across the full range of plausible subscription amounts.
   *
   * Exported via `static` so the unit test can pin the rounding without
   * needing a full service instance.
   */
  static toStripeApplicationFeePercent(
    targetFeeCents: number,
    amountCents: number,
  ): number {
    if (amountCents <= 0 || targetFeeCents <= 0) return 0;
    // Solve for the smallest 2-dp `percent` such that
    //   Math.round(percent / 100 * amountCents) >= targetFeeCents
    // i.e. Stripe's rounding (half-up to whole cents) never under-
    // collects vs the bps target.
    //
    // Using integer math at hundredths-of-a-percent (== basis points)
    // avoids IEEE-754 drift that the previous .toFixed(2) had on
    // amounts whose exact ratio fell on a *.5 boundary
    // (e.g. (15/999)*100 = 1.5015015..., (0.015).toFixed(2) drifts
    // between engines under banker's rounding).
    //
    //   percentHundredths = ceil( targetFeeCents * 10_000 / amountCents )
    //   percent           = percentHundredths / 100
    //
    // Over-collection upper bound per renewal: less than amountCents /
    // 10_000 cents (sub-cent for sub-$100 subscriptions). The
    // reconciliation job folds any pennies of drift into the monthly
    // platform statement.
    const percentHundredths = Math.ceil(
      (targetFeeCents * 10_000) / amountCents,
    );
    return percentHundredths / 100;
  }

  private toStripeApplicationFeePercent(
    targetFeeCents: number,
    amountCents: number,
  ): number {
    return CheckoutService.toStripeApplicationFeePercent(
      targetFeeCents,
      amountCents,
    );
  }

  private assertReady() {
    if (!this.state.ready) {
      throw new ServiceUnavailableException({
        error: 'CONNECT_NOT_CONFIGURED',
        message:
          this.state.reason ??
          'Stripe Connect is not configured on this environment. See docs/connect-setup.md.',
      });
    }
  }
}
