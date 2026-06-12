/**
 * v2-2 — `FEATURE_COMMUNITY_ACKS` env flag (default OFF).
 *
 * Gates the coach ack-signal surface: the POST transition endpoints and the
 * ack envelope enrichment on message reads / inbox rows. Mirrors the literal
 * `'true'` convention used by `planTagsEnabled()` (plan-context.service.ts):
 * the flag is ON only when the env var is exactly the string `'true'`. Absent
 * or any other value → OFF, so the surface is dark by default and a misspelled
 * value fails safe (kill-switch invariant).
 */

/** Env var name for the coach ack-signals switch (default OFF). */
export const FEATURE_COMMUNITY_ACKS_ENV = 'FEATURE_COMMUNITY_ACKS';

/**
 * True only when `FEATURE_COMMUNITY_ACKS` is exactly `'true'`. Any other value
 * (unset, empty, `'false'`, `'1'`, mixed case) resolves OFF — the kill-switch
 * default. When OFF: the transition endpoints short-circuit (404) and reads
 * omit the ack envelope, leaving the v1-6 inbox/message shape untouched.
 */
export function acksEnabled(): boolean {
  return process.env[FEATURE_COMMUNITY_ACKS_ENV] === 'true';
}
