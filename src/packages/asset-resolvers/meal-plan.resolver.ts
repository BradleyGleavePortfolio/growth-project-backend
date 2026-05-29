import { Injectable, Logger } from '@nestjs/common';
import { RealMealPlansService } from '../../real-meal-plans/real-meal-plans.service';
import { PrismaService } from '../../prisma.service';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
  AssignableAssetType,
} from './assignable-asset-resolver.interface';

// PR-7 — resolver for asset_type `meal_plan`.
//
// Delegates to `RealMealPlansService.assignPlan`
// (src/real-meal-plans/real-meal-plans.service.ts:247). The service runs
// `assertPlanOwnedBy` + `assertClientOfCoach` against the head-coach id we
// resolve here, then inserts a `DailyMealPlanAssignment` row.
//
// Idempotency: RealMealPlansService does NOT today have a per-call
// idempotency ledger (unlike workout-builder), and `DailyMealPlanAssignment`
// has no @@unique on (client_id, daily_meal_plan_id). To keep the
// resolver retry-safe under PR-10 backoff we look for an EXISTING
// assignment for the same (client, plan) FIRST and return its id. The
// look-up is cheap, runs inside the ambient tx when provided, and matches
// the on-conflict-nothing pattern used by the pdf/video resolver.
//
// tx-honoring: the existence-check probe runs on the ambient tx when given.
// The delegated insert in RealMealPlansService opens no internal tx of its
// own but uses the unscoped `prisma` client; for PR-7 scope we cannot push
// `tx` into the delegate (out-of-scope change to RealMealPlansService).
// Documented; PR-10 will tighten if needed.

@Injectable()
export class MealPlanAssetResolver implements AssignableAssetResolver {
  private readonly logger = new Logger(MealPlanAssetResolver.name);
  readonly assetType: AssignableAssetType = 'meal_plan';

  constructor(
    private readonly mealPlans: RealMealPlansService,
    private readonly prisma: PrismaService,
    private readonly scope: ResolverSubCoachScope,
  ) {}

  canHandle(assetType: string): boolean {
    return assetType === 'meal_plan';
  }

  async materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    // We must pass the HEAD coach id (acting.tenantCoachId) into
    // RealMealPlansService so the ownership + tenancy checks line up with
    // the plan's coach_id column.
    const acting = await this.scope.resolve(input.coachId, input.clientId);

    const db = input.tx ?? this.prisma;
    const existing = await db.dailyMealPlanAssignment.findFirst({
      where: {
        client_id: input.clientId,
        daily_meal_plan_id: input.assetId,
      },
      select: { id: true },
      orderBy: { starts_on: 'desc' },
    });
    if (existing) {
      // Already materialised on a prior fire (or a concurrent retry beat
      // us). Return the existing ref so ScheduledDrop.materialised_ref
      // links to the same row.
      return { materialisedRef: existing.id };
    }

    const startsOn = new Date();
    const startsOnDate = `${startsOn.getUTCFullYear()}-${pad2(
      startsOn.getUTCMonth() + 1,
    )}-${pad2(startsOn.getUTCDate())}`;

    const created = await this.mealPlans.assignPlan(
      acting.tenantCoachId,
      input.assetId,
      {
        client_id: input.clientId,
        starts_on: startsOnDate,
      },
    );
    if (!created?.id) {
      this.logger.error(
        `MealPlanAssetResolver: assignPlan returned no id for client=${input.clientId} plan=${input.assetId}`,
      );
      throw new Error('MealPlanAssetResolver: assignPlan returned no id');
    }
    return { materialisedRef: created.id };
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
