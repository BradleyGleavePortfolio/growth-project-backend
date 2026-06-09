import { Injectable, Logger } from '@nestjs/common';
import type { PayoutMethodKind } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  isBankPayoutsV2Enabled,
  isStripeTreasuryPayoutsEnabled,
} from './payouts-v2.feature';
import { PayoutMethodService } from './payout-method.service';

/** Fee-tier a purchase's payout is bookkept under (spec §2.5 / §2.6). */
export type PayoutFeeTier = 'card' | 'bank';

/** Outcome of routing a `payout.paid` (and payout.failed / payout.updated). */
export interface PayoutRoutingResult {
  /** Whether the v2 router engaged (flag on + a resolvable coach). */
  routed: boolean;
  /** The effective payout-method kind the coach is on (spec §2.5). */
  kind: PayoutMethodKind;
  /** The fee tier the purchase routes to (card-paid → card; bank-paid → bank). */
  feeTier: PayoutFeeTier;
  /** Bookkeeping action taken; v1 never moves money (spec §2.5 key principle). */
  action: 'express_log' | 'custom_bank_log' | 'treasury_reconcile' | 'noop';
  reason?: string;
}

/**
 * PayoutRoutingService (spec §2.5) — the thin branch the existing Stripe
 * webhook handler delegates to on `payout.paid` / `payout.failed` /
 * `payout.updated`, keyed on the coach's effective `PayoutMethod.kind`.
 *
 * KEY PRINCIPLE (spec §2.5): in Option B, Stripe moves the money in EVERY case.
 * This service's job is BOOKKEEPING only (which fee tier / which log row), never
 * money movement. v1 holds no custody/ledger responsibility.
 *
 * FEATURE FLAG: gated behind `FEATURE_BANK_PAYOUTS_V2` (default OFF). While OFF
 * the router NO-OPs and reports `kind = STRIPE_EXPRESS`, so the existing Express
 * webhook bookkeeping (RefundDisputeHandlerService.onPayoutEvent →
 * PayoutReadinessService.recordPayoutEvent) remains the sole, unchanged path.
 */
@Injectable()
export class PayoutRoutingService {
  private readonly logger = new Logger(PayoutRoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payoutMethods: PayoutMethodService,
  ) {}

  /**
   * Resolve the fee tier a payment routes to based on how the CLIENT paid
   * (spec §2.5 / hard-gate: card-paid purchase → card-fee tier; bank-paid →
   * bank-fee tier). `STRIPE_CONNECT_CUSTOM_BANK` and (flag-on) `STRIPE_TREASURY`
   * are the lower-cost bank rails; everything else is the card tier.
   */
  feeTierForKind(kind: PayoutMethodKind): PayoutFeeTier {
    return kind === 'STRIPE_CONNECT_CUSTOM_BANK' || kind === 'STRIPE_TREASURY'
      ? 'bank'
      : 'card';
  }

  /**
   * Route a Stripe payout webhook (spec §2.5). Resolves the coach from the
   * Connect account id on the event, looks up the effective payout-method kind,
   * and returns the bookkeeping decision. NEVER moves money.
   *
   * Returns `routed:false, kind:STRIPE_EXPRESS` when the flag is off (so the
   * caller keeps its existing Express-only bookkeeping) or when no coach can be
   * resolved from the event.
   */
  async routePayoutWebhook(args: {
    connectedAccountId: string | null;
    payoutId: string;
    eventType: string;
  }): Promise<PayoutRoutingResult> {
    if (!isBankPayoutsV2Enabled()) {
      return {
        routed: false,
        kind: 'STRIPE_EXPRESS',
        feeTier: 'card',
        action: 'noop',
        reason: 'flag_off',
      };
    }
    if (!args.connectedAccountId) {
      return {
        routed: false,
        kind: 'STRIPE_EXPRESS',
        feeTier: 'card',
        action: 'noop',
        reason: 'no_connected_account',
      };
    }

    const account = await this.prisma.connectAccount.findUnique({
      where: { stripe_account_id: args.connectedAccountId },
      select: { coach_user_id: true },
    });
    if (!account) {
      return {
        routed: false,
        kind: 'STRIPE_EXPRESS',
        feeTier: 'card',
        action: 'noop',
        reason: 'coach_not_found',
      };
    }

    const kind = await this.payoutMethods.resolveEffectiveKind(
      account.coach_user_id,
    );
    const feeTier = this.feeTierForKind(kind);

    // The §2.5 routing switch. Every branch is bookkeeping-only.
    switch (kind) {
      case 'STRIPE_EXPRESS':
        // Existing flow — unchanged. The Express PayoutEvent log is written by
        // the existing RefundDisputeHandlerService path; we only report here.
        return { routed: true, kind, feeTier, action: 'express_log' };
      case 'STRIPE_CONNECT_CUSTOM_BANK':
        // Stripe already routed funds to the linked external_account. We do NOT
        // move money; the existing PayoutEvent log row is upserted/appended.
        return { routed: true, kind, feeTier, action: 'custom_bank_log' };
      case 'STRIPE_TREASURY':
        // FUTURE — flag-gated. While FEATURE_STRIPE_TREASURY_PAYOUTS is off,
        // treat exactly like STRIPE_CONNECT_CUSTOM_BANK. When on, reconcile
        // against the Treasury balance ledger (spec §6 — LATER PR).
        if (isStripeTreasuryPayoutsEnabled()) {
          return { routed: true, kind, feeTier, action: 'treasury_reconcile' };
        }
        return { routed: true, kind, feeTier, action: 'custom_bank_log' };
      default:
        return { routed: true, kind, feeTier, action: 'custom_bank_log' };
    }
  }
}
