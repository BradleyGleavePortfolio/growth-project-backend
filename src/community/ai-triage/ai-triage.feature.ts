/**
 * v2-4 — `FEATURE_COMMUNITY_AI_TRIAGE` env flag (default OFF).
 *
 * Gates the community AI inbox-triage surface (the GET generation endpoint).
 * Mirrors the literal `'true'` convention used by `acksEnabled()`
 * (ack.feature.ts) and `planTagsEnabled()` (plan-context.service.ts): the flag
 * is ON only when the env var is exactly the string `'true'`. Absent or any
 * other value (empty, `'false'`, `'1'`, mixed case) resolves OFF — so the AI
 * surface is dark by default and a misspelled value fails safe.
 *
 * Kill-switch invariant: when OFF, the generation route short-circuits with a
 * byte-identical 404 (AiTriageFeatureFlagGuard) and the human coach inbox
 * (CommunityCoachInboxService / GET /community/me/coach-inbox) is entirely
 * untouched — no AI code runs on that read path.
 */

/** Env var name for the community AI inbox-triage switch (default OFF). */
export const FEATURE_COMMUNITY_AI_TRIAGE_ENV = 'FEATURE_COMMUNITY_AI_TRIAGE';

/**
 * True only when `FEATURE_COMMUNITY_AI_TRIAGE` is exactly `'true'`. Any other
 * value resolves OFF — the kill-switch default. Read at call time (never
 * boot-cached) so tests can mutate the env per-case.
 */
export function aiTriageEnabled(): boolean {
  return process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV] === 'true';
}
