AUDIT Claude Opus 5.5 — growth-project-backend#653 @ 9a23e3b2471794a1356d9939cc4e06682f1ea7ec — VERDICT: REQUEST CHANGES

A/B/C = 0/2/1

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4: a new enum value in the occupying-status logic, a new table with RLS, and a cron that writes session state and notifies both sides. This is the first full review (nobody had audited this PR before). The base is 9/9 `c2b27193`: 19 files, +1,414/-23 = 1,437 (under 1,500). The restack hunks H1/H2 and F1-F3 (RESTACK 6000468343) are audited below.

### B-653-1: the expiry push puts the client's name and the coach-written type name on the lock screen
- **Where:**
  - `src/notifications/emitters/booking.emitter.ts:417-446`. `emitRequestExpired` builds `body`. For the coach it is `` `${p.otherPartyDisplayName}'s ${what} request${forWhen} closed without an answer, ...` ``. For the client it is `` `Your ${what} request${forWhen} was not confirmed in time, ...` ``, where `what` is the coach-written session-type name.
  - `deliver()` sends that same `body` to `pushToUser` (`:512`, `:561`).
- **Counterexample:** the PR's own sweep case (`test/scheduling-request-expiry.spec.ts:262-305`).
  - The coach's row body is `Client One's Quick Q/A Call request for ... closed without an answer, and the time is open again.`
  - `deliver()` pushes that string, so it lands on a lock screen.
  - The test checks only the push title (`:285-289`).
- **Rule broken:**
  - Lock screens show only fixed per-kind text (push stack B-692-1). "Reminder pushes show no name" (A6.5).
  - It is the same root cause as B-714-1 on 3/9, but this PR adds a new kind with its own text, so it needs its own fix and test.
- **Fix rule:**
  - The push leg for `booking_request_expired` uses fixed text with no name, type or other user-written text. For example, title `Session request closed` and body `A session request has closed. Open the app to see it.`
  - The in-app row keeps the current body. If B-714-1's fix adds a per-kind push-copy map, add this kind to it.
  - Test: both sides' push title and body contain neither the other party's display name nor the type name (use canary values).

### B-653-2: the live-Postgres proof required before promotion is missing
- **Where:**
  - The PR body says: "Not yet covered: a live-Postgres case for the enum value, exclusion-constraint release and lease table (recommended before promotion)".
  - The operator's S-SCHED-5 entry lists it as a TO-DO before #653 is promoted.
  - The PR is no longer a draft, and the file list has no live spec.
- **Why it matters (T4):** three of this PR's claims hold only on a real database, and the fake DB models none of them:
  - `expired` releases the slot under the gist exclusion constraint.
  - The `SchedulingJobLease` takeover is single-winner under READ COMMITTED.
  - The sweep's compare-and-set and approve's compare-and-set cannot both win.
  - The static reading is right: the constraint predicate is `status IN ('requested','scheduled','pending_provider')`, and the takeover is a single conditional UPDATE. But the operator asked for proof.
- **Fix rule:** add a live block on the mwb-3 gate (in `test/scheduling-booking-concurrency.live.spec.ts`, or a new live spec added to the mwb-3 jest list) that proves:
  1. After 20270226000000, an `expired` row and a new `requested` row on the same coach and interval both insert, while two active rows still fail with 23P01.
  2. Two connections calling `tryAcquire` on one expired lease: exactly one acquires.
  3. `expireRequest` racing `approveSession` on one request: exactly one transition lands, and the other gets `REQUEST_EXPIRED` or a state change.
  4. The forced RLS on `SchedulingJobLease` allows the app's own role.
  - If this does not fit in 1,500 lines, put it in its own stacked test PR.

### C-653-3: a request created during the rolling deploy never expires
- **Where:**
  - `src/scheduling/request-expiry.ts:61` and `request-expiry.job.ts:145` select `request_expires_at <= now`.
  - `requestStillOpen` and `isLapsedRequest` treat NULL as open.
- **Counterexample:**
  - Fly's release command applies 20270226000000 (the backfill), then replaces machines one at a time.
  - Until each old machine is replaced, it runs 9/9 code, which creates `requested` rows with `request_expires_at` NULL.
  - Those rows never expire. They hold the slot until the start and count toward `MAX_PENDING_REQUESTS_PER_COACH`.
- **Impact:** the deploy window is short and production booking volume is low.
- **Fix rule:**
  - The sweep first sets `request_expires_at = requestExpiresAt(created_at, start_at)`, compare-and-set on NULL, for `requested` rows that have none.
  - Alternatively, the expire queries treat NULL as that value.
  - Test: a `requested` row with a NULL deadline older than its window is expired by the next tick.

### Audited fine
- **Migration 20270226000000:**
  - `ADD VALUE IF NOT EXISTS 'expired'` is not used in the same file. The backfill uses the same rule as `requestExpiresAt` (48 hours, or 1 hour before the start, with a 30-minute minimum, measured from `now()`). A request whose start has passed is closed at its start and quietly, since it is more than 24 hours old (OR-113-9).
  - The new index and the lease table (RLS enabled and forced, with a `service_role` policy and an `app.is_owner()` policy) look right.
  - `down.sql` moves `expired` rows to `declined`/`request_expired` and then drops the table, the index and the column.
- **Commute:**
  - The name sorts before the applied 20270301000000 (two migrations) and 20270311000000.
  - It touches `SessionStatus`, `CoachingSession.request_expires_at` with its index, and the new `SchedulingJobLease`.
  - No migration after it references any of these. 20270301 zone provenance only reads `CoachingSession.id/start_at` for its backfill. `app.is_owner()` exists (20261212000000).
  - The production-order proof (22 then 26, each deployed on a database already holding 20270301 and 20270311, compared with a fresh chain, plus down and re-apply) is lane run 37367384837. It is queued because of the GitHub runner incident, and its result will be in the next round.
- **Lifecycle:**
  - Approve, decline, cancel and move check `isExpiredOrLapsed` first. Their compare-and-set adds `request_expires_at IS NULL OR > now` while the row is `requested`, so nothing can land at or after the clear time.
  - The booking and move transactions expire the coach's lapsed requests under the per-coach advisory lock before they validate, so a slot is bookable at exactly its clear time.
  - Approve clears the deadline, and a client move that asks the coach again restarts the window.
  - H2 keeps main's B-647-1 (claims are not deleted on a move).
- **Sweep:**
  - The lease takeover is one conditional UPDATE, falling back to an INSERT whose P2002 means "held". Release is holder-scoped.
  - The expire pass is keyset-paged with at most 10 pages of 200 per tick.
  - Notices are claimed for both sides in one transaction, keyed on (session, user, kind, `start_at`) (F1), so the 4-column key prevents a second notice.
  - Recovery re-sends only the channel that did not land, then gives up after 3 attempts with `retired:<reason>`. Closures older than 24 hours are quiet.
  - The reminder job's recovery and catch-up filter on their own `kind`, so they never touch expiry rows.
  - Logs carry ids plus `describeError` (B-634-10).
- **View and open slots:**
  - A lapsed request reads as `expired` immediately and does not occupy a slot. A client never sees its link.
  - `expired` is listable. The welcome check ignores a lapsed welcome request.
- **Copy:** no first person, no exclamation marks, no blame. The time is named only with a usable zone (F2).
- **Restack hunks:** H1 (`describeError` export with B-634-10's body), F1, F2 and F3 are correct. `audit.service.ts` has prettier-only changes (no behaviour change).

### CI at this head
- All checks that run on a stacked PR are green, including "Forward migrations apply cleanly", "reversible", Schema parity, rls-floor-guard and the live lanes.
- `git merge-tree` with current main `5da537d6` is clean.

### Method
- I read the code at the exact head and diffed it against 9/9, M and main.
- I compared migration objects with every later migration. Lane mig-2 was pushed from this head (`audit/AUD-OPUS-SCHA-121/mig-2`).
- No local suites. Nothing was pushed to the PR branch.
