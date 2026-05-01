# Handoff: #41 Events and Live Calls

> Operator brief. Engineer-facing long form is
> [`docs/specs/events-live-calls.md`](../../specs/events-live-calls.md).

## WHY

Live calls are the single highest-impact retention event a
coach owns; today they happen on Zoom + Calendly + a manual
recording upload, all outside the platform. Owning the
**lifecycle** (schedule → RSVP → reminder → join → record →
recap) inside the platform is the difference between the coach
renewing on the platform and quietly leaving.

## WHEN

Cannot start runtime PR-1 until: WebRTC provider chosen
(LiveKit / Daily / 100ms / Twilio Video) and recorded in
`docs/operations/live-calls.md`; PR #120 lane #05 has recorded
which tier(s) include live calls + per-event minute ceilings;
recording-default decision (per-coach? per-event?); calendar-
invite path (`.ics` mint vs Google/Apple integration); reminder
channels for v1 (push vs push+email).

## WHERE

New module `src/events/` peer to `src/community/`. Five new
tables: `Event`, `EventRSVP`, `EventAttendance`,
`EventRecording`, `EventReminder`. New env-var family
`LIVE_CALLS_*`. The platform never proxies media — provider
abstraction returns a one-shot signed token + URL. No
`new-website` change.

## WHO

Founder owns: tier mapping (events/month, minutes/event),
recording defaults, refund posture for "coach didn't show."
Backend lead owns: provider choice, provider-pluggable
shape (spec defaults: pluggable from day one). Mobile owns:
WebRTC SDK shape, mic/cam permission posture (spec defaults:
join-muted + cam-off). Coach console owns: scheduling +
attendance roster surfaces. OWNER on the pager for first
30 days; provider outages must not corrupt RSVPs.

## WHAT

Already exists: `User`, `CoachProfile`, `SubscriptionGuard`,
`@nestjs/schedule` (cron), `NotificationPreferences`,
`AuditLog`, `StripeProcessedEvent` (idempotency pattern reused
for provider webhook).

Net-new: 5 tables, provider abstraction, reminder cron with
idempotent `EventReminder` rows, attendance ledger (joined_at
/ left_at / duration), recording-ready webhook handler with
HMAC verification, optional `.ics` mint.

Non-goals: recurring events as a first-class concept (v1 ships
one-shot only; client-side fan-out from a template at PR-1);
multi-coach co-hosted events (waiting on PR #118 Team Mode);
PSTN dial-in; in-event polls/Q&A (provider-native); 1-on-1
live-coaching sessions (handled by messaging).

## HOW

8-PR rollout (spec §7.1). PR-1 is schema + empty `[]`
behind `LIVE_CALLS_ENABLED=false`. Provider integration lands
PR-3, recording webhook PR-5, attendance ledger PR-6.

Smallest first PR ships: schema, module mounted, empty `[]`,
smoke assertion, OpenAPI export update. Zero provider code.

## Risks (top 3)

1. Provider outage during a scheduled event. Mitigation:
   graceful 503 + `provider_unavailable` envelope; recording
   webhook is durable + replays.
2. Cost runaway — coach schedules 200 hours of calls.
   Mitigation: per-tier monthly minutes cap with OWNER alert
   at 80%, hard-block at 100%.
3. Reminder spam from cron double-fire. Mitigation:
   `EventReminder` unique on `(event_id, fires_at, channel)`
   + status flip in same transaction.

## Acceptance criteria (one-line)

Coach schedules a 60-min event → reminders fire on schedule
(T-24h, T-1h, T-5min) → 3 RSVPs yes → 2 attend → recording
auto-archives to the content library (row #42) → OWNER
dashboard tile reflects attendance rate within 5 min of
finalize → revert = flag flip.

## Operator handoff

- **Kill-switch:** `fly secrets set LIVE_CALLS_ENABLED=false
  -a tgp-backend-prod`. In-flight tokens expire on their own.
- **Dashboards:** PR #120 lane #06 dashboard receives
  attendance-rate, recording-storage, minutes-cap-utilization
  tiles.
- **Runbook entry:** `docs/operations/live-calls.md` (future
  doc) covers provider rotation, recording retention, refund
  triage, `provider_unavailable` failover.
- **First 30 days:** OWNER reads
  `events_attendance_rate_p50_p90` weekly; any coach < 30%
  attendance is the on-call signal for a retention check-in.

## Cross-references

- Engineer spec: [`docs/specs/events-live-calls.md`](../../specs/events-live-calls.md)
- Adjacent specs: [`community-spaces.md`](../../specs/community-spaces.md),
  [`replays-content-library.md`](../../specs/replays-content-library.md),
  [`ai-business-copilot.md`](../../specs/ai-business-copilot.md)
- Related drafts: PR #117, #118, #120, #121, #122 (mastermind
  Phase 2 cohort surface reuses lifecycle), #123 (#36).
