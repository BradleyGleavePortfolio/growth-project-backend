import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientPurchase, CoachPackage, ConnectCustomer } from '@prisma/client';
import { ConnectModuleState } from '../connect/connect.module-state';
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

    // Soft check: client must already be assigned to the coach. This
    // prevents random users from buying packages from coaches they don't
    // have a relationship with. Owners are allowed regardless.
    if (client.coach_id && client.coach_id !== coach.id) {
      // Allow it but log — the client may be switching coaches and the
      // assignment will update post-purchase. Hard-blocking would break
      // the marketplace flow.
      this.logger.log(
        `client=${client.id} buying from coach=${coach.id} but assigned to coach=${client.coach_id}`,
      );
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
        clientReferenceId: client.id,
        metadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
        },
        subscriptionMetadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
        },
        paymentIntentMetadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
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

  // List purchases for a client (their own bought packages).
  async listForClient(clientUserId: string): Promise<ClientPurchase[]> {
    return this.prisma.clientPurchase.findMany({
      where: { client_user_id: clientUserId },
      orderBy: { created_at: 'desc' },
    });
  }

  // List purchases on a coach's roster (for revenue / activity views).
  async listForCoach(coachUserId: string): Promise<ClientPurchase[]> {
    return this.prisma.clientPurchase.findMany({
      where: { coach_user_id: coachUserId },
      orderBy: { created_at: 'desc' },
    });
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
