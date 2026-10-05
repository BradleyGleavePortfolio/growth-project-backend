# B-SPLIT-SCHED-120 (agent 120) — split backend #634 S-SCHED-2 into stacked pieces under 1,500 lines

Started 09:46 PDT 10-05. Stack lock taken: ops/lanes120/locks/sched.
Source: #634 head e18e8055454b04856d2c5ab5568d0a7127b74939 (branch agent110/s-sched-lifecycle), merge-base 0d33c4d4, 30 files,
+9,378/-1,286. Main ee55f814eb02b530e6578a168dc16c7ea7e2b07b. #653 head 17b2be255b0087196b9c1c81cc38397330c56c75.
Prior verdicts: dual APPROVE at 3d989702 (Opus 5971916062, Sol 5971921481); Opus merge-only APPROVE at e18e8055 (5972118900).
Worktree: /home/user/workspace/wt/B-SPLIT-SCHED-120-1. Notes: ops/aud-120/B-SPLIT-SCHED-120/.

## Status
- [x] main merge into #634 content: local merge commit 6fc88c457b917d74773f881ffed60c9d3f8d9d35
      (parents e18e8055 + ee55f814), tree 0595cfd70254cde577bf1cc3a844fa0c179c1d20. 33 files vs main, +9,774/-1,454.
      tsc clean; 37 related specs green locally (heavy.sh, one at a time); R75 range check OK (net -4).
- [ ] split plan
- [ ] pieces pushed / PRs opened
- [ ] #653 restack
- [ ] FIX ROUND 1 (OPENING) + READY on each piece
- [ ] superseded comment on #634

## Main-merge resolution (every resolved hunk)
Root cause of the conflicts: main #643/#647 (B-643-1, B-647-1/2, C-647-2/3; migration 20270301000000, applied in prod)
re-keyed reminder claims to (session_id, user_id, kind, start_at) NOT NULL with a FOR SHARE generation fence, made
reschedule never delete claims, added zone provenance (resolveRecipientTimeZone; no usable zone -> no clock time) and
BookingEmitter(notifications, prisma). #634 had a recoverable delivery-state machine keyed (session, user, kind) with a
session_start_at revision, an in-place stale reset, and a reschedule deleteMany.

Conflicted files (7 files, 27 hunks):
- R1 prisma/schema.prisma: kept main's `start_at DateTime` and main's 4-column unique; kept #634's status, attempts,
  lease_until, claim_token, inapp_done_at, push_done_at, notification_id, last_error, @@index([kind, status]); dropped
  #634's `session_start_at` (folded into start_at) and #634's 3-column unique.
- R2 src/scheduling/scheduling-session-lifecycle.service.ts: took #634's reschedule (runBookingTx, updateMany CAS);
  dropped #634's `tx.notificationDeliveryLog.deleteMany` of reminder claims (main B-647-1) with main's comment;
  removed the then-unused NotificationKind import.
- R3 src/scheduling/jobs/reminder.job.ts (3 hunks): #634 side, header rewritten for the 4-column key and fence;
  DeliveryLogRow.session_start_at -> start_at (non-null); park check, retireReason and catch-up filter use row.start_at;
  claimDelivery create sets start_at, the P2002 lookup filters by start_at, the stale-revision reset branch is removed
  (impossible under the 4-column key); takeover only for retry, parked or expired-lease rows; remindOne's fence uses
  readFencedSession(): `$transaction` { SELECT 1 ... FOR SHARE; findUnique } (keeps main's in-flight-reschedule wait).
  Non-P2002 claim errors still count as failed (#634 B-634-2), not skipped.
- R4 src/notifications/emitters/booking.emitter.ts: #634 emitter with main's zone rules: constructor (notifications,
  prisma) with the C-647-2 comment; zoneFor -> resolveRecipientTimeZone; #634's getPreferences zone, whenFor/timeFor
  and isValidZone removed; every emitter has a no-zone copy variant; payload `timeZone`; 24h body names the date
  (C-647-3). formatWhen/formatTime keep #634's format, with `tz` now required (no silent Pacific default).
- R5 test/booking-emitter.spec.ts (4 hunks): #634 side; zone double answers through recipient-timezone.ts; the
  unknown-zone case now expects no clock time; zone-lookup failure cases expect recipient-timezone's log line; main's
  B-643-1 no-zone and zoned cases ported (#634 wording) plus an unstamped-row -> coach-zone case.
- R6 test/booking-reminder.job.spec.ts (2 hunks): #634 fake with the 4-column key, findFirst by start_at, a real
  deleteMany and a fenced `$transaction`; main's R75 cronJob() replacements kept; main's B-647-1 cases ported
  (claim DB error expects failed=2, not skipped) plus a FOR SHARE fence case.
- R7 test/scheduling.service.spec.ts (2 hunks): #634 side; main's "reschedule never deletes claims" assertion kept
  against the SchedulingFakeDb.

Non-conflict semantic follow-through (needed for the merged tree to compile and pass):
- migration 20270222000000 migration.sql/down.sql: no session_start_at column (start_at comes from 20270301000000).
- lifecycle service: two `const msg = safeLogDiagnostic(err)` log sites inlined (main's no-pii guard counts `msg`).
- test/privacy/no-pii-in-logs.spec.ts: legacy exception-text baseline entries removed for booking.emitter.ts,
  reminder.job.ts and scheduling-session-lifecycle.service.ts (all now 0; the baseline fails on shrink).
- test/utils/scheduling-fake-db.ts: start_at required, 4-column duplicate key, `$queryRaw` (FOR SHARE counted), zone
  delegates (notificationPreferences, coachProfile).
- test/utils/reminder-claim-fake.ts: reuses SchedulingFakeDb's delivery-log model plus a fenced tx.
- test/booking-reminder-local-time.spec.ts: world reads the recovery/catch-up shapes; copy expectations in #634 wording.
- test/scheduling-lifecycle-integrity.spec.ts: session_start_at -> start_at; 5 cases restated for the 4-column key
  (claims kept on reschedule; old-time claim untouched and the new time claimed; parked row stays parked; C-634-6
  first-claim insert failure; legacy start-less rows removed as impossible under NOT NULL).
- test/scheduling-reminder-delivery.spec.ts, test/scheduling-delivery-status-contract.spec.ts,
  test/scheduling-booking-concurrency.live.spec.ts: start_at, emitter prisma argument, 24h copy names the date,
  live park case asserts the new start's own claim.

## Decisions (recommended default first)
- D1 migration 20270222000000 sorts before the applied 20270301000000: keep the name (default). The two commute
  (20270222 only adds state columns and indexes; 20270301 adds start_at); `prisma migrate deploy` applies the
  unapplied one. Alternative: rename to a timestamp newer than 20270316000000.

## Follow-ups (C)
- C-S120-1 src/notifications/emitters/booking.emitter.ts: the 24h title 'Session tomorrow' is stored in the inbox
  payload; fix rule: title without a relative day for the stored copy.
- C-S120-2 src/notifications/recipient-timezone.ts (main code): the lookup log prints `(err as Error).name`; a non-Error
  throw with a free-form name would print it; fix rule: closed-enum class name as in safeLogDiagnostic.

## HANDOFF
In progress. Merge committed locally; nothing pushed yet.
