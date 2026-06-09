/**
 * Roman Phase 1 — `FEATURE_ROMAN_CHAT_ENABLED` master switch (DEFAULT OFF).
 *
 * Phase 1 ships the chat MVP backend FLAG-OFF by default (brief §0 / §1.6).
 * Mobile UI is not wired yet, so the surface must be invisible in production
 * until the operator explicitly flips the flag.
 *
 * This is a SERVER-SIDE CODE-LEVEL INVARIANT, not merely a UI hint:
 *   - `RomanFeatureGuard` returns 404 (NotFoundException) on every `/roman`
 *     route while the flag is OFF — the controller stays mounted (so the
 *     module-graph cycle guard keeps exercising it) but the surface is
 *     indistinguishable from "no such route" to any caller.
 *   - `RomanService` re-checks the flag before any Anthropic call as
 *     defence-in-depth, so even an internal caller cannot drive the model
 *     while the feature is disabled.
 *
 * Resolution mirrors `isContractsEnabled()` (src/contracts/contracts.feature.ts)
 * EXCEPT Roman has no dev/test auto-enable: the flag is treated as ON ONLY when
 * the value is exactly `'true'` (case-insensitive). This keeps the default-OFF
 * posture identical across every environment — tests that need the feature ON
 * set `FEATURE_ROMAN_CHAT_ENABLED=true` explicitly, which is the same switch an
 * operator flips in prod. No silent environment-dependent behaviour.
 */

/** Env var name for the Roman chat master switch (default OFF everywhere). */
export const FEATURE_ROMAN_CHAT_ENABLED_ENV = 'FEATURE_ROMAN_CHAT_ENABLED';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the Roman chat feature is enabled. Single authority every entry
 * point consults before exposing a route or touching the model.
 *
 * Resolution: ON only when the env value is exactly `'true'`. Unset / empty /
 * any other value → OFF (the default-OFF invariant, identical in every env).
 */
export function isRomanChatEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_ROMAN_CHAT_ENABLED_ENV]);
}
