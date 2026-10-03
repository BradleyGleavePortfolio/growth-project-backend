/**
 * A5-COACH-BRIEF — `FEATURE_COACH_BRIEF_ROMAN` env flag (default OFF).
 *
 * Gates the Roman layer of the coach daily brief:
 *   - the deterministic butler-tone highlights (`summary.roman`),
 *   - Roman reply drafts for unread client messages (box-2 consent gated),
 *   - the /coach/brief/drafts routes.
 *
 * ON only when the env var is exactly the string `'true'` (the
 * FEATURE_COMMUNITY_* convention). Absent, empty, `'1'`, `'TRUE'` or any
 * other value resolves OFF, so a typo fails safe. Read at call time (never
 * boot-cached) so the kill switch takes effect on the next request and
 * tests can flip it per case.
 *
 * Kill-switch invariant: with the flag OFF the existing brief (narrative,
 * action items, push) is byte-for-byte the pre-A5 behaviour: no reply-draft
 * code runs, `summary.roman` is null, and the drafts routes return 404.
 */
export const FEATURE_COACH_BRIEF_ROMAN_ENV = 'FEATURE_COACH_BRIEF_ROMAN';

export function coachBriefRomanEnabled(): boolean {
  return process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] === 'true';
}
