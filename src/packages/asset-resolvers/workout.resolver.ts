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
// We pass a deterministic key derived from `(clientId, dropId, planId)` so a
// PR-10 retry of the same ScheduledDrop replays the cached success rather
// than producing a second assignment.
//
// tx-honoring: WorkoutBuilderService opens its own internal transactions
// and does not accept an external tx. When the immediate-at-checkout caller
// passes `tx` we therefore cannot push it into the delegate — we rely on
// the service's internal idempotency ledger to make a retry safe.

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

    // Deterministic idempotency key — same (client, drop, plan) MUST collapse
    // to one assignment under retry. Includes scheduledDropId when present
    // so two distinct drops of the same plan to the same client (e.g. a
    // re-purchase) remain independent.
    const idempotencyKey = this.buildIdempotencyKey({
      clientId: input.clientId,
      assetId: input.assetId,
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

  // RFC-4122-shaped pseudo-key (not a true UUID — the ledger only requires
  // a stable string per logical operation). Prefixing with "drip:" keeps
  // these keys distinguishable from coach-initiated assignments in the
  // idempotency ledger.
  private buildIdempotencyKey(parts: {
    clientId: string;
    assetId: string;
    scheduledDropId: string | null;
  }): string {
    const dropSegment = parts.scheduledDropId ?? 'no-drop';
    return `drip:workout:${parts.clientId}:${parts.assetId}:${dropSegment}`;
  }
}
