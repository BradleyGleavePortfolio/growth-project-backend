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
import { CheckoutContractGate } from '../contracts/checkout-contract-gate.service';
import { CLIENT_PURCHASE_SELECT, type ClientPurchaseView } from './client-purchases.select';
import { COACH_PURCHASE_SELECT, type CoachPurchaseView } from './coach-payments.select';
import { ContractRequiredException } from '../contracts/contract-required.exception';

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

// PR-15A — Buyer-visible drop row (matches the frozen typed contract PR-13
// shipped in mobile clientPaymentsApi.ts). Keep field names EXACTLY
// in sync with PR13_BUILD_REPORT.md §c so the mobile typed client can
// consume the envelope without remapping.
export interface BuyerDropView {
  id: string;
  asset_type: string;
  asset_id: string;
  asset_revision_id: string | null;
  cadence_kind: string;
  display_title: string | null;
  display_caption: string | null;
  fire_at: Date | null;
  fired_at: Date | null;
  // pending | due | fired. failed/canceled/skipped are filtered at the
  // SQL WHERE in listDropsForBuyer().
  status: string;
  materialised_ref: string | null;
}

// Defensive cap so a runaway CoachPackageContent table cannot OOM the
// drops endpoint. A single purchase's drop count is bounded by the
// authoring rows (one ScheduledDrop per CoachPackageContent), expected
// <50 in practice. 500 is well above any realistic package.
const DROP_LIST_HARD_CAP = 500;

/**
 * B-RECUR — true when buying this package starts a renewing charge: a
 * recurring package, or a one-time package with a recurring second price
 * (TWO_PACKAGE_DESIGN / PR-6 decision #1). Both are sold only as a Stripe
 * Subscription (POST /v1/checkout/subscription-intent).
 */
export function isRecurringPackage(
  pkg: Pick<CoachPackage, 'billing_type' | 'recurring_amount_cents' | 'recurring_interval'>,
): boolean {
  // A combo's recurring part of $0 renews nothing: it is a one-time sale
  // (B-RECUR-BE R1-3), sold through payment-intent like any one-time package.
  return (
    pkg.billing_type === 'recurring' ||
    (pkg.recurring_amount_cents != null &&
      pkg.recurring_amount_cents > 0 &&
      pkg.recurring_interval != null)
  );
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
    // B5 — two-layer contract gate. No-op when FEATURE_CONTRACTS_ENABLED is
    // OFF (the gate self-checks the flag), so existing checkout behavior for
    // non-`requires_contract` packages is unchanged.
    private contractGate: CheckoutContractGate,
  ) {}

  /**
   * B5 — Run the two-layer contract gate (platform waiver → coach service)
   * BEFORE any Stripe call. Throws ContractRequiredException (409) when a
   * required contract is not yet SIGNED — there is NO path to Stripe past an
   * unsigned required contract (spec §4.1). Returns the SIGNED coach envelope
   * id (if any) so the caller can bind it to the realized purchase post-pay.
   */
  // B-RECUR — public so the native subscription checkout runs the SAME gate.
  async runContractGate(args: {
    clientId: string;
    client: { email: string; name: string };
    pkg: CoachPackage;
    coach: { id: string; email: string; name: string };
  }): Promise<{ coachEnvelopeId?: string }> {
    const result = await this.contractGate.evaluate(args);
    if (!result.ok) {
      throw new ContractRequiredException({
        layer: result.layer,
        envelopeId: result.envelopeId,
        embedUrl: result.embedUrl,
        status: result.status,
      });
    }
    return { coachEnvelopeId: result.coachEnvelopeId };
  }

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
    if (!pkg || !pkg.is_active || pkg.archived_at || !pkg.published_at) {
      // PR-6 — DRAFT packages (published_at IS NULL) are not purchasable.
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }
    // Clinic C01 — $0 packages never reach Stripe (Stripe's floor is 50¢ and
    // there is nothing to charge). Clients claim them via
    // POST /v1/packages/:id/claim-free instead. Checked before any Stripe call.
    if (pkg.amount_cents === 0) {
      throw new BadRequestException({
        error: 'PACKAGE_IS_FREE',
        message: 'This package is free; claim it via /v1/packages/:id/claim-free',
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

    // B5 — two-layer contract gate (platform waiver → coach service). Runs
    // AFTER package + coach resolution and BEFORE any Stripe call. Throws 409
    // ContractRequiredException when a required contract is unsigned. No-op
    // when FEATURE_CONTRACTS_ENABLED is OFF (spec §4.1 / §E). The SIGNED coach
    // envelope id (if any) is bound to the realized ClientPurchase below,
    // mirroring the PaymentIntent path so both checkout flows persist the
    // contract→purchase linkage consistently.
    const contractGateResult = await this.runContractGate({
      clientId: client.id,
      client: { email: client.email, name: client.name ?? client.email },
      pkg,
      coach: { id: coach.id, email: coach.email, name: coach.name ?? '' },
    });

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

    // S-FEE: separate charges and transfers. The session charges on the
    // platform with on_behalf_of = the coach's connected account and carries
    // NO transfer_data / application fee. When the charge succeeds,
    // ChargeSettlementService reads Stripe's actual fee from the charge's
    // balance transaction and transfers the coach
    //   price - actual Stripe fee - TGP 2% (- head-coach split).
    // The plan is a pre-charge preview (metadata + policy validation only).
    const plan = await this.feePolicy.planFor(coach.id, pkg.amount_cents);

    let session;
    try {
      session = await this.stripeConnect.createCheckoutSession({
        mode,
        customer: customer.stripe_customer_id,
        priceId,
        quantity: 1,
        successUrl,
        cancelUrl,
        onBehalfOf: connectAccount.stripe_account_id,
        clientReferenceId: client.id,
        metadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_platform_fee_cents: String(plan.application_fee_cents),
          tgp_head_coach_split_cents: String(plan.head_coach_split_cents),
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
          tgp_fee_mechanism: 'separate_charge_transfer',
        },
        subscriptionMetadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
          tgp_fee_mechanism: 'separate_charge_transfer',
        },
        paymentIntentMetadata: {
          tgp_client_user_id: client.id,
          tgp_coach_user_id: coach.id,
          tgp_package_id: pkg.id,
          tgp_platform_fee_cents: String(plan.application_fee_cents),
          tgp_head_coach_split_cents: String(plan.head_coach_split_cents),
          tgp_head_coach_user_id: plan.head_coach_id ?? '',
          tgp_fee_mechanism: 'separate_charge_transfer',
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
        // B5 — bind the SIGNED coach-service envelope to this purchase. Set
        // at create (the envelope is already SIGNED before the gate cleared);
        // null for non-`requires_contract` packages. The FK is @unique so the
        // same envelope can never bind to two purchases.
        contract_envelope_id: contractGateResult.coachEnvelopeId ?? null,
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
    if (!pkg || !pkg.is_active || pkg.archived_at || !pkg.published_at) {
      // PR-6 — DRAFT packages (published_at IS NULL) are not purchasable.
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }
    // Clinic C01 — $0 packages never reach Stripe (Stripe's floor is 50¢ and
    // there is nothing to charge). Clients claim them via
    // POST /v1/packages/:id/claim-free instead. Checked before any Stripe call.
    if (pkg.amount_cents === 0) {
      throw new BadRequestException({
        error: 'PACKAGE_IS_FREE',
        message: 'This package is free; claim it via /v1/packages/:id/claim-free',
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

    // B-RECUR (OR-113-1) — a renewing plan is never sold as one charge. A
    // recurring package, or a one-time package with a recurring second price
    // (one charge today + a subscription), must go through
    // POST /v1/checkout/subscription-intent. Checked before any Stripe call
    // and before the idempotent replay, so no PaymentIntent is ever minted.
    if (isRecurringPackage(pkg)) {
      throw new ConflictException({
        code: 'RECURRING_REQUIRES_SUBSCRIPTION',
        error: 'RECURRING_REQUIRES_SUBSCRIPTION',
        message:
          'This plan renews, so it is set up as a subscription. Update the app to start it, or message your coach.',
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

    // B5 — two-layer contract gate (platform waiver → coach service). Runs
    // BEFORE the reservation row + any Stripe call: a 409 here means no
    // PaymentIntent is ever created for an unsigned required contract (spec
    // §4.1). No-op when FEATURE_CONTRACTS_ENABLED is OFF. The returned SIGNED
    // coach envelope id (if any) is bound to the realized purchase post-pay.
    const contractGateResult = await this.runContractGate({
      clientId: client.id,
      client: { email: client.email, name: client.name ?? client.email },
      pkg,
      coach: { id: coach.id, email: coach.email, name: coach.name ?? '' },
    });

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
          // B5 — bind the SIGNED coach-service envelope to this purchase. Set
          // at reservation (the envelope is already SIGNED before the gate
          // cleared); null for non-`requires_contract` packages. The FK is
          // @unique so the same envelope can never bind to two purchases.
          contract_envelope_id: contractGateResult.coachEnvelopeId ?? null,
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

      // S-FEE: preview only (metadata + policy validation). No application
      // fee / transfer_data on the PaymentIntent; the coach is paid by
      // ChargeSettlementService from the charge's actual Stripe fee.
      const plan = await this.feePolicy.planFor(coach.id, pkg.amount_cents);

      // Stripe idempotency key derived from the client-supplied UUID. Same
      // client + same key → Stripe collapses to the same PaymentIntent.
      const stripeIdempotencyKey = `stripe-idempotency-${client.id}-${input.idempotency_key}`;

      const [paymentIntent, ephemeralKey] = await Promise.all([
        this.stripeConnect.createPaymentIntent({
          amount: pkg.amount_cents,
          currency: pkg.currency,
          customer: customer.stripe_customer_id,
          // Audit #3 P1-10 — connected coach is the settlement merchant
          // for risk and statement-descriptor purposes.
          onBehalfOf: connectAccount.stripe_account_id,
          transferGroup: `purchase_${reservation.id}`,
          metadata: {
            tgp_client_user_id: client.id,
            tgp_coach_user_id: coach.id,
            tgp_package_id: pkg.id,
            tgp_platform_fee_cents: String(plan.application_fee_cents),
            tgp_head_coach_split_cents: String(plan.head_coach_split_cents),
            tgp_head_coach_user_id: plan.head_coach_id ?? '',
            tgp_fee_mechanism: 'separate_charge_transfer',
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
  //
  // OR-112-19: explicit allow-list, never the raw row. The row caches the
  // PaymentIntent client_secret / ephemeral key for idempotent replay; the
  // app never reads them from this list (it resumes a payment through
  // createPaymentIntentForClient with the same idempotency key), so no
  // purchase in this list carries a secret, whatever its status.
  async listForClient(
    clientUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: ClientPurchaseView[]; hasMore: boolean }> {
    const take = Math.min(opts.limit ?? 50, 100);
    const rows = await this.prisma.clientPurchase.findMany({
      where: { client_user_id: clientUserId },
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: CLIENT_PURCHASE_SELECT,
    });
    const hasMore = rows.length > take;
    return { items: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  // PR-15A — Buyer-visible drops feed.
  //
  // Returns the buyer's scheduled drops for a purchase they own. Powers
  // the mobile PurchaseUnpackScreen + Deliverables tab (PR-13's frozen
  // typed contract) and the SSR thank-you page (A3).
  //
  // Auth/IDOR contract (matches the requireOwned pattern in
  // coach-media.service.ts:623): a cross-user purchaseId — or a purchase
  // that does not exist — both return 404 (NEVER 403). We never confirm
  // the existence of another buyer's purchase.
  //
  // Filter: status IN ('pending','due','fired'). failed/canceled/skipped
  // rows are filtered AT THE SQL WHERE — master plan §1 #10 routes those
  // to COACH_ALERT, never the buyer. Filtering server-side means a
  // failed drop never even leaves the DB.
  //
  // Order: COALESCE(fired_at, fire_at, created_at) ASC. Because we cannot
  // express COALESCE directly through Prisma's orderBy DSL, we hydrate
  // the rows in one query (no N+1 — no per-row joins, just the columns
  // we ship) and sort in JS by the same COALESCE expression. The take cap
  // (DROP_LIST_HARD_CAP) is defensive — a single purchase's drop count is
  // bounded by package_contents and we expect <50 in practice; the cap
  // exists so a runaway content table cannot OOM this endpoint.
  async listDropsForBuyer(
    buyerUserId: string,
    purchaseId: string,
  ): Promise<{ drops: BuyerDropView[] }> {
    // requireOwned pattern — cross-user purchase or non-existent purchase
    // both return 404. We never leak which case it is.
    const purchase = await this.prisma.clientPurchase.findFirst({
      where: { id: purchaseId, client_user_id: buyerUserId },
      select: { id: true },
    });
    if (!purchase) {
      throw new NotFoundException({
        error: 'PURCHASE_NOT_FOUND',
        message: 'No purchase with that id for this account.',
      });
    }

    // SQL WHERE filter — failed/canceled/skipped never leave the DB.
    // Single query (no N+1); only the columns we ship.
    const rows = await this.prisma.scheduledDrop.findMany({
      where: {
        client_purchase_id: purchaseId,
        status: { in: ['pending', 'due', 'fired'] },
      },
      take: DROP_LIST_HARD_CAP,
      select: {
        id: true,
        asset_type: true,
        asset_id: true,
        asset_revision_id: true,
        cadence_kind: true,
        display_title: true,
        display_caption: true,
        fire_at: true,
        fired_at: true,
        status: true,
        materialised_ref: true,
        created_at: true,
      },
    });

    // COALESCE(fired_at, fire_at, created_at) ASC — in-memory because
    // Prisma cannot express COALESCE in orderBy. Rows are already bounded
    // by DROP_LIST_HARD_CAP so the sort is O(n log n) of a small n.
    const sorted = rows.slice().sort((a, b) => {
      const aTs = (a.fired_at ?? a.fire_at ?? a.created_at).getTime();
      const bTs = (b.fired_at ?? b.fire_at ?? b.created_at).getTime();
      return aTs - bTs;
    });

    return {
      drops: sorted.map((d) => ({
        id: d.id,
        asset_type: d.asset_type,
        asset_id: d.asset_id,
        asset_revision_id: d.asset_revision_id,
        cadence_kind: d.cadence_kind,
        display_title: d.display_title,
        display_caption: d.display_caption,
        fire_at: d.fire_at,
        fired_at: d.fired_at,
        status: d.status,
        // Rule 18: never fabricate. PR-9 only stamps materialised_ref
        // after a successful inline materialisation, so pending/due rows
        // carry null. Re-export the column as-is.
        materialised_ref: d.materialised_ref,
      })),
    };
  }

  // List purchases on a coach's roster (for revenue / activity views).
  //
  // C-641-2 / OR-112-19: GET /v1/coach/purchases is a coach route, so it uses
  // the coach allow-list; the raw row carries the CLIENT's Stripe secrets.
  async listForCoach(
    coachUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: CoachPurchaseView[]; hasMore: boolean }> {
    const take = Math.min(opts.limit ?? 50, 100);
    const rows = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: coachUserId },
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: COACH_PURCHASE_SELECT,
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

  // B-RECUR — public so the native subscription checkout reuses the same
  // Customer (one ConnectCustomer per client, idempotent Stripe create).
  async ensureCustomer(
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

  // PR-14 — promoted from private to public so the guest storefront can
  // share the SAME price-resolution logic (master-plan §1 decision #1
  // requires recurring on web; the brief explicitly forbids duplicating
  // price-creation logic). Stripe calls live here so they STAY out of
  // any caller's Prisma $transaction (50-Failures #44 / A276-P1-3).
  //
  // Returns the primary `stripe_price_id`. For one-time+recurring combo
  // packages, use `ensureRecurringPriceForPackage` separately to lazily
  // mint the companion Price.
  async ensurePriceForPackage(pkg: CoachPackage): Promise<string> {
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

    // PR-14 R2 P2-2 — runtime guard before the cast. `CoachPackage.interval`
    // is a free-form `String?` in Prisma; a corrupt row (e.g. 'daily' from
    // a future migration) would propagate to Stripe and surface an opaque
    // 400. Fail loudly here with a typed error instead.
    const intervalForStripe =
      pkg.billing_type === 'recurring' && pkg.interval
        ? CheckoutService.assertStripeInterval(pkg.interval, pkg.id)
        : undefined;

    const price = await this.stripeConnect.createPrice({
      product: productId,
      unit_amount: pkg.amount_cents,
      currency: pkg.currency,
      recurring: intervalForStripe
        ? {
            interval: intervalForStripe,
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

  // PR-14 — companion recurring Price for one-time+recurring combo
  // packages (PR-6 decision #1). The PRIMARY price is one-time; the
  // companion is the subscription that begins after first invoice. We
  // reuse the same Stripe Product so the Stripe Dashboard groups both
  // prices under one product. Idempotency-key varies by amount/interval
  // so a coach editing recurring_amount_cents mid-flight gets a fresh
  // Price on the next purchase (the cached id is cleared by
  // PackagesService.update() when recurring_* fields change).
  //
  // Throws if the package has no recurring companion configured — caller
  // is responsible for the guard.
  async ensureRecurringPriceForPackage(pkg: CoachPackage): Promise<string> {
    if (pkg.recurring_stripe_price_id) return pkg.recurring_stripe_price_id;
    if (
      pkg.recurring_amount_cents == null ||
      !pkg.recurring_interval
    ) {
      throw new Error(
        `ensureRecurringPriceForPackage called on package ${pkg.id} without recurring companion`,
      );
    }

    let productId = pkg.stripe_product_id;
    if (!productId) {
      const product = await this.stripeConnect.createProduct({
        name: pkg.name,
        description: pkg.description ?? undefined,
        metadata: { tgp_package_id: pkg.id, tgp_coach_user_id: pkg.coach_id },
        idempotencyKey: `product-${pkg.id}`,
      });
      productId = product.id;
      // Cache the product id alone so a subsequent one-time-price mint
      // reuses it. We deliberately DO NOT touch stripe_price_id — the
      // one-time price is created lazily by ensurePriceForPackage when
      // first needed.
      await this.packages.setStripeProductId(pkg.id, productId);
    }

    // PR-14 R2 P2-2 — same runtime interval guard the primary helper uses.
    const recurringIntervalForStripe = CheckoutService.assertStripeInterval(
      pkg.recurring_interval,
      pkg.id,
    );

    const price = await this.stripeConnect.createPrice({
      product: productId,
      unit_amount: pkg.recurring_amount_cents,
      currency: pkg.currency,
      recurring: {
        interval: recurringIntervalForStripe,
        interval_count: pkg.recurring_interval_count ?? 1,
      },
      metadata: { tgp_package_id: pkg.id, tgp_companion: 'true' },
      idempotencyKey: `price-recurring-${pkg.id}-${pkg.recurring_amount_cents}-${pkg.currency}-${pkg.recurring_interval}-${pkg.recurring_interval_count ?? 1}`,
    });

    await this.packages.setRecurringStripePriceId(pkg.id, price.id);
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

  // PR-14 R2 P2-2 — runtime guard for the Stripe interval enum. Prisma
  // stores `CoachPackage.interval` as a free-form `String?`, but Stripe's
  // /v1/prices endpoint accepts only week|month|year. Without this guard
  // a corrupt row (typo, future migration drift) would round-trip to
  // Stripe and surface an opaque 400 to the buyer. Fail loudly with a
  // typed error here so the failure mode is server-side and operators
  // see exactly which package row is bad.
  static assertStripeInterval(
    interval: string | null | undefined,
    packageId: string,
  ): 'week' | 'month' | 'year' {
    if (interval === 'week' || interval === 'month' || interval === 'year') {
      return interval;
    }
    throw new BadRequestException({
      error: 'PACKAGE_INTERVAL_INVALID',
      message: `Package ${packageId} has an invalid recurring interval (${interval ?? 'null'}); expected one of week|month|year`,
    });
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
