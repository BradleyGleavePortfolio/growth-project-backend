import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

// FeePolicyService — single source of truth for "how does a purchase
// dollar get split". Two-layer policy:
//
//   1. Global default (hard-coded constants below). Owner-set policy.
//   2. Per-coach override row in FeePolicy. Either basis-points field
//      may be null to fall back to the global default.
//
// All math is in basis points (1 bp = 0.01%). 200 bps = 2.00%. Working
// in bps keeps the rate columns integer-typed and lets us express a fee
// like 2.5% as 250 with no float drift.
//
// Rounding doctrine: when computing destination cents we always
// floor (Math.floor) so the platform absorbs the sub-cent fraction. We
// must never round up the destination — a one-cent over-credit on
// Stripe's side becomes a balance-not-available error days later.

export const PLATFORM_APPLICATION_FEE_BPS_DEFAULT = 200; // 2.00%
export const HEAD_COACH_SPLIT_BPS_DEFAULT = 500; // 5.00%
// Sanity cap — combined platform + head-coach can never exceed 50% by
// policy (writes are rejected). Keeps a misconfigured policy from
// stranding nearly the whole charge.
export const MAX_COMBINED_BPS = 5000;

export interface FeePolicySnapshot {
  platform_application_fee_bps: number;
  head_coach_split_bps: number;
  source: 'default' | 'override';
}

export interface SplitPlanInput {
  amount_cents: number;
  seller_coach_id: string;
  // When the seller is a sub-coach, this is the head coach to whom the
  // 5%-style split is owed. null = solo PT path.
  head_coach_id: string | null;
}

export interface SplitPlan {
  amount_cents: number;
  currency_assumed: string;
  // The platform's slice (application_fee_amount on the Stripe charge).
  // Always rounded toward platform safety (floor).
  application_fee_cents: number;
  // The head-coach's slice. 0 when seller is solo (no head_coach_id).
  // This is a follow-on Transfer minted by us after the charge succeeds.
  head_coach_split_cents: number;
  // Destination amount the connected account (selling coach) ends up
  // with, BEFORE Stripe's processing fee. Computed for display only —
  // Stripe doesn't take this as input; it's the residual.
  destination_cents: number;
  policy: FeePolicySnapshot;
  // The head coach we'd transfer to. Mirrored here so callers don't have
  // to re-resolve.
  head_coach_id: string | null;
}

@Injectable()
export class FeePolicyService {
  private readonly logger = new Logger(FeePolicyService.name);

  constructor(private prisma: PrismaService) {}

  // Resolve the effective fee rates for a seller. Reads the FeePolicy
  // override row if present; falls back to the global default per field.
  async resolvePolicy(coachId: string): Promise<FeePolicySnapshot> {
    const override = await this.prisma.feePolicy.findUnique({
      where: { coach_id: coachId },
    });
    const platform =
      override?.platform_application_fee_bps ??
      PLATFORM_APPLICATION_FEE_BPS_DEFAULT;
    const headCoach =
      override?.head_coach_split_bps ?? HEAD_COACH_SPLIT_BPS_DEFAULT;
    return {
      platform_application_fee_bps: platform,
      head_coach_split_bps: headCoach,
      source: override ? 'override' : 'default',
    };
  }

  // Resolve the head coach (if any) for a selling coach. A coach is a
  // sub-coach iff they have at least one non-archived TeamSubCoachAssignment
  // row as sub_coach_id. The "at most 2 head coaches" cap is enforced
  // upstream; here we deterministically pick the OLDEST non-archived
  // assignment so the split target is stable across renewals.
  async resolveHeadCoachId(sellerCoachId: string): Promise<string | null> {
    const row = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { sub_coach_id: sellerCoachId, archived_at: null },
      orderBy: { created_at: 'asc' },
      select: { head_coach_id: true },
    });
    return row?.head_coach_id ?? null;
  }

  // Build the split plan for a charge. Pure function once policy + head
  // coach are resolved — no DB writes. All cents math is integer; the
  // platform absorbs rounding.
  computePlan(args: SplitPlanInput, policy: FeePolicySnapshot): SplitPlan {
    if (!Number.isInteger(args.amount_cents) || args.amount_cents <= 0) {
      throw new BadRequestException({
        error: 'AMOUNT_INVALID',
        message: `amount_cents must be a positive integer (got ${args.amount_cents})`,
      });
    }
    const platformBps = policy.platform_application_fee_bps;
    const headCoachBps = args.head_coach_id ? policy.head_coach_split_bps : 0;
    if (platformBps < 0 || headCoachBps < 0) {
      throw new BadRequestException({
        error: 'POLICY_NEGATIVE_BPS',
        message: 'Fee policy bps must be non-negative',
      });
    }
    if (platformBps + headCoachBps > MAX_COMBINED_BPS) {
      throw new BadRequestException({
        error: 'POLICY_OVER_CAP',
        message: `Combined platform + head-coach bps (${
          platformBps + headCoachBps
        }) exceeds cap ${MAX_COMBINED_BPS}`,
      });
    }
    const applicationFeeCents = Math.floor(
      (args.amount_cents * platformBps) / 10_000,
    );
    const headCoachSplitCents = Math.floor(
      (args.amount_cents * headCoachBps) / 10_000,
    );
    const destinationCents =
      args.amount_cents - applicationFeeCents - headCoachSplitCents;
    if (destinationCents <= 0) {
      throw new BadRequestException({
        error: 'POLICY_DRAINS_DESTINATION',
        message:
          'Fee policy leaves zero or negative destination — refuse to mint a checkout that would pay the seller nothing',
      });
    }
    return {
      amount_cents: args.amount_cents,
      currency_assumed: 'usd',
      application_fee_cents: applicationFeeCents,
      head_coach_split_cents: headCoachSplitCents,
      destination_cents: destinationCents,
      policy,
      head_coach_id: args.head_coach_id,
    };
  }

  // Convenience: resolve policy + head coach + plan in one call.
  async planFor(
    sellerCoachId: string,
    amountCents: number,
  ): Promise<SplitPlan> {
    const [policy, headCoachId] = await Promise.all([
      this.resolvePolicy(sellerCoachId),
      this.resolveHeadCoachId(sellerCoachId),
    ]);
    return this.computePlan(
      {
        amount_cents: amountCents,
        seller_coach_id: sellerCoachId,
        head_coach_id: headCoachId,
      },
      policy,
    );
  }

  // OWNER-only write path for FeePolicy overrides.
  async upsertOverride(
    coachId: string,
    args: {
      platform_application_fee_bps?: number | null;
      head_coach_split_bps?: number | null;
      notes?: string | null;
    },
  ) {
    this.assertSane(args);
    return this.prisma.feePolicy.upsert({
      where: { coach_id: coachId },
      create: {
        coach_id: coachId,
        platform_application_fee_bps:
          args.platform_application_fee_bps ?? null,
        head_coach_split_bps: args.head_coach_split_bps ?? null,
        notes: args.notes ?? null,
      },
      update: {
        platform_application_fee_bps:
          args.platform_application_fee_bps ?? null,
        head_coach_split_bps: args.head_coach_split_bps ?? null,
        notes: args.notes ?? null,
      },
    });
  }

  private assertSane(args: {
    platform_application_fee_bps?: number | null;
    head_coach_split_bps?: number | null;
  }) {
    const platform = args.platform_application_fee_bps;
    const headCoach = args.head_coach_split_bps;
    if (platform != null) {
      if (!Number.isInteger(platform) || platform < 0 || platform > MAX_COMBINED_BPS) {
        throw new BadRequestException({
          error: 'PLATFORM_BPS_OUT_OF_RANGE',
          message: `platform_application_fee_bps must be 0..${MAX_COMBINED_BPS}`,
        });
      }
    }
    if (headCoach != null) {
      if (!Number.isInteger(headCoach) || headCoach < 0 || headCoach > MAX_COMBINED_BPS) {
        throw new BadRequestException({
          error: 'HEAD_COACH_BPS_OUT_OF_RANGE',
          message: `head_coach_split_bps must be 0..${MAX_COMBINED_BPS}`,
        });
      }
    }
    const combined =
      (platform ?? PLATFORM_APPLICATION_FEE_BPS_DEFAULT) +
      (headCoach ?? HEAD_COACH_SPLIT_BPS_DEFAULT);
    if (combined > MAX_COMBINED_BPS) {
      throw new BadRequestException({
        error: 'POLICY_OVER_CAP',
        message: `Combined platform + head-coach bps (${combined}) exceeds cap ${MAX_COMBINED_BPS}`,
      });
    }
  }
}
