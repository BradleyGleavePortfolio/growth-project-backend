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

    const pkg = await this.packages.getById(input.package_id);
    if (!pkg || !pkg.is_active || pkg.archived_at) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
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

    // Hard-block IDOR (P0 — Audit #2): only a client already assigned to
    // the package-selling coach may buy. Returns non-leaking 404 so we
    // never confirm that the package exists on another coach.
    if (!client.coach_id || client.coach_id !== pkg.coach_id) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }

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
      'growthproject://checkout/success?session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl =
      input.cancel_url ??
      process.env.STRIPE_CHECKOUT_CANCEL_URL ??
      'growthproject://checkout/cancel';

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
  //
  // Authorization model (P0 — Audit #1):
  //   * Caller MUST be a client with `coach_id` already set.
  //   * Caller MUST be buying a package owned by THEIR assigned coach.
  // Any mismatch or unassigned-client case resolves to a generic
  // PACKAGE_NOT_FOUND (NotFoundException) — never leak that the package
  // exists on another coach. Guest checkout / coach switching is Wave 4
  // and is intentionally NOT supported here.
  //
  // Idempotency (R19):
  //   * Caller MUST supply a UUID `idempotency_key` per logical user action.
  //   * Server dedupes by (client_user_id, idempotency_key) in
  //     ClientPurchase. On dedup the existing client_secret is returned and
  //     Stripe is NOT called a second time.
  //   * The Stripe `Idempotency-Key` header includes the client key so a
  //     retry collapses on Stripe's side as well.
  async createPaymentIntentForClient(
    clientUserId: string,
    input: { package_id: string; idempotency_key: string },
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
    if (!input?.idempotency_key) {
      throw new BadRequestException({
        error: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'idempotency_key is required',
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

    // Hard-block unassigned clients. Guest / pre-assignment purchase is
    // Wave 4 work and is not enabled on this endpoint.
    if (!client.coach_id) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }

    const pkg = await this.packages.getById(input.package_id);
    if (!pkg || !pkg.is_active || pkg.archived_at) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }

    // Hard-block cross-coach purchase (P0 IDOR fix). Returns 404 — never
    // confirm to the client that the package exists on another coach.
    if (pkg.coach_id !== client.coach_id) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }

    // Idempotent replay: same (client, key) → return cached secret without
    // re-hitting Stripe. The stored key is namespaced by client id so
    // cross-client collisions on a leaked UUID still fail loudly via the
    // unique constraint.
    //
    // Concurrency-safe pattern (P1-8 — Audit #2):
    //   1. Pre-check for an already-completed row — fast path for retries.
    //   2. Attempt to INSERT a pending reservation row with the namespaced
    //      idempotency key BEFORE calling Stripe. The unique constraint
    //      acts as a single-flight gate: only one concurrent request wins.
    //   3. The winner proceeds to call Stripe and updates its own row.
    //   4. Losers (P2002) re-read the existing row and poll briefly for
    //      the winner's `stripe_client_secret`, then return the cached
    //      values without making their own Stripe calls.
    const purchaseIdempotencyKey = `pi-${client.id}-${input.idempotency_key}`;
    const existing = await this.prisma.clientPurchase.findUnique({
      where: { idempotency_key: purchaseIdempotencyKey },
    });
    if (
      existing &&
      existing.client_user_id === client.id &&
      existing.stripe_client_secret
    ) {
      return {
        client_secret: existing.stripe_client_secret,
        ephemeral_key: existing.stripe_ephemeral_key ?? '',
        customer_id: existing.stripe_customer_id ?? '',
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
      };
    }

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

    // Reserve the idempotency key BEFORE any Stripe call. The unique
    // constraint on `idempotency_key` is the single-flight gate. The
    // `stripe_checkout_session_id` column is also unique and required —
    // we seed it with a deterministic placeholder derived from the same
    // key so two concurrent reservations collide on either constraint.
    const placeholderSessionId = `pi-reserved-${purchaseIdempotencyKey}`;
    let reservation: ClientPurchase | null = null;
    try {
      reservation = await this.prisma.clientPurchase.create({
        data: {
          client_user_id: client.id,
          coach_user_id: coach.id,
          package_id: pkg.id,
          amount_cents: pkg.amount_cents,
          currency: pkg.currency,
          billing_type: pkg.billing_type,
          stripe_checkout_session_id: placeholderSessionId,
          stripe_destination_account: connectAccount.stripe_account_id,
          status: 'pending',
          entitlement_active: false,
          idempotency_key: purchaseIdempotencyKey,
        },
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      // Lost the race. Another concurrent request is creating the Stripe
      // resources right now; poll briefly for it to publish its secret.
      const winner = await this.waitForReservedSecret(purchaseIdempotencyKey);
      if (winner && winner.stripe_client_secret) {
        return {
          client_secret: winner.stripe_client_secret,
          ephemeral_key: winner.stripe_ephemeral_key ?? '',
          customer_id: winner.stripe_customer_id ?? '',
          publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
        };
      }
      // P1-A: `null` means the winner failed and cleaned up its
      // reservation, so the idempotency key is now free again. Surface
      // a retryable error (not the generic "in progress") so the mobile
      // client retries with the same key and becomes the new winner.
      if (winner === null) {
        throw new ServiceUnavailableException({
          error: 'PAYMENT_RETRY',
          message:
            'The previous attempt for this payment failed. Please try again.',
        });
      }
      throw new ServiceUnavailableException({
        error: 'PAYMENT_IN_PROGRESS',
        message:
          'A previous request for this payment is still being processed. Please try again in a moment.',
      });
    }

    // We won the race — proceed to create Stripe resources and update
    // our reservation row with the real Stripe identifiers.
    //
    // Failure-recovery (P1-A — Audit #3): if anything between here and
    // publishing `stripe_client_secret` throws, we MUST drop the
    // reservation row. Otherwise a stale "reserved-but-no-secret" row
    // permanently poisons the client's idempotency key: every subsequent
    // retry loses the unique-constraint race and waits in
    // `waitForReservedSecret` forever. Deleting the row lets the next
    // same-key retry become the new winner.
    //
    // We chose the simpler delete-on-failure recovery over a full
    // reserved/processing/failed state machine — same correctness
    // guarantee with far less surface area on a money-moving path.
    try {
      const customer = await this.ensureCustomer(client.id, client.email, client.name);

      const plan = await this.feePolicy.planFor(coach.id, pkg.amount_cents);
      const applicationFeeForStripe =
        plan.application_fee_cents + plan.head_coach_split_cents;

      // Stripe idempotency key derived from the client-supplied UUID. Same
      // client + same key → Stripe collapses to the same PaymentIntent.
      const stripeIdempotencyKey = `stripe-idempotency-${client.id}-${input.idempotency_key}`;

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
          idempotencyKey: stripeIdempotencyKey,
        }),
        this.stripeConnect.createEphemeralKey(
          customer.stripe_customer_id,
          `${stripeIdempotencyKey}-ephkey`,
        ),
      ]);

      await this.prisma.clientPurchase.update({
        where: { id: reservation.id },
        data: {
          stripe_checkout_session_id: paymentIntent.id,
          stripe_payment_intent_id: paymentIntent.id,
          stripe_customer_id: customer.stripe_customer_id,
          stripe_client_secret: paymentIntent.client_secret,
          stripe_ephemeral_key: ephemeralKey.secret,
        },
      });

      return {
        client_secret: paymentIntent.client_secret,
        ephemeral_key: ephemeralKey.secret,
        customer_id: customer.stripe_customer_id,
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
      };
    } catch (err) {
      // Best-effort cleanup. Drop the poisoned reservation so a retry
      // with the same client idempotency key can succeed. If the delete
      // itself fails (rare — e.g. row already moved by a webhook), log
      // and re-throw the original Stripe error so the caller can retry.
      try {
        await this.prisma.clientPurchase.delete({
          where: { id: reservation.id },
        });
      } catch (cleanupErr) {
        this.logger.error(
          `Failed to clean up poisoned reservation ${reservation.id}: ${(cleanupErr as Error).message}`,
        );
      }
      throw err;
    }
  }

  // Poll for a concurrent winner's PaymentIntent client_secret to be
  // published on the reservation row. Used by losers of the
  // idempotency-key race to return the same client_secret without
  // making their own Stripe calls.
  //
  // Returns the winner row when `stripe_client_secret` is published.
  // Returns `null` if the reservation disappears (winner failed and
  // cleaned up — P1-A) so the caller can surface a retryable error
  // instead of waiting the full timeout.
  private async waitForReservedSecret(
    idempotencyKey: string,
    timeoutMs = 5_000,
    intervalMs = 100,
  ): Promise<ClientPurchase | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = await this.prisma.clientPurchase.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      if (row?.stripe_client_secret) return row;
      // Winner cleaned up after a failure — bail out early.
      if (!row) return null;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return await this.prisma.clientPurchase.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
  }

  // List purchases for a client (their own bought packages).
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

    const returnUrl = process.env.STRIPE_BILLING_PORTAL_RETURN_URL ?? 'com.growthproject.app://settings';
    const session = await this.stripeConnect.createBillingPortalSession({
      customerId: customer.stripe_customer_id,
      returnUrl,
    });
    return { url: session.url };
  }

  async confirmSession(
    sessionId: string,
    userId: string,
  ): Promise<{ paid: boolean; status: string; package_name: string | null }> {
    // IDOR defense: prove the session belongs to the caller against our own
    // ClientPurchase row BEFORE consulting Stripe. If no scoped purchase
    // exists, throw 404 without leaking whether the session ID exists at
    // Stripe — this collapses "foreign session" and "nonexistent session"
    // into a single response so a logged-in user cannot enumerate other
    // users' Stripe Checkout Sessions or probe their payment_status.
    const purchase = await this.prisma.clientPurchase.findFirst({
      where: {
        stripe_checkout_session_id: sessionId,
        client_user_id: userId,
      },
      include: { package: { select: { name: true } } },
    });

    if (!purchase) {
      throw new NotFoundException({
        error: 'CHECKOUT_SESSION_NOT_FOUND',
        message: 'No checkout session with that id for this account.',
      });
    }

    // Local ownership is proven; safe to ask Stripe for live status.
    const session = await this.stripeConnect.retrieveCheckoutSession(sessionId);

    // Defense-in-depth: if Stripe set client_reference_id and it disagrees
    // with the caller, treat as a missing session — never leak the
    // mismatch in the response. (Legacy sessions may have a null
    // client_reference_id; the local-purchase scope above is the
    // authoritative check in that case.)
    const clientRef = (session.client_reference_id as string | null | undefined) ?? null;
    if (clientRef !== null && clientRef !== userId) {
      this.logger.warn(
        `confirmSession client_reference_id mismatch sessionId=${sessionId} caller=${userId} sessionRef=${clientRef}`,
      );
      throw new NotFoundException({
        error: 'CHECKOUT_SESSION_NOT_FOUND',
        message: 'No checkout session with that id for this account.',
      });
    }

    const stripeStatus: string = (session.payment_status as string | null | undefined) ?? 'unknown';

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
