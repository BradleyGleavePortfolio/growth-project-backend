/**
 * Roman Phase 2 — `FEATURE_ROMAN_COPY_V2` master switch (DEFAULT OFF).
 *
 * Phase 2 swaps the in-app notification copy across seven Roman-voiced
 * surfaces (dunning Day 0/1/3/7, Day-10 lockout, paywall, billing-update,
 * the ED.3 first-payment confirmation, the empty notification list, and the
 * onboarding welcome) for the locked Roman Option-3 brand voice. The swap is
 * gated behind this single flag so it can be rolled back instantly.
 *
 * While the flag is OFF, `VoicePolicyService.copyFor()` returns the LEGACY
 * copy verbatim — byte-for-byte identical to what each surface returned before
 * this PR, pinned by a snapshot contract test. While it is ON, each surface
 * returns its Roman Option-3 variant.
 *
 * Resolution mirrors `isRomanChatEnabled()` (src/roman/roman.feature.ts) and
 * `isDunningV2Enabled()`: ON only when the env value is exactly `'true'`
 * (case-insensitive). Unset / empty / any other value resolves to OFF — the
 * default-OFF invariant, identical in every environment. There is no
 * dev/test auto-enable and no silent environment-dependent behaviour.
 */

/** Env var name for the Roman copy-v2 master switch (default OFF everywhere). */
export const FEATURE_ROMAN_COPY_V2_ENV = 'FEATURE_ROMAN_COPY_V2';

/**
 * True ONLY when `FEATURE_ROMAN_COPY_V2` is exactly `'true'`
 * (case-insensitive). Unset / empty / any other value resolves to OFF. This is
 * the single authority every Phase 2 copy callsite consults before swapping a
 * string.
 */
export function isRomanCopyV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[FEATURE_ROMAN_COPY_V2_ENV] ?? '').toLowerCase() === 'true';
}
