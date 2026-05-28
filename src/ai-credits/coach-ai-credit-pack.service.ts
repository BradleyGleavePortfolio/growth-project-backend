import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StripeApiService } from '../billing/stripe-api.service';
import { CoachAIBudgetService } from './coach-ai-budget.service';
import { bankersRoundPaidToActual } from './bankers-round.util';
import {
  COACH_AI_CUSTOM_PACK_MAX_CENTS,
  COACH_AI_CUSTOM_PACK_MIN_CENTS,
} from './ai-credits.constants';
import type { CreditPackTier } from './credit-pack-checkout.dto';

// CoachAiCreditPackService — mint Stripe Checkout Sessions for AI credit
// packs and dispatch the matching webhook events to
// CoachAIBudgetService.applyCreditPack().
//
// Separation of concerns:
//   - This service knows about Stripe Checkout + the pack tier mapping.
//   - CoachAIBudgetService owns the CoachAIBudget table writes.
//   - StripeWebhookController (existing) + BillingService route
//     checkout.session.completed events to handleStripeEvent() here.

interface PackTierResolution {
  amountCents: number;
  productName: string;
}

/** Read surface shared by `PrismaService` and `Prisma.TransactionClient` for
 *  the CCPP lookup before the credit-apply branch. */
type DbReader = Pick<PrismaService, 'coachCreditPackPurchase'> | Prisma.TransactionClient;

@Injectable()
export class CoachAiCreditPackService {
  private readonly logger = new Logger(CoachAiCreditPackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeApiService,
    private readonly budget: CoachAIBudgetService,
  ) {}

  /**
   * Create a Stripe Checkout Session for the chosen pack tier.
   *
   * Flow:
   *   1. Resolve head-coach id (sub-coaches buy for their head's envelope).
   *   2. Resolve / mint a Stripe Customer id pinned to the head coach.
   *   3. Pre-create a CoachCreditPackPurchase row in 'pending' state. The
   *      Stripe session id is filled in once Stripe returns one — we
   *      generate our own purchase id up-front so we can stamp it on the
   *      session metadata as `tgp_ai_pack_purchase_id`, which the webhook
   *      reads back.
   *   4. Call Stripe Checkout. Idempotency key is the purchase row id so a
   *      retry from the mobile client during network flapping does not
   *      mint a duplicate session.
   *   5. Persist the session id on the purchase row.
   */
  async createCheckoutSession(args: {
    coachUserId: string;
    tier: CreditPackTier;
    amountCents?: number;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<{
    checkout_session_id: string;
    checkout_url: string;
    amount_cents: number;
    purchase_id: string;
  }> {
    const headCoachId = await this.budget.resolveHeadCoachId(args.coachUserId);
    const resolved = this.resolveTier(args.tier, args.amountCents);

    // Resolve a Stripe Customer for the head coach. We reuse the customer
    // on CoachProfile / CoachSubscription if available; otherwise we mint
    // a new one. The idempotency key on createCustomer ensures concurrent
    // first-buy clicks don't create duplicate customers.
    const customerId = await this.resolveStripeCustomerId(headCoachId);

    const budget = await this.budget.getOrCreateCurrentPeriod(headCoachId);

    // Pre-create the purchase row so we have a stable internal id to
    // stamp on the Stripe metadata. status starts as 'pending'; the
    // webhook flips it to 'paid' (or the client expires path flips it
    // to 'failed').
    const purchase = await this.prisma.coachCreditPackPurchase.create({
      data: {
        coach_user_id: headCoachId,
        budget_id: budget.id,
        paid_cents: resolved.amountCents,
        displayed_credit_cents: resolved.amountCents,
        actual_credit_cents: bankersRoundPaidToActual(
          resolved.amountCents,
          budget.value_multiplier,
        ),
        status: 'pending',
      },
    });

    const successUrl =
      args.successUrl ??
      process.env.COACH_AI_PACK_SUCCESS_URL ??
      process.env.STRIPE_CHECKOUT_SUCCESS_URL ??
      'https://app.trygrowthproject.com/billing/success';
    const cancelUrl =
      args.cancelUrl ??
      process.env.COACH_AI_PACK_CANCEL_URL ??
      process.env.STRIPE_CHECKOUT_CANCEL_URL ??
      'https://app.trygrowthproject.com/billing/cancel';

    let session;
    try {
      session = await this.stripe.createCreditPackCheckoutSession({
        customer: customerId,
        amountCents: resolved.amountCents,
        productName: resolved.productName,
        successUrl,
        cancelUrl,
        metadata: {
          // The webhook reads back through this set; the first key is the
          // primary lookup.
          tgp_ai_pack_purchase_id: purchase.id,
          tgp_coach_user_id: headCoachId,
          tgp_kind: 'coach_ai_credit_pack',
        },
        idempotencyKey: `coach_ai_pack_${purchase.id}`,
      });
    } catch (err) {
      // Roll the purchase row forward to 'failed' so we don't leave it as
      // a dangling 'pending' that an audit job would have to reconcile.
      await this.prisma.coachCreditPackPurchase.update({
        where: { id: purchase.id },
        data: { status: 'failed' },
      });
      throw err;
    }

    if (!session.id || !session.url) {
      // Stripe returned a malformed object — same recovery as the throw path.
      await this.prisma.coachCreditPackPurchase.update({
        where: { id: purchase.id },
        data: { status: 'failed' },
      });
      throw new BadRequestException(
        'Stripe Checkout did not return a session id/url',
      );
    }

    await this.prisma.coachCreditPackPurchase.update({
      where: { id: purchase.id },
      data: { stripe_checkout_session_id: session.id },
    });

    return {
      checkout_session_id: session.id,
      checkout_url: session.url,
      amount_cents: resolved.amountCents,
      purchase_id: purchase.id,
    };
  }

  /**
   * Webhook entrypoint. Returns claimed=true when the event belongs to
   * an AI credit pack (identified by metadata.tgp_kind === 'coach_ai_credit_pack').
   * Returns claimed=false otherwise so BillingService can route the event
   * to a downstream handler.
   *
   * P0-6: accepts an optional outer Prisma.TransactionClient so the
   * credit-apply write commits atomically with the BillingService dedup
   * row. When omitted, applyCreditPack opens its own $transaction.
   *
   * P0-2/3: uses the CCPP row's `paid_cents` (the tier amount recorded
   * at session-mint) as the credit source rather than the Stripe event's
   * `amount_total`. With `automatic_tax` disabled for credit-pack
   * sessions this is the same number; with it ever re-enabled, this
   * path still credits the face-value tier amount rather than the
   * tax-inflated total — keeping the "$25 buys $25 of AI" promise true.
   */
  async handleStripeEvent(
    event: {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    },
    outerTx?: Prisma.TransactionClient,
  ): Promise<{ claimed: boolean; status?: string }> {
    const obj = event.data.object as {
      id?: string;
      metadata?: Record<string, string>;
      payment_status?: string;
      status?: string;
      payment_intent?: string | null;
      invoice?: string | null;
      amount_total?: number;
      customer?: string | null;
    };

    if (
      event.type !== 'checkout.session.completed' &&
      event.type !== 'checkout.session.expired'
    ) {
      return { claimed: false };
    }
    if (obj.metadata?.tgp_kind !== 'coach_ai_credit_pack') {
      return { claimed: false };
    }
    if (!obj.id) {
      this.logger.warn(
        { event: 'COACH_AI_PACK_WEBHOOK_NO_SESSION_ID', stripeEventId: event.id },
        'checkout session event missing id',
      );
      return { claimed: true, status: 'no_session_id' };
    }

    // The CCPP row was pre-created at session mint with the tier amount.
    // We look it up BEFORE deciding how much to credit so the credit
    // always matches the tier face value, not whatever Stripe summed.
    // Use the outer tx if supplied so this read is consistent with the
    // subsequent applyCreditPack write inside the same transaction.
    const db: DbReader = outerTx ?? this.prisma;
    const existing = await db.coachCreditPackPurchase.findUnique({
      where: { stripe_checkout_session_id: obj.id },
    });

    if (event.type === 'checkout.session.expired') {
      if (existing && existing.status === 'pending') {
        await (outerTx ?? this.prisma).coachCreditPackPurchase
          .update({
            where: { stripe_checkout_session_id: obj.id },
            data: { status: 'failed' },
          })
          .catch(() => undefined);
      }
      return { claimed: true, status: 'expired' };
    }

    if (!existing) {
      // Stray webhook for a session we never minted. applyCreditPack
      // would log the same condition; short-circuit here to avoid the
      // extra call.
      this.logger.warn(
        {
          event: 'COACH_AI_PACK_WEBHOOK_NO_PENDING_ROW',
          stripeEventId: event.id,
          stripeSessionId: obj.id,
        },
        'pack webhook arrived without matching pending purchase row',
      );
      return { claimed: true, status: 'no_pending_purchase' };
    }

    const coachUserId = obj.metadata.tgp_coach_user_id ?? existing.coach_user_id;
    if (!coachUserId) {
      this.logger.warn(
        {
          event: 'COACH_AI_PACK_WEBHOOK_NO_COACH',
          stripeEventId: event.id,
          stripeSessionId: obj.id,
        },
        'checkout session missing tgp_coach_user_id metadata and no CCPP fallback',
      );
      return { claimed: true, status: 'no_coach' };
    }

    // Audit log if Stripe's amount_total disagrees with what we recorded.
    // P0-2/3: this is the divergence indicator. With automatic_tax
    // disabled they should always match; if they don't, surface the
    // discrepancy on the structured log so support can reconcile.
    if (
      typeof obj.amount_total === 'number' &&
      obj.amount_total !== existing.paid_cents
    ) {
      this.logger.warn(
        {
          event: 'COACH_AI_PACK_AMOUNT_TOTAL_DIVERGENCE',
          stripeEventId: event.id,
          stripeSessionId: obj.id,
          ccppPaidCents: existing.paid_cents,
          stripeAmountTotal: obj.amount_total,
        },
        'Stripe amount_total differs from pre-recorded paid_cents; crediting face-value tier amount',
      );
    }

    const result = await this.budget.applyCreditPack(
      {
        coachId: coachUserId,
        // P0-2/3: face-value tier amount, not tax-inclusive total.
        paidCents: existing.paid_cents,
        stripeCheckoutSessionId: obj.id,
        stripeInvoiceId: typeof obj.invoice === 'string' ? obj.invoice : null,
        stripePaymentIntentId:
          typeof obj.payment_intent === 'string' ? obj.payment_intent : null,
      },
      outerTx,
    );
    return { claimed: true, status: result.status };
  }

  /**
   * Resolve the head coach's Stripe Customer id. Falls back to minting a
   * customer if neither CoachProfile nor CoachSubscription carries one.
   */
  private async resolveStripeCustomerId(headCoachId: string): Promise<string> {
    const [profile, sub, user] = await Promise.all([
      this.prisma.coachProfile.findUnique({
        where: { user_id: headCoachId },
        select: { stripe_customer_id: true },
      }),
      this.prisma.coachSubscription.findUnique({
        where: { coach_id: headCoachId },
        select: { stripe_customer_id: true },
      }),
      this.prisma.user.findUnique({
        where: { id: headCoachId },
        select: { id: true, email: true, name: true },
      }),
    ]);
    if (!user) {
      throw new NotFoundException(`Coach user ${headCoachId} not found`);
    }
    const existing = profile?.stripe_customer_id ?? sub?.stripe_customer_id;
    if (existing) return existing;

    const customer = await this.stripe.createCustomer({
      email: user.email,
      name: user.name,
      metadata: { coach_id: user.id, tgp_kind: 'coach_ai_credit_pack' },
      idempotencyKey: `coach_customer_${user.id}`,
    });
    // Mirror it onto CoachProfile if a row exists so subsequent purchases
    // skip the mint. Best-effort — a missing CoachProfile is normal in
    // tests and on freshly-promoted coaches; we don't block on it.
    if (profile) {
      await this.prisma.coachProfile
        .update({
          where: { user_id: headCoachId },
          data: { stripe_customer_id: customer.id },
        })
        .catch((err) => {
          this.logger.warn(
            { coachId: headCoachId, err: (err as Error).message },
            'failed to mirror stripe_customer_id onto CoachProfile',
          );
        });
    }
    return customer.id;
  }

  private resolveTier(tier: CreditPackTier, customCents?: number): PackTierResolution {
    switch (tier) {
      case 'small':
        return { amountCents: 1000, productName: 'TGP AI Credits — Small ($10)' };
      case 'medium':
        return { amountCents: 2500, productName: 'TGP AI Credits — Medium ($25)' };
      case 'large':
        return { amountCents: 9900, productName: 'TGP AI Credits — Large ($99)' };
      case 'custom':
        if (
          typeof customCents !== 'number' ||
          !Number.isInteger(customCents) ||
          customCents < COACH_AI_CUSTOM_PACK_MIN_CENTS ||
          customCents > COACH_AI_CUSTOM_PACK_MAX_CENTS
        ) {
          throw new BadRequestException({
            error: 'COACH_AI_PACK_AMOUNT_OUT_OF_BOUNDS',
            message: `Custom pack amount must be an integer in cents between ${COACH_AI_CUSTOM_PACK_MIN_CENTS} and ${COACH_AI_CUSTOM_PACK_MAX_CENTS}.`,
            min: COACH_AI_CUSTOM_PACK_MIN_CENTS,
            max: COACH_AI_CUSTOM_PACK_MAX_CENTS,
          });
        }
        return {
          amountCents: customCents,
          productName: `TGP AI Credits — Custom ($${(customCents / 100).toFixed(2)})`,
        };
    }
  }
}
