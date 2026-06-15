/**
 * F2 — `FEATURE_NAMED_REGIMES` master switch (DEFAULT OFF).
 *
 * Named Regimes + the partial-refund coach-decision surface ship flag-OFF by
 * default. The mobile + coach-web surfaces are gated behind
 * `EXPO_PUBLIC_FF_NAMED_REGIMES` (mobile) and this flag (backend); both must
 * be invisible in production until an operator explicitly flips them.
 *
 * This is a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint:
 *   - `NamedRegimesFeatureGuard` returns 404 (NotFoundException) on every
 *     regime + partial-refund-decision route while the flag is OFF. The
 *     controllers stay MOUNTED at all times (so the module-graph guard keeps
 *     exercising the wiring) but the surfaces are indistinguishable from "no
 *     such route" — never a 403, which would leak that the feature exists.
 *   - The partial-refund hook in RefundDisputeHandlerService re-checks the
 *     flag before writing a PartialRefundDecision row, so no decision rows are
 *     created while the feature is disabled.
 *
 * Resolution mirrors `isMwbTemplatesEnabled()`: ON ONLY when the value is
 * exactly `'true'` (case-insensitive). Default-OFF in every environment.
 */

/** Env var name for the F2 named-regimes master switch (default OFF everywhere). */
export const FEATURE_NAMED_REGIMES_ENV = 'FEATURE_NAMED_REGIMES';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the F2 named-regimes feature is enabled. Single authority every
 * entry point consults before exposing a route or writing a decision row.
 *
 * Resolution: ON only when the env value is exactly `'true'` (case-insensitive).
 * Unset / empty / any other value resolves to OFF — the default-OFF invariant.
 */
export function isNamedRegimesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_NAMED_REGIMES_ENV]);
}
