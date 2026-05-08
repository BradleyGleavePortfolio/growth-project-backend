/**
 * RevenueRoutingService — Phase 11 / Track 8 (SCAFFOLD ONLY)
 *
 * Documents the Stripe Connect revenue-routing pattern for the Talent
 * Marketplace. The full payment-intent integration is deferred to a
 * follow-up PR (Track 8.5) because it requires:
 *   1. Changes to the existing subscription billing flow to thread
 *      `application_fee_amount` and `transfer_data.destination` through
 *      the Stripe payment-intent/subscription creation.
 *   2. Webhook handling for `payment_intent.succeeded` to record revenue splits.
 *   3. A payout-ready check (ConnectAccountService.getAccountStatus) before
 *      routing any transfer.
 *
 * ─── Revenue Routing Pattern (Stripe Connect Express) ────────────────────────
 *
 * When the Growth Project platform charges a client on behalf of a head-coach:
 *
 *   const paymentIntent = await stripe.paymentIntents.create({
 *     amount: totalAmountCents,          // e.g. 30000 ($300)
 *     currency: 'usd',
 *     customer: clientStripeCustomerId,
 *     payment_method: clientPaymentMethodId,
 *     confirm: true,
 *
 *     // Platform fee: taken from the charge before transferring to the coach.
 *     application_fee_amount: platformFeeCents, // e.g. 4500 (15%)
 *
 *     // Transfer remainder to the head-coach's connected Stripe account.
 *     transfer_data: {
 *       destination: headCoachStripeAccountId,  // CoachConnectAccount.stripe_account_id
 *     },
 *
 *     // Idempotency is required for retry safety.
 *   }, { idempotencyKey: `pi-${offerId}-${periodStart}` });
 *
 * Fee calculation examples:
 *   commission:  application_fee_amount = totalAmountCents * (1 - rate_pct / 100)
 *   rev_share:   application_fee_amount = totalAmountCents * platform_cut_pct / 100
 *   flat:        application_fee_amount = 0 (platform earns nothing on flat arrangements)
 *   hybrid:      application_fee_amount = calculated per hybrid terms
 *
 * IMPORTANT: The head-coach's Connect account must have
 *   capabilities.transfers === 'active' and
 *   capabilities.card_payments === 'active'
 * before any transfer can be made. Check ConnectAccountService.getAccountStatus.
 *
 * ─── Payout Schedule ──────────────────────────────────────────────────────────
 *
 * Stripe automatically pays out to the connected account's bank on the
 * account's configured schedule (default: daily rolling). This is managed in
 * the Stripe Dashboard for each connected account; no code change needed.
 *
 * ─── 1099 / Tax Reporting ────────────────────────────────────────────────────
 *
 * Stripe issues 1099-K to connected accounts meeting thresholds automatically
 * when `accounts.create` is called with `country: 'US'`. No additional code
 * needed for this PR; track in Track 8.5 tax-reporting follow-up.
 */

import { Injectable, Logger } from '@nestjs/common';

/** Compensation configuration from a CoachOffer. */
export interface CompensationConfig {
  type: 'commission' | 'rev_share' | 'flat' | 'hybrid';
  terms: Record<string, unknown>;
}

/** Result of a fee calculation. */
export interface FeeCalculation {
  total_amount_cents: number;
  application_fee_cents: number;
  transfer_amount_cents: number;
  platform_cut_pct: number;
}

@Injectable()
export class RevenueRoutingService {
  private readonly logger = new Logger(RevenueRoutingService.name);

  /**
   * Calculate the platform fee for a given charge amount and compensation config.
   *
   * THIS IS A SCAFFOLD — the result is not yet wired into any Stripe API call.
   * Use in Track 8.5 when threading payment intents.
   */
  calculateFee(
    totalAmountCents: number,
    config: CompensationConfig,
  ): FeeCalculation {
    let applicationFeeCents = 0;
    let platformCutPct = 0;

    switch (config.type) {
      case 'commission': {
        const ratePct = Number(config.terms['rate_pct'] ?? 0);
        // Platform keeps the complement of the commission rate.
        // e.g. 85% commission means platform takes 15%.
        platformCutPct = 100 - ratePct;
        applicationFeeCents = Math.round(totalAmountCents * (platformCutPct / 100));
        break;
      }
      case 'rev_share': {
        const ratePct = Number(config.terms['rate_pct'] ?? 0);
        platformCutPct = ratePct;
        applicationFeeCents = Math.round(totalAmountCents * (ratePct / 100));
        const capUsd = config.terms['cap_usd'];
        if (typeof capUsd === 'number') {
          applicationFeeCents = Math.min(applicationFeeCents, Math.round(capUsd * 100));
        }
        break;
      }
      case 'flat': {
        // Platform takes no fee on flat arrangements — coach earns the full amount.
        applicationFeeCents = 0;
        platformCutPct = 0;
        break;
      }
      case 'hybrid': {
        const ratePct = Number(config.terms['rate_pct'] ?? 0);
        platformCutPct = ratePct;
        applicationFeeCents = Math.round(totalAmountCents * (ratePct / 100));
        break;
      }
      default:
        this.logger.warn(`Unknown compensation type: ${String(config.type)}`);
    }

    return {
      total_amount_cents: totalAmountCents,
      application_fee_cents: applicationFeeCents,
      transfer_amount_cents: totalAmountCents - applicationFeeCents,
      platform_cut_pct: platformCutPct,
    };
  }

  /**
   * SCAFFOLD: documents the payment-intent creation call.
   * In Track 8.5 this method will call the Stripe API with
   * application_fee_amount + transfer_data.destination.
   *
   * @throws Error always — intentionally not implemented in Track 8 scope.
   */
  async createMarketplacePaymentIntent(
    _totalAmountCents: number,
    _currency: string,
    _headCoachStripeAccountId: string,
    _config: CompensationConfig,
    _idempotencyKey: string,
  ): Promise<never> {
    throw new Error(
      'RevenueRoutingService.createMarketplacePaymentIntent is a scaffold. ' +
        'Full implementation is deferred to Track 8.5 (revenue-split payment intents). ' +
        'See the JSDoc at the top of this file for the Stripe pattern.',
    );
  }
}
