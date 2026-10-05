AUDIT Claude Opus 5.5 — growth-project-backend#715 @ 8040f14912b9bca649f0578685cc9056fdc9fd84 — VERDICT: APPROVE

A/B/C = 0/0/0

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4 (piece 4/9 of the S-SCHED-2 split of #634: the booking lifecycle, which covers concurrency, the no-double-booking floor and access). This is the first review of the split. I judged the stack as a whole and this piece as safe on main alone.

### Evidence reuse (G09) and the delta audited in full
- My model's lens approved #634 at `e18e8055` ([5972118900](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900)).
- `src/scheduling/scheduling-session-lifecycle.service.ts` here equals M `6fc88c45`. `git diff e18e8055 6fc88c45` on this file is exactly three hunks, and I audited each one:
  - **R2 (main #643/#647 B-647-1)**: the reschedule no longer runs `tx.notificationDeliveryLog.deleteMany` on the session's reminder claims. With the 4-column claim key (session, user, kind, start_at), the new start has no claim yet. Keeping the old claims is therefore what stops a stale sweep from re-sending, and a no-op reschedule (same time) cannot re-send.
    - I checked the reader side in `reminder.job.ts`. A row for the old start is parked or retired, never sent for the new time.
    - Nothing else in `src/` deletes or updates claims by session (`rg notificationDeliveryLog src/`: only the account-deletion manifest, by `user_id`).
    - The now-unused `NotificationKind` import is removed.
  - **Two log sites** (`:1066`, `:1100`): `const msg = safeLogDiagnostic(err)` is inlined into the log line, because main's no-pii guard counts a `msg` variable. The output is the same closed-enum diagnostic (B-634-10).
- Everything else in the file is byte-identical to the approved `e18e8055`: the per-coach advisory lock in `runBookingTx`, the CAS transition fence on the booking revision, the 23P01 to 409 mapping of the exclusion constraint, and the access checks through `SchedulingAccessService`.

### Lock order (this stack with main's reminder fence)
- A lifecycle write takes the per-coach advisory lock, then the `CoachingSession` row lock.
- The reminder fence (`readFencedSession`) takes only `FOR SHARE` on one session row, in its own short transaction, with no advisory lock.
- There is no cycle, so no deadlock. A reschedule or cancel that is in flight is waited for, as main's B-647-1 intends.

### Piece boundary
- 3 files, +975/-380 = 1,355 (under 1,500).
- On main alone, this lifecycle runs under main's `SchedulingService` and controller. Main's service delegates every session operation to it (`requestSession` ... `attachManualVideoLink`, `loadSessionOrThrow`).
  - The new constructor arguments are `@Optional()`, with a fallback `new SchedulingAccessService(prisma)` and `new SchedulingOpenSlotsService(...)`, so the module wiring (final in 6/9) is not needed yet.
  - Main's reminder job (still in place until 5/9) writes 4-column claims whose new delivery-state columns default to `sent` / 1. The lifecycle no longer deletes any claim, so the two agree.
- Test changes:
  - `test/scheduling.service.spec.ts` restores `ConflictException` (409) for a terminal transition and drops the interim "status still completed" assertion. The 409 is raised before any write, so the state cannot change.
  - The no-pii baseline drops the lifecycle entry (now 0; the baseline fails if it grows back).
- Session types expose `default_meeting_url` on main's list route from 1/9 to 5/9, but nothing can write the column until 6/9 (the seed script sets only `is_welcome`). So nothing is exposed in between, and 6/9's service returns it as null on the list (`scheduling.service.ts:213`).

### CI at this head
All checks that run on a stacked PR are green. `git merge-tree` with current main `5da537d6` is clean.

### Method
- I read the code at the exact head and diffed it against `e18e8055`, M and main `ee55f814`.
- No local suites. Nothing was pushed to the PR branch.
