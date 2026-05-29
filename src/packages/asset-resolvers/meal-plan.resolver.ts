import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import { MealPlanNotFoundError } from './assignable-asset-resolver.errors';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
  AssignableAssetType,
} from './assignable-asset-resolver.interface';

// PR-7 — resolver for asset_type `meal_plan`.
//
// Writes a `DailyMealPlanAssignment` row directly (small, well-scoped INSERT)
// rather than going through `RealMealPlansService.assignPlan`. The reason is
// idempotency: `assignPlan` does a bare `prisma.dailyMealPlanAssignment
// .create()` with no on-conflict handling, and we need the assignment row to
// carry `drip_drop_id` so concurrent PR-10 retries of the same drop race on a
// schema-enforced UNIQUE rather than on a TOCTOU window. (See migration
// 20261203000000_pr7_meal_plan_drip_drop_unique — additive @unique on the
// nullable column, identical to ClientWorkoutAssignment.ai_draft_id.)
//
// Validation we recreate inline (was previously inside assignPlan):
//   1) Sub-coach scope + tenant rewrite via ResolverSubCoachScope. The id we
//      pass as `assigned_by_coach_id` is the HEAD coach id so the row's
//      tenant column lines up with the plan.coach_id we just verified.
//   2) Plan ownership: the DailyMealPlan must exist, not be archived, and
//      belong to the acting tenant. A drop snapshot can outlive plan
//      archival; refusing here (rather than silently writing) lets PR-10
//      mark the drop failed with a clean reason.
//
// Idempotency mechanics:
//   - When invoked from a ScheduledDrop (PR-10), `scheduledDropId` is set.
//     We pass it as `drip_drop_id` on INSERT. The new UNIQUE on that column
//     means two concurrent retries race on the index: the winner commits,
//     the loser gets Prisma error P2002 and falls through to a re-read of
//     the winner's row, returning the same `materialised_ref`. Exactly one
//     assignment exists in either ordering.
//   - When invoked without a scheduledDropId (back-compat / manual call),
//     we fall back to the prior "find latest existing assignment for
//     (client, plan)" probe and return its id if any. This is the same
//     best-effort path the original code took for callers that don't
//     supply a drop id; it is NOT race-safe and the brief explicitly
//     scopes the race-safety requirement to the drip path.
//
// tx-honoring: every read + write uses `input.tx ?? this.prisma`. No nested
// transaction is opened. The immediate-at-checkout fan-out passes `tx`; the
// PR-10 cron path passes none.

@Injectable()
export class MealPlanAssetResolver implements AssignableAssetResolver {
  private readonly logger = new Logger(MealPlanAssetResolver.name);
  readonly assetType: AssignableAssetType = 'meal_plan';

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ResolverSubCoachScope,
  ) {}

  canHandle(assetType: string): boolean {
    return assetType === 'meal_plan';
  }

  async materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    const acting = await this.scope.resolve(input.coachId, input.clientId);
    const db = input.tx ?? this.prisma;

    // Drip path (PR-10): use the schema-enforced unique to make the INSERT
    // atomic. A concurrent retry of the same drop is the failure mode the
    // audit flagged; this guard makes it impossible regardless of probe
    // timing.
    if (input.scheduledDropId) {
      const winner = await this.insertDripAssignment({
        db,
        clientId: input.clientId,
        planId: input.assetId,
        tenantCoachId: acting.tenantCoachId,
        dropId: input.scheduledDropId,
      });
      return { materialisedRef: winner };
    }

    // Manual / back-compat path (no drop id): tolerate existing assignments
    // by short-circuiting on the most recent row for (client, plan). Not
    // race-safe under concurrent retries; the drip executor MUST supply
    // scheduledDropId to reach the atomic path above.
    const existing = await db.dailyMealPlanAssignment.findFirst({
      where: {
        client_id: input.clientId,
        daily_meal_plan_id: input.assetId,
      },
      select: { id: true },
      orderBy: { starts_on: 'desc' },
    });
    if (existing) return { materialisedRef: existing.id };

    await this.assertPlanOwnedByTenant({
      db,
      planId: input.assetId,
      tenantCoachId: acting.tenantCoachId,
    });
    const created = await db.dailyMealPlanAssignment.create({
      data: {
        daily_meal_plan_id: input.assetId,
        client_id: input.clientId,
        assigned_by_coach_id: acting.tenantCoachId,
        starts_on: this.todayUtcDate(),
      },
      select: { id: true },
    });
    return { materialisedRef: created.id };
  }

  private async insertDripAssignment(args: {
    db: Pick<PrismaService, 'dailyMealPlan' | 'dailyMealPlanAssignment'>;
    clientId: string;
    planId: string;
    tenantCoachId: string;
    dropId: string;
  }): Promise<string> {
    const { db, clientId, planId, tenantCoachId, dropId } = args;

    // Best-effort idempotency short-circuit: if a prior fire of this exact
    // drop already wrote a row, return it without re-validating the plan.
    // The UNIQUE is still the hard guarantee — this is purely to avoid the
    // logged P2002 noise on the common retry path.
    const prior = await db.dailyMealPlanAssignment.findUnique({
      where: { drip_drop_id: dropId },
      select: { id: true },
    });
    if (prior) return prior.id;

    await this.assertPlanOwnedByTenant({ db, planId, tenantCoachId });

    try {
      const created = await db.dailyMealPlanAssignment.create({
        data: {
          daily_meal_plan_id: planId,
          client_id: clientId,
          assigned_by_coach_id: tenantCoachId,
          starts_on: this.todayUtcDate(),
          drip_drop_id: dropId,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Loser of the race. Re-read by drop id to return the winner's
        // assignment so ScheduledDrop.materialised_ref converges.
        const winner = await db.dailyMealPlanAssignment.findUnique({
          where: { drip_drop_id: dropId },
          select: { id: true },
        });
        if (winner) return winner.id;
        // Vanishingly unlikely: P2002 with no row visible afterwards (DELETE
        // raced an INSERT). Surface loudly rather than silently retry.
        this.logger.error(
          `MealPlanAssetResolver: P2002 on drip_drop_id=${dropId} but no winner row found`,
        );
      }
      throw err;
    }
  }

  private async assertPlanOwnedByTenant(args: {
    db: Pick<PrismaService, 'dailyMealPlan'>;
    planId: string;
    tenantCoachId: string;
  }): Promise<void> {
    const plan = await args.db.dailyMealPlan.findFirst({
      where: {
        id: args.planId,
        coach_id: args.tenantCoachId,
        archived_at: null,
      },
      select: { id: true },
    });
    if (!plan) throw new MealPlanNotFoundError(args.planId);
  }

  private todayUtcDate(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
