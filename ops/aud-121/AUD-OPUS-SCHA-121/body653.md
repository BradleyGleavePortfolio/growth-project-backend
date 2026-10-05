## Tier header

- **Tier:** T4
- **Why:** adds a `SessionStatus` enum value (`expired`), a `CoachingSession` column + index, a new table (`SchedulingJobLease`, RLS enabled + forced), a new 5-minute cron that writes session state and sends notifications to both sides, and changes which rows hold a slot.
- **T4 trigger scan:** enum/status-set change: yes. New table with RLS: yes. Cron writing user-visible state: yes. Notification fan-out: yes (one notice per side, receipts in NotificationDeliveryLog). Auth/tenancy change: no (all reads/writes keep existing assignment gates). Payments: no. Production config/env: no new env reads (fixed cron, constants in code).
- **T3 trigger scan:** migration with backfill (pending requests get a deadline measured from deploy time): yes. API response shape: additive (`request_expires_at`, status `expired`, error code `REQUEST_EXPIRED`).
- **Bounded T1:** none.
- **Builder-owner:** agent 113 (Claude Opus 5.5 builder), lane S-SCHED-5 (OR-112-5).
- **Acceptance evidence:** `test/scheduling-request-expiry.spec.ts` (rule, lifecycle at the clear time, slot frees at exactly the clear time without the sweep, sweep notices to both sides, idempotent re-run, two-runner lease, held/expired lease, quiet close of old requests, per-channel retry, give-up after 3, migration/RLS/down contract); existing scheduling suites unchanged. Local: `jest test/scheduling-request-expiry.spec.ts test/scheduling-lifecycle-integrity.spec.ts test/scheduling-delivery-status-contract.spec.ts test/booking-reminder.job.spec.ts test/scheduling-reminder-delivery.spec.ts` 148/148 at `17b2be25`; eslint + prettier clean. CI runs on this stacked PR (base `agent110/s-sched-lifecycle`). Not yet covered: a live-Postgres case for the enum value, exclusion-constraint release and lease table (recommended before promotion).
- **Promotion triggers:** retarget to `main` after #634 merges; re-run the full required set; operator runs the pre-deploy query below.

## What it does

A pending booking request now has one clear time by which the coach must answer:

- **Rule** (`requestExpiresAt`): the earlier of 48 hours after the request and 1 hour before the start. A short-notice request that would leave the coach under 30 minutes stays open until the start (approval already stops at the start).
- Set on request (only when the result is `requested`) and again when a client move asks the coach again (fresh window). Cleared on approval.
- **At the clear time** the request reads as `expired` everywhere, before any sweep runs: session view (`status: 'expired'`, not cancellable, not reschedulable), open slots (the time is offered again), welcome-call state, and approve/decline/cancel/move return `409 REQUEST_EXPIRED` with per-side copy and `request_expires_at` in the body. Every request transition is compare-and-set fenced on `request_expires_at > now`, so a confirm racing the deadline loses cleanly.
- **The slot frees at the clear time:** the booking and move transactions (per-coach advisory lock) close that coach's lapsed requests first (`expireLapsedForCoach`, compare-and-set, audited `session.expired` with `source: booking`), so the exclusion constraint (which counts only requested/scheduled/pending_provider) lets the new booking in.
- **Sweep** (`BookingRequestExpiryJob`, every 5 minutes, one machine via `SchedulingJobLease` "booking-request-expiry", 4-minute ttl, released after the tick; same acquisition rule as the S-FEE CronLease in #627):
  1. expire every lapsed request (keyset pages of 200, oldest deadline first, bounded per tick), audit `session.expired` (`source: sweep`), invalidate open-slot cache;
  2. recover notice rows left `retry` or `sending` with an expired lease (re-send only the channel that did not land, max 3 attempts, then `gave_up` with `retired:<reason>`);
  3. announce each request closed in the last 24 hours that has no notice rows: both sides' `booking_request_expired` rows are claimed in one transaction (unique session+user+kind), then delivered. Requests whose time passed more than 24 hours ago close quietly.
- **Notices** (calm, no blame, recipient time zone, routed like other booking pushes: client to CalendarSession, coach to CoachBookingInbox):
  - client: "Your <type> request for <when> was not confirmed in time, so it has closed. Pick another time in Calendar."
  - coach: "<client>'s <type> request for <when> closed without an answer, and the time is open again."

## Migration `20270226000000_scheduling_request_expiry`

- `ALTER TYPE "SessionStatus" ADD VALUE IF NOT EXISTS 'expired'` (the value is not used in the same migration).
- `CoachingSession.request_expires_at TIMESTAMP(3)` + index `(status, request_expires_at)`.
- Backfill of existing `requested` rows measured from deploy time (no coach loses answer time to the deploy; nothing with a future start expires at deploy). Rows whose start already passed get `request_expires_at = start_at` and are closed quietly by the first sweep.
- `SchedulingJobLease` with RLS enabled + forced, `service_role` ALL and `app.is_owner()` policies.
- `down.sql`: drops table, index and column; moves any `expired` rows to `declined` (`end_reason = request_expired`) so the previous code reads them; the enum value stays (Postgres cannot drop one in place).

### Pre-deploy check (operator, read-only)

```sql
-- How many pending requests the backfill touches, and how many will close quietly on the first sweep.
SELECT count(*) FILTER (WHERE start_at > now()) AS future_pending,
       count(*) FILTER (WHERE start_at <= now()) AS past_start_pending
FROM "CoachingSession" WHERE status = 'requested';
```

## Merge order and overlap

- Stacked on #634 (`agent110/s-sched-lifecycle`). Needs #634's lifecycle, exclusion constraint and NotificationDeliveryLog delivery state.
- Mobile pair: growth-project-mobile PR (agent113/s-sched-expiry-mobile, stacked on #325).
- #627 owns `CronLease`; this PR uses its own `SchedulingJobLease` table so the two do not collide.

## Fix round

| Finding | Change | Commit | Test |
|---|---|---|---|
| (none yet) | | | |

