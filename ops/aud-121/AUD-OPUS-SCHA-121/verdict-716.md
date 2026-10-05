AUDIT Claude Opus 5.5 — growth-project-backend#716 @ 31318708e96c29b73ae4d1e9eb64fe34f87f6deb — VERDICT: APPROVE

A/B/C = 0/0/1

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4 (piece 5/9 of the S-SCHED-2 split of #634: the reminder job, which covers concurrency, idempotent delivery and the claim ledger). This is the first review of the split. I judged the stack as a whole and this piece as safe on main alone.

### Evidence reuse (G09) and the delta audited in full
- My model's lens approved #634 at `e18e8055` ([5972118900](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900)).
- `src/scheduling/jobs/reminder.job.ts` equals M `6fc88c45`. I audited every hunk of `git diff e18e8055 6fc88c45` on this file (the R3 resolution against main's #643/#647):
  - **`DeliveryLogRow.start_at`** (non-null) replaces `session_start_at`. It is the claim key column of the applied migration 20270301000000, so no row lacks it (backfilled, then NOT NULL).
  - **`claimDelivery`**:
    - The insert writes `start_at`.
    - The P2002 lookup filters on all four key columns.
    - The stale-revision reset branch is removed: another start is another row, so the branch cannot occur.
    - Takeover is a single compare-and-set on (id, status, attempts, claim_token), only for `retry`, `parked`, or `sending` with an expired lease, with attempts left.
    - Receipts (`inapp_done_at`, `push_done_at`, `notification_id`) are carried, so a takeover never re-sends a channel that already landed.
    - Non-P2002 errors stay `error` (failed, not skipped; #634 B-634-2).
  - **Recovery** (`collectRecoverableWork`): a row whose `start_at` differs from the session's start is parked. `retireReason` retires an old-start row once the new start is below the band, and any row for a cancelled, finished or started session, a changed recipient, or with attempts exhausted.
  - **Catch-up** (`collectMissedFirstClaims`): a participant counts as covered only by a non-parked row for the current start. Pages use a keyset (start_at, id) and walk the whole 30-minute interval.
  - **Fence** (`readFencedSession`): main's B-647-1 `SELECT 1 ... FOR SHARE`, then `findUnique` in one transaction.
    - A fresh claim that fails the fence is released (deleted by id + token).
    - A taken-over claim that fails is closed `gave_up` with a reason. It never suppresses the new start, which has its own row.
- **Scenarios I traced:**
  - A moved later then back: A's `parked` row is re-armed on return, and receipts are kept.
  - A moved earlier, below the band: the old row is retired `superseded`.
  - A no-op reschedule: the same key, so a duplicate.
  - Two replicas: the unique key plus the CAS lets exactly one win.
  - A dead worker: the lease expires and the CAS takeover runs.
  - A failed first insert at the band's last tick: catch-up claims it.
- The status set matches the CHECK (`test/scheduling-delivery-status-contract.spec.ts`).

### C-716-1 (C, liveness): an old-start `retry` row stays unfinished while the session's new start is in the due band
- **Where:** `src/scheduling/jobs/reminder.job.ts:601`, `if (args.dueIds.has(session.id)) continue;`. It runs before the start-mismatch park at `:602-608`.
- **Counterexample:**
  - A 1h claim for start T1 is `retry` (push failed).
  - The session is moved to T2, which is inside the current due band.
  - Each tick, the band pass claims and sends a new (T2) row, which is correct, but the T1 row is skipped without changing state.
  - It stays `retry` until T2 leaves the band. Then `retireReason` returns `superseded`.
- **Impact:** bounded by the band width (10 or 30 minutes), and there is no double send. With more than `REMINDER_RECOVERY_BATCH` (200) such rows, they hold the oldest-first recovery page for that time and delay other recoveries. That breaks the comment at `:525-527` ("every row on the page changes state this tick"). Before the merge, #634's band pass re-armed that same row; under the 4-column key it no longer touches it.
- **Fix rule:** test the start mismatch (`row.start_at !== session.start_at`) before the `dueIds` skip, so an old-start row is parked at once. The `dueIds` skip then applies only to rows for the current start. Test: an old-start `retry` row whose session's new start is in the due band ends the tick `parked`.

### Piece boundary
- 6 files, +1,203/-199 = 1,402 (under 1,500).
- The job is final (== M) and replaces 3/9's one-line interim type change.
- Main's service and controller are still in place. The job reads only `CoachingSession` and `NotificationDeliveryLog`, and its crons stay off unless `BOOKING_REMINDERS_ENABLED=on` (unset in production; the flip is #643).
- Tests that come with it: `booking-reminder.job.spec.ts` (main's B-647-1 cases ported, plus a FOR SHARE fence case), `booking-reminder-local-time.spec.ts` (final), the delivery-status contract spec, and `reminder-claim-fake.ts` (reuses the fake DB's delivery-log model with a fenced transaction). The no-pii baseline drops the job's entry (now 0).
- `describeError` = `safeLogDiagnostic(err).slice(0, 200)` (B-634-10), so logs carry ids and catalogued codes only.

### CI at this head
All checks that run on a stacked PR are green. `git merge-tree` with current main `5da537d6` is clean.

### Method
- I read the code at the exact head and diffed it against `e18e8055`, M and main `ee55f814`.
- No local suites. Nothing was pushed to the PR branch.
