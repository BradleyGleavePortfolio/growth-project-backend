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
   *
   * IMPORTANT: ScheduledDrop UUIDs are regenerated when the outer fan-out
   * `$transaction` rolls back (the row is gone; the retry's `createMany`
   * mints a fresh UUID). Resolvers MUST NOT use this id as their
   * cross-retry idempotency key — see `clientPurchaseId` + `contentId`
   * below, both of which ARE stable across rollback+retry.
   */
  scheduledDropId?: string | null;
  /**
   * PR-9 R1 — STABLE keys for cross-rollback idempotency. The
   * (clientPurchaseId, contentId) pair is the only key that survives an
   * outer-tx rollback + Stripe webhook retry:
   *   - `clientPurchaseId` is the existing pre-flip ClientPurchase row;
   *     the webhook only mutates `entitlement_active`, never the id.
   *   - `contentId` is the CoachPackageContent authoring id, owned by the
   *     coach, immutable across buyer-side webhook activity.
   *
   * Resolvers whose downstream side-effect commits OUTSIDE the outer tx
   * (today: `WorkoutAssetResolver` via WorkoutBuilderService's internal
   * ledger; `AutoMessageAssetResolver` via DripResolverMarker) MUST key
   * their dedup on this pair when both are present.
   *
   * Optional only because PR-10's cron path can pass `scheduledDropId`
   * alone (drop already committed; its UUID is stable from that point
   * forward); the inline-checkout path always passes both.
   */
  clientPurchaseId?: string | null;
  contentId?: string | null;
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
   * Resolvers are exactly-once across the inline-checkout rollback+retry
   * path when keyed on the STABLE `(clientPurchaseId, contentId)` pair —
   * scheduledDropId is regenerated when the outer tx rolls back, so
   * resolvers whose side-effects commit outside the outer tx MUST NOT
   * key dedup on it:
   *   - workout: WorkoutBuilderIdempotencyKey value
   *     `drip:workout:p={purchaseId}:c={contentId}` (stable across
   *     rollback+retry); ledger writes via this.prisma persist outside
   *     the outer tx and the retry replays the cached row.
   *   - auto_message: durable `DripResolverMarker(purpose='auto_message',
   *     purchase_id, content_id)` claimed BEFORE sendAsCoach;
   *     `materialised_ref` updated after. A retry observes the marker
   *     and returns the cached CoachMessage id — see PR-9 R1 audit-fix.
   *   - meal_plan: `DailyMealPlanAssignment.drip_drop_id @unique` —
   *     the per-drop key DOES regenerate on rollback, but the write
   *     rides the outer tx so a rollback erases the row entirely; the
   *     retry starts from a clean slate.
   *   - pdf/video: `ClientAssetGrant @@unique(client_id, media_asset_id)`
   *     — composite is stable regardless of drop-UUID churn.
   *
   * PR-10's cron path (drop already committed; UUID stable from that
   * point forward) may pass only `scheduledDropId` — each resolver's
   * fallback path keys on that. The executor (PR-10) still gates
   * retries on `ScheduledDrop.materialised_ref IS NULL` for defense in
   * depth.
   *
   * Implementations document their per-type idempotency strategy in the
   * file-level comment.
   */
  materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult>;
}
