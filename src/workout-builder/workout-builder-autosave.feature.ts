/**
 * MWB-3 — `FEATURE_MWB_AUTOSAVE_UNDO` master switch (DEFAULT OFF).
 *
 * MWB-3 ships the autosave + real-undo HTTP surface plus the revision-prune
 * cron flag-OFF by default (MASTER_WORKOUT_BUILDER_SPEC.md §5/§6 / BUILDER_BRIEF
 * §"Feature flag"). Neither mobile (Phase 4) nor coach-web is wired to these
 * endpoints yet, so the surface must be invisible in production until an
 * operator explicitly flips the flag.
 *
 * This is a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint — it mirrors
 * the MWB-2 `isMwbTemplatesEnabled()` posture exactly:
 *   - `MwbAutosaveUndoFeatureGuard` returns 404 (NotFoundException) on the
 *     autosave + undo routes while the flag is OFF. The controller stays MOUNTED
 *     at all times (so the module-graph cycle guard keeps exercising the wiring)
 *     but the surface is indistinguishable from "no such route" to any caller —
 *     never a 403, which would leak that the feature exists.
 *   - `WorkoutBuilderAutosaveService` re-checks the flag as the FIRST operation
 *     inside every Serializable transaction as defence-in-depth (R0: never a
 *     silent bypass), so even an internal caller — or an operator who flips the
 *     flag OFF mid-flight — cannot drive a write while the feature is disabled.
 *   - `WorkoutBuilderRevisionPruneCron` self-checks the flag and no-ops when off,
 *     so the standing cron never deletes a revision while the feature is dark.
 *
 * Resolution mirrors `isMwbTemplatesEnabled()` (src/workout-builder/
 * mwb-templates.feature.ts): the flag is treated as ON ONLY when the value is
 * exactly `'true'` (case-insensitive). This keeps the default-OFF posture
 * identical across every environment — tests that need the feature ON set
 * `FEATURE_MWB_AUTOSAVE_UNDO=true` explicitly, the same switch an operator flips
 * in prod. No silent, environment-dependent behaviour.
 */

/** Env var name for the MWB-3 autosave/undo master switch (default OFF everywhere). */
export const FEATURE_MWB_AUTOSAVE_UNDO_ENV = 'FEATURE_MWB_AUTOSAVE_UNDO';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the MWB-3 autosave / real-undo / revision-prune feature is enabled.
 * Single authority every entry point consults before exposing a route, running
 * a write, or pruning revisions.
 *
 * Resolution: ON only when the env value is exactly `'true'` (case-insensitive).
 * Unset / empty / any other value resolves to OFF — the default-OFF invariant,
 * identical in every environment.
 */
export function isMwbAutosaveUndoEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_MWB_AUTOSAVE_UNDO_ENV]);
}
