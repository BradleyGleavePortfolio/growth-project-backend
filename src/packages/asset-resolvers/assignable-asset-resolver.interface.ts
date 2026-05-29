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
   * Optional originating ScheduledDrop id. Currently only used by the
   * pdf/video resolver for `ClientAssetGrant.granted_via_drop_id`.
   */
  scheduledDropId?: string | null;
  /**
   * Ambient Prisma transaction. When provided (immediate-at-checkout inline
   * fan-out path), the resolver MUST use it for its own writes and MUST NOT
   * open a nested transaction. Cron path (PR-10) does not pass one.
   *
   * Note: resolvers that delegate to a service which opens its own
   * transaction (workout, meal_plan, auto_message) cannot push the tx into
   * that service today — they rely on the service's own idempotency. Only
   * pdf/video performs its own writes here and therefore honours `tx`
   * directly.
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
   * Materialise the deliverable for one client. MUST be idempotent — the
   * drip executor (PR-10) may retry on transient failure. Idempotency
   * strategy is documented per implementation.
   */
  materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult>;
}
