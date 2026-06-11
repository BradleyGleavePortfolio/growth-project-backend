/**
 * MWB-2 — `FEATURE_MWB_TEMPLATES` master switch (DEFAULT OFF).
 *
 * MWB-2 ships the clone-a-template-onto-a-client surface flag-OFF by default
 * (MASTER_BUILD_PLAN.md §3.3 / BUILDER_BRIEF §"Feature flag behavior"). The
 * mobile + coach-web surfaces are not wired to this endpoint yet, so it must
 * be invisible in production until an operator explicitly flips the flag.
 *
 * This is a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint:
 *   - `MwbTemplatesFeatureGuard` returns 404 (NotFoundException) on the
 *     MWB-2 clone-to-client route while the flag is OFF. The controller stays
 *     MOUNTED at all times (so the module-graph cycle guard keeps exercising
 *     the wiring) but the surface is indistinguishable from "no such route" to
 *     any caller — never a 403, which would leak that the feature exists.
 *   - `WorkoutBuilderService.cloneProgramToClient` re-checks the flag before
 *     any DB read as defence-in-depth (R0: never a silent bypass), so even an
 *     internal caller cannot drive a clone while the feature is disabled.
 *
 * Resolution mirrors `isRomanChatEnabled()` (src/roman/roman.feature.ts): the
 * flag is treated as ON ONLY when the value is exactly `'true'`
 * (case-insensitive). This keeps the default-OFF posture identical across every
 * environment — tests that need the feature ON set `FEATURE_MWB_TEMPLATES=true`
 * explicitly, the same switch an operator flips in prod. No silent,
 * environment-dependent behaviour.
 */

/** Env var name for the MWB-2 templates master switch (default OFF everywhere). */
export const FEATURE_MWB_TEMPLATES_ENV = 'FEATURE_MWB_TEMPLATES';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the MWB-2 templates / clone-to-client feature is enabled. Single
 * authority every entry point consults before exposing the route or running a
 * clone.
 *
 * Resolution: ON only when the env value is exactly `'true'` (case-insensitive).
 * Unset / empty / any other value resolves to OFF — the default-OFF invariant,
 * identical in every environment.
 */
export function isMwbTemplatesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_MWB_TEMPLATES_ENV]);
}
