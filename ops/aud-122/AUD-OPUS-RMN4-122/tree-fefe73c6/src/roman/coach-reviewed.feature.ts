/**
 * ED.6 (Roman "coach-is-watching" micro-signal) —
 * `FEATURE_ROMAN_COACH_REVIEWED_AT` master switch (DEFAULT OFF).
 *
 * Gates the SIDE-EFFECT writes that stamp a coach review:
 *   - CheckInsService re-stamps `CheckIn.coach_reviewed_at` when a coach marks
 *     a check-in reviewed.
 *   - MessagingService upserts a `ConversationReview` row (per (coach, client)
 *     thread) when a coach reads / marks the thread read.
 *
 * While the flag is OFF, NO review timestamp is ever written: the column stays
 * NULL and the marker row is never created, so the client-facing CompetencePill
 * (mobile, gated independently by EXPO_PUBLIC_FF_ROMAN_COMPETENCE_PILL) renders
 * nothing. The two flags are independent so the feature can ship
 * asymmetrically: mobile flag ON + backend flag OFF → the field is always null
 * → pill never renders → no behaviour change (brief §Feature flags).
 *
 * Resolution mirrors `isRomanChatEnabled()` (src/roman/roman.feature.ts): ON
 * ONLY when the env value is exactly `'true'` (case-insensitive). Unset / empty
 * / any other value → OFF — the default-OFF invariant, identical in every
 * environment. The flag is read at the call site every request (never
 * boot-cached) so a runtime flip takes effect without a redeploy.
 */

/** Env var name for the ED.6 coach-reviewed side-effect writes (default OFF). */
export const FEATURE_ROMAN_COACH_REVIEWED_AT_ENV =
  'FEATURE_ROMAN_COACH_REVIEWED_AT';

function isExplicitlyTrue(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

/**
 * True when the ED.6 coach-reviewed side-effect writes are enabled. Single
 * authority every write path consults before stamping a review timestamp.
 *
 * Resolution: ON only when the env value is exactly `'true'`. Unset / empty /
 * any other value → OFF (the default-OFF invariant, identical in every env).
 */
export function isCoachReviewedAtEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isExplicitlyTrue(env[FEATURE_ROMAN_COACH_REVIEWED_AT_ENV]);
}
