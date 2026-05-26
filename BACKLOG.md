# Backlog

Tracked follow-up items that are too large or too disruptive for the current PR
but must not be lost.

---

## BL-GDPR-BRIEF-2 — Client PII embedded in `CoachBrief.brief_context` JSON has no FK scrub path

**Opened by:** A1-PR266-P1-1 fix (PR #266, commit `fix(gdpr): scrub Coach Brief tables on soft-delete`)
**Priority:** P2 (no new violation introduced; gap pre-dates this PR and is acknowledged)
**Regulation:** GDPR Art. 17 (erasure) / Art. 5(1)(e) (storage limitation)

### Background

The P1 fix in PR #266 adds four `deleteMany` calls inside `GdprScrubService.scrubOne`
to hard-delete a **scrubbed coach's** own `CoachBrief`, `CoachDailyLog`,
`CoachBriefPreferences`, and `CoachBriefPushLedger` rows.

However, `CoachBrief.brief_context` is a Json blob assembled server-side from
**multiple clients' data** (`coach-brief.service.ts:963-984, 544-598`):
client first names, weight deltas, check-in notes, and message previews.  There
is **no `client_id` FK column** on `CoachBrief` — the client identity is embedded
as text inside the Json value.

Consequence: when a **client** is scrubbed (not the coach), that client's first
name and metrics remain embedded in every head/sub/solo coach's `brief_context`
whose daily brief was generated while the client was active.  The four `deleteMany`
calls added in PR #266 operate on `coach_id`, so they do not address this
client-name-in-other-coaches'-briefs scenario.  No FK-cascade path exists even
in principle for this case.

### Proposed mitigations (either satisfies GDPR Art. 17)

**(a) TTL-drop brief rows older than 24 h (preferred near-term fix)**
Daily briefs are superseded immediately on regeneration; a cron that drops
`CoachBrief` rows where `brief_date < now() - INTERVAL '1 day'` eliminates
stale PII within 24 h of generation.  Briefs in active use (today's brief)
are unaffected.  Simple, low-risk, achievable in a small PR.

**(b) Re-architect `brief_context` to store `client_id` only, resolve names at render time**
`brief_context` stores `client_id` (UUID) alongside the plain-text fields.
At brief-render time the service resolves names from the live `User` table.
After a client is scrubbed, their `User.name` is already tombstoned to
`'Deleted user'`, so render-time resolution automatically redacts the name
without needing to touch the brief row.  Higher engineering effort; requires
a migration + service change + client-app cache invalidation review.

### Acceptance criteria for whichever mitigation is chosen

- A scrubbed client's first name is no longer present in any coach's
  `brief_context` within the GDPR Art. 17 response window (30 days).
- Existing tests in `test/gdpr-scrub.service.spec.ts` continue to pass.
- A regression test covers the client-scrub → coach-brief redaction path.

### Out of scope for this item

- The coach-side scrub (already fixed by PR #266 P1-1).
- `CoachDailyLog.content` text search (no `client_id` reference; mitigated by
  the fact that logs are keyed to the coach, and coach scrub already deletes
  them; client names typed by a coach into a log are a separate editorial concern
  tracked under general free-text PII hygiene).
