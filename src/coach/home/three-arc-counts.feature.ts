/**
 * ED.2 (Roman three-arc router) — `FEATURE_ROMAN_THREE_ARC_COUNTS` master
 * switch (DEFAULT OFF).
 *
 * Gates the `GET /coach/home/daily-rings` daily-counts endpoint. While the
 * flag is OFF the route returns a fully ZEROED shape (no Prisma reads) so the
 * mobile widget — itself gated independently by
 * `EXPO_PUBLIC_FF_ROMAN_THREE_ARC_ROUTER` — renders three empty rings
 * gracefully and the surface advertises no behaviour. The two flags are
 * independent so the feature can ship asymmetrically:
 *   mobile flag ON + backend flag OFF → endpoint returns zeros → rings empty
 *   → no behaviour change (brief §Backend).
 *
 * Resolution mirrors `isCoachReviewedAtEnabled()`
 * (src/roman/coach-reviewed.feature.ts): ON ONLY when the env value is exactly
 * `'true'` (case-insensitive). Unset / empty / any other value → OFF — the
 * default-OFF invariant, identical in every environment. The flag is read at
 * the call site every request (never boot-cached) so a runtime flip takes
 * effect without a redeploy.
 */

/** Env var name for the ED.2 daily-rings counts endpoint (default OFF). */
export const FEATURE_ROMAN_THREE_ARC_COUNTS_ENV = 'FEATURE_ROMAN_THREE_ARC_COUNTS';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the ED.2 three-arc daily-counts endpoint is enabled. Single
 * authority the controller/service consult before doing any Prisma read.
 *
 * Resolution: ON only when the env value is exactly `'true'`. Unset / empty /
 * any other value → OFF (the default-OFF invariant, identical in every env).
 */
export function isThreeArcCountsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_ROMAN_THREE_ARC_COUNTS_ENV]);
}
