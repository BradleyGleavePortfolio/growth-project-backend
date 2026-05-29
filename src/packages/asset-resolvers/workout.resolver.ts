import { Injectable, Logger } from '@nestjs/common';
import { WorkoutBuilderService } from '../../workout-builder/workout-builder.service';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
  AssignableAssetType,
} from './assignable-asset-resolver.interface';

// PR-7 — resolver for asset_type `workout_program` and `workout_plan`.
//
// Both asset_types reference the same underlying model (`WorkoutPlan`); the
// distinction lives in the authoring UI (a "program" is a curated multi-week
// arc, a "plan" is a single session) but at materialisation time they both
// expand to a `ClientWorkoutAssignment` for the buyer on the drop date.
//
// Delegates to `WorkoutBuilderService.assignPlan`
// (src/workout-builder/workout-builder.service.ts:511) which already
// performs all of: coach/plan/client ownership checks, the
// `assigned_by_coach_id` write, and the idempotency-key-aware ledger write
// (see `withIdempotency` in the same service).
//
// Idempotency: `WorkoutBuilderService.assignPlan` is wrapped in
// `withIdempotency(coachId, 'workout-builder:assignPlan:{planId}', key, …)`.
// The key we supply MUST be stable across the failure mode the outer
// fan-out $transaction exists to handle: a rollback (resolver throws OR any
// in-tx step after the resolver fails) + Stripe webhook retry. ScheduledDrop
// UUIDs are NOT stable in that scenario — the rolled-back row is gone and
// the retry's createMany mints a fresh UUID. The ClientPurchase id and the
// CoachPackageContent id ARE stable across that retry, so we prefer those.
//
// Inline-checkout path (PR-9 fan-out): key = `drip:workout:{purchaseId}:{contentId}`.
//   The WorkoutBuilderIdempotencyKey ledger persists OUTSIDE the outer tx
//   (its own `this.prisma` write), so a rolled-back retry hits the same
//   stable key, finds the cached row, and returns the cached assignment
//   without firing a second `ClientWorkoutAssignment` insert.
// PR-10 cron path: caller passes scheduledDropId but no purchase/content
//   pair — fall back to `drip:workout:{clientId}:{assetId}:{scheduledDropId}`.
//   That UUID is stable from the cron's POV (the drop row already
//   committed) so per-PR-10-call idempotency holds.
//
// tx-honoring: WorkoutBuilderService opens its own internal transactions
// and does not accept an external tx. When the immediate-at-checkout caller
// passes `tx` we therefore cannot push it into the delegate — we rely on
// the stable-keyed idempotency ledger above to make a retry safe.

const ASSIGN_DEFAULT_OFFSET_MS = 0;

@Injectable()
export class WorkoutAssetResolver implements AssignableAssetResolver {
  private readonly logger = new Logger(WorkoutAssetResolver.name);

  // The resolver covers BOTH asset_type strings; `canHandle` returns true
  // for either. We expose `workout_plan` as the primary `assetType` for
  // diagnostics and dedup-warning purposes.
  readonly assetType: AssignableAssetType = 'workout_plan';

  constructor(
    private readonly workoutBuilder: WorkoutBuilderService,
    private readonly scope: ResolverSubCoachScope,
  ) {}

  canHandle(assetType: string): boolean {
    return assetType === 'workout_plan' || assetType === 'workout_program';
  }

  async materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    const acting = await this.scope.resolve(input.coachId, input.clientId);

    // Schedule for "now" by default; PR-9/PR-10 will pass an explicit
    // `scheduled_for` via the fan-out brief. For the resolver-only PR
    // we use the drop's fire-time semantics (drop is firing now).
    const scheduledFor = new Date(Date.now() + ASSIGN_DEFAULT_OFFSET_MS);

    // Deterministic idempotency key — same purchase+content MUST collapse
    // to one assignment under retry, INCLUDING the rollback-and-retry path
    // (outer tx rolls back, drop UUIDs regenerate, but purchaseId +
    // contentId stay stable). See the file-level comment for the two
    // keying modes; both run through `withIdempotency` against the
    // existing WorkoutBuilderIdempotencyKey ledger.
    const idempotencyKey = this.buildIdempotencyKey({
      clientId: input.clientId,
      assetId: input.assetId,
      clientPurchaseId: input.clientPurchaseId ?? null,
      contentId: input.contentId ?? null,
      scheduledDropId: input.scheduledDropId ?? null,
    });

    const assignment = await this.workoutBuilder.assignPlan(
      acting.tenantCoachId,
      input.assetId,
      {
        client_id: input.clientId,
        scheduled_for: scheduledFor.toISOString(),
      },
      idempotencyKey,
    );

    if (!assignment || typeof assignment !== 'object' || !('id' in assignment)) {
      // WorkoutBuilderService.assignPlan currently always returns the row,
      // but defend against a future signature drift.
      this.logger.error(
        `WorkoutAssetResolver: assignPlan returned no id for client=${input.clientId} plan=${input.assetId}`,
      );
      throw new Error('WorkoutAssetResolver: assignPlan returned no id');
    }
    return { materialisedRef: String((assignment as { id: string }).id) };
  }

  // Build the WorkoutBuilderIdempotencyKey value. PREFERRED form
  // `drip:workout:p={purchaseId}:c={contentId}` — STABLE across an outer-tx
  // rollback + Stripe webhook retry (PR-9 audit P1-1 fix). Fallback form
  // `drip:workout:{clientId}:{assetId}:{scheduledDropId|no-drop}` for the
  // PR-10 cron path which only knows the (already-committed) drop id.
  //
  // The "drip:" prefix keeps these distinguishable from coach-initiated
  // assignments in the idempotency ledger.
  private buildIdempotencyKey(parts: {
    clientId: string;
    assetId: string;
    clientPurchaseId: string | null;
    contentId: string | null;
    scheduledDropId: string | null;
  }): string {
    if (parts.clientPurchaseId && parts.contentId) {
      return `drip:workout:p=${parts.clientPurchaseId}:c=${parts.contentId}`;
    }
    const dropSegment = parts.scheduledDropId ?? 'no-drop';
    return `drip:workout:${parts.clientId}:${parts.assetId}:${dropSegment}`;
  }
}
