Tier: T2
Why: one read query in GET /scheduling/my-coaches (the welcome-call marker). No write path, money, auth, tenancy, PII, schema or flag change.
T4 trigger scan: none (no auth, RLS/tenancy, PII, money, credentials or destructive data). The query keeps `client_id: actor.id` and the bookable-coach ids exactly as before.
T3 trigger scan: none (no migration, no API contract change: `welcome.completed_at` keeps its type and meaning "the client has had the welcome call").
Bounded T1: n/a.
Canonical builder: AUDIT-04-125 (agent 125, Claude Opus 5.5).
Acceptance evidence: two new cases in test/scheduling-lifecycle-integrity.spec.ts (a confirmed welcome call whose end has passed reads as done; cancelled, missed, declined, expired and unanswered ones keep the call bookable). The first fails on main (completed_at is null there). PR CI runs the suite and full typecheck.

## U fixed

- U-04-1: a client who had their welcome call yesterday opens Calendar and is told "Book your welcome call with Bradley" again (and can book a second one), because the coach app has no "mark complete" step, so the session stays `scheduled` and the marker only counted `completed` sessions.

Fix: `listMyCoaches` counts a welcome session as had when it is `completed`, or when it is `scheduled` / `pending_provider` and its end time has passed. No-show, cancelled, declined and expired calls still leave the welcome call bookable. Mobile already reads `welcome.completed_at` (CalendarHomeScreen WelcomeCard, CalendarBookScreen welcome-done state), so no mobile change is needed and every shipped build picks this up on deploy.

## Scope

2 files, +45 / -1 (tests included). No overlap with open PRs (b#781 touches slot-computer only).

Nothing merged or deployed.
