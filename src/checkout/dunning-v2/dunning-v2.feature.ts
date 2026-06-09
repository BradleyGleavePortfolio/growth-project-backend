/**
 * B3 — `FEATURE_DUNNING_V2` master switch (DEFAULT OFF).
 *
 * Every Smart Dunning v2 code path — the 4-attempt cadence engine
 * (`[0, 1, 3, 7]`), the Day-10 hard-lockout sweep + guard, the late-reversal
 * handler, the Roman-voice dispatchers, and the branded recovery links — is
 * gated behind this single flag. While it is OFF the v1 dunning service
 * (PR #281) remains the active default and NONE of the v2 surfaces fire: the
 * lockout guard short-circuits to a no-op, the v2 cadence service refuses to
 * open a cycle, and the new schema columns (`locked_out_at`, `reversal_count`)
 * are never written by any code path.
 *
 * Posture mirrors `isWearablesCloudConnectorsEnabled()`
 * (`src/wearables/cloud-connectors.feature.ts`) and `FEATURE_GOOGLE_CALENDAR_SYNC`:
 * the flag is read from the environment, defaults OFF, and is treated as ON
 * ONLY when the value is exactly `'true'` (case-insensitive). Absent / empty /
 * any other value → OFF. The operator flips it at the R66 / merge gate.
 *
 * There is intentionally no allowlist variant here: v2 dunning is a
 * billing-critical state machine, so it is a clean global on/off rather than a
 * per-user gradual rollout.
 */

/** Env var name for the Smart Dunning v2 master switch (default OFF). */
export const FEATURE_DUNNING_V2_ENV = 'FEATURE_DUNNING_V2';

/**
 * True ONLY when `FEATURE_DUNNING_V2` is exactly `'true'` (case-insensitive).
 * Absent / any other value → OFF. This is the single authority every v2 entry
 * point consults before touching state.
 */
export function isDunningV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[FEATURE_DUNNING_V2_ENV] ?? '').toLowerCase() === 'true';
}
