/**
 * MWB-5 — `FEATURE_MWB_AI_LIVE_CREATE` master switch (DEFAULT OFF).
 *
 * MWB-5 introduces two live-create gateway capabilities — `draft.create_workout_plan`
 * and `draft.edit_workout_plan` — that write real WorkoutPlan / WorkoutPlanRevision
 * rows on approval. They ship ADDITIVELY ALONGSIDE the legacy
 * `materializeWorkoutProgram` path (src/ai/coach/coach-ai.service.ts), which is
 * UNTOUCHED in this slice; clients choose which path to use. The operator-decision-B
 * deletion of the legacy path is a SEPARATE later slice (brief §"Feature flag").
 *
 * This is a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint. While the
 * flag is OFF the two capabilities are NOT in the gateway capability allow-list,
 * so `AiGatewayService.invoke` resolves them as `capabilityAllowed=false` and
 * rejects them BEFORE any `AiActionDraft` row is created (brief Test matrix #7).
 * A defence-in-depth re-check also runs inside each materialiser so an internal
 * caller cannot drive a live-create while the feature is disabled (R0: never a
 * silent bypass).
 *
 * Resolution mirrors `isMwbTemplatesEnabled()` (src/workout-builder/mwb-templates.feature.ts):
 * the flag is treated as ON ONLY when the value is exactly `'true'`
 * (case-insensitive). Reading process.env on every call (never at module load)
 * keeps tests deterministic and lets an operator flip the switch without a
 * redeploy.
 */

/** Env var name for the MWB-5 live-create master switch (default OFF everywhere). */
export const FEATURE_MWB_AI_LIVE_CREATE_ENV = 'FEATURE_MWB_AI_LIVE_CREATE';

/** Capability strings gated by the MWB-5 live-create flag. Single source of truth. */
export const MWB_LIVE_CREATE_CAPABILITIES = [
  'draft.create_workout_plan',
  'draft.edit_workout_plan',
] as const;

export type MwbLiveCreateCapability =
  (typeof MWB_LIVE_CREATE_CAPABILITIES)[number];

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the MWB-5 live-create feature is enabled. Single authority every
 * entry point (gateway capability gate + both materialisers) consults before
 * exposing or materialising a live-create capability.
 *
 * Resolution: ON only when the env value is exactly `'true'` (case-insensitive).
 * Unset / empty / any other value resolves to OFF — the default-OFF invariant,
 * identical in every environment.
 */
export function isMwbAiLiveCreateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_MWB_AI_LIVE_CREATE_ENV]);
}

/** True when `capability` is one of the two MWB-5 live-create capabilities. */
export function isMwbLiveCreateCapability(
  capability: string,
): capability is MwbLiveCreateCapability {
  return (MWB_LIVE_CREATE_CAPABILITIES as readonly string[]).includes(
    capability,
  );
}
