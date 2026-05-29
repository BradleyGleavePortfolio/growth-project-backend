import type { Prisma } from '@prisma/client';

// PR-7 — Packages & Drip-Feed: AssignableAssetResolver contract.
//
// Mirrors the spirit of `CapabilityMaterializer` in the AI gateway
// (src/ai/gateway/materialisers/capability-materialiser.interface.ts), but
// is driven by deliverable shape `(asset_type, asset_id, asset_revision_id?)`
// + `(clientId, coachId)` rather than by a pre-existing AiActionDraft row.
//
// The drip executor (PR-9/PR-10) and the immediate-at-checkout fan-out path
// call this abstraction so they never hard-code per-type assignment logic.
// Each resolver DELEGATES to the existing assignment / messaging surface for
// its asset type — it does NOT re-implement assignment SQL.

export type AssignableAssetType =
  | 'workout_program'
  | 'workout_plan'
  | 'meal_plan'
  | 'pdf'
  | 'video'
  | 'auto_message';

export interface AssignableAssetMaterialiseInput {
  /** Target client (the buyer / drip recipient). */
  clientId: string;
  /**
   * Acting coach id. Resolvers MUST pass this through `SubCoachScopeService`
   * before delegating, so a sub-coach can never assign outside their scope
   * and the head-coach id (not the raw User.coach_id) is used as the
   * tenant owner on the downstream row.
   */
  coachId: string;
  /** Asset to materialise (WorkoutPlan id, DailyMealPlan id, CoachMediaAsset id, …). */
  assetId: string;
  /** Optional revision pin (forwarded to the underlying service when supported). */
  assetRevisionId?: string | null;
  /** Display title snapshotted onto ScheduledDrop (for notifications / message body). */
  displayTitle?: string | null;
  /** Display caption snapshotted onto ScheduledDrop (e.g. auto_message body). */
  displayCaption?: string | null;
  /**
   * Originating ScheduledDrop id. Strongly recommended for the drip path —
   * `MediaAssetResolver` records it on `ClientAssetGrant.granted_via_drop_id`,
   * `MealPlanAssetResolver` records it on `DailyMealPlanAssignment.drip_drop_id`
   * (the per-drop UNIQUE race guard added in migration 20261203000000), and
   * downstream PRs may use it to gate retries. Optional only for back-compat
   * with non-drip callers.
   */
  scheduledDropId?: string | null;
  /**
   * Ambient Prisma transaction. When provided (immediate-at-checkout inline
   * fan-out path), the resolver MUST use it for its own writes and MUST NOT
   * open a nested transaction. Cron path (PR-10) does not pass one.
   *
   * Honoured directly by `MediaAssetResolver` and `MealPlanAssetResolver`
   * (both perform their own writes). `WorkoutAssetResolver` and
   * `AutoMessageAssetResolver` delegate to services that own their internal
   * transactions today; pushing `tx` into them would be an out-of-scope
   * signature change. They rely on the underlying service's own
   * concurrency model (workout: idempotency-key ledger; auto_message:
   * see contract note below).
   */
  tx?: Prisma.TransactionClient;
}

export interface AssignableAssetMaterialiseResult {
  /**
   * Provider-side identifier for the materialised row. Persisted on
   * `ScheduledDrop.materialised_ref` so support can trace a drop fire to
   * the downstream side-effect (ClientWorkoutAssignment.id,
   * DailyMealPlanAssignment.id, CoachMessage.id, ClientAssetGrant.id).
   */
  materialisedRef: string;
}

export interface AssignableAssetResolver {
  readonly assetType: AssignableAssetType;

  /** Strict equality predicate; mirrors `CapabilityMaterializer.canHandle`. */
  canHandle(assetType: string): boolean;

  /**
   * Materialise the deliverable for one client.
   *
   * Idempotency contract — AT-LEAST-ONCE.
   *
   * Most resolvers are exactly-once thanks to a schema-enforced UNIQUE on
   * the per-drop natural key (the loser of a concurrent retry catches
   * P2002 and re-reads the winner's id):
   *   - workout: deterministic idempotency key flows through
   *     `WorkoutBuilderIdempotencyKey`.
   *   - meal_plan: `DailyMealPlanAssignment.drip_drop_id @unique`
   *     (migration 20261203000000_pr7_meal_plan_drip_drop_unique).
   *   - pdf/video: `ClientAssetGrant @@unique(client_id, media_asset_id)`.
   *
   * `auto_message` is the exception — `MessagingService.sendAsCoach` does
   * not today accept a caller-supplied idempotency key (TODO at
   * src/ai/gateway/materialisers/coach-message.materialiser.ts:78-81), so a
   * retry after a partial failure can produce a second CoachMessage row.
   * PR-10's drip executor MUST therefore gate retries on
   * `ScheduledDrop.materialised_ref IS NULL` so a fire that succeeded
   * (even if the executor crashed before persisting the ref) is never
   * replayed. The per-drop dispatch guard belongs in the executor, not in
   * each resolver.
   *
   * Implementations document their per-type idempotency strategy in the
   * file-level comment.
   */
  materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult>;
}
