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
- [x] split plan: 9 stacked pieces (below), built in wt/B-SPLIT-SCHED-120-2; each compiles (tsc) and passes its affected specs locally.
- [x] pieces pushed, draft PRs #712-#720 opened (REST); reference merge pushed as agent120/sched-split-0-merged-reference.
- [x] #653 restacked (merge-only) onto 9/9: head 9a23e3b2471794a1356d9939cc4e06682f1ea7ec, base agent120/sched-split-9-integrity-tests-c-live, +1,414/-23 = 1,437.
- [x] CI green on every piece (all 11 required on #712; the 7 that run on stacked PRs on #713-#720; CodeQL, danger,
      Banned cast tokens and build-sbom run on base main only). FIX ROUND 1 (OPENING) + READY FOR AUDIT posted on each piece:
      #712 6000374252, #713 6000374848, #714 6000375484, #715 6000411764, #716 6000412422, #717 6000376129,
      #718 6000376658, #719 6000377335, #720 6000377942. #720: build-and-test 776 suites / 13,349 tests passed (integrity and
      service specs PASS); mwb-3-live-tests ran scheduling-booking-concurrency.live.spec.ts: PASS.
- [x] superseded comment on #634 (not closed): 6000417296.
- [x] #653 RESTACK + READY FOR AUDIT: 6000468343 (all checks that run on a stacked PR green at 9a23e3b2; no prior audits on #653).

## Pieces (sizes = additions + deletions vs the previous piece; GitHub numbers match the local diff)
| k | PR | Branch | Head | Lines | Contents |
|---|---|---|---|---|---|
| 1 | #712 | agent120/sched-split-1-foundation | 7fd99dce284405f018c545d31cdc1d3d25432f68 | 1,359 | schema, migration 20270222, kinds, orm-diagnostics + spec, types, DTO, slot computer + spec, open-slots, access |
| 2 | #713 | agent120/sched-split-2-test-infra | a7c8b33afbac44f3086036eb59ca617809320411 | 1,274 | scheduling-fake-db, service spec on the fake (3 cases intermediate), seed script + spec |
| 3 | #714 | agent120/sched-split-3-emitter | 55dfbdce84b644f2c25826e11040a9ef8b597e0f | 1,382 | booking emitter + spec, local-time spec (intermediate), job emit type (intermediate), no-pii baseline |
| 4 | #715 | agent120/sched-split-4-lifecycle | 8040f14912b9bca649f0578685cc9056fdc9fd84 | 1,355 | lifecycle service, service spec 409 cases restored, no-pii baseline |
| 5 | #716 | agent120/sched-split-5-reminder-job | 31318708e96c29b73ae4d1e9eb64fe34f87f6deb | 1,402 | reminder job, job spec, local-time spec, claim fake, delivery-status contract spec, no-pii baseline |
| 6 | #717 | agent120/sched-split-6-service-api | 112e0452a473d2ab7226750a80e03043812a9470 | 1,068 | service, controller, module, session view, final service spec, reminder-delivery spec |
| 7 | #718 | agent120/sched-split-7-integrity-tests-a | 6feb18bb9b259c662230fb1e79ff3a4cddc290ea | 1,062 | integrity spec lines 1-1070 (5 unused imports/helper held back) |
| 8 | #719 | agent120/sched-split-8-integrity-tests-b | c79c3e67efca90eddcdb89f3a2dc5ff0591ce3b2 | 1,148 | integrity spec to line 2210 (fs/path held back) |
| 9 | #720 | agent120/sched-split-9-integrity-tests-c-live | c2b271936f47ecf1827f7a46607d29add381579f | 1,218 | integrity spec end, live concurrency spec, ci.yml (4) |

Tree-equality proof: tree(9/9 c2b27193) == tree(M 6fc88c45) == 0595cfd70254cde577bf1cc3a844fa0c179c1d20; `git diff 6fc88c45 c2b27193` empty.
After 6/9 every src/, prisma/ and scripts/ file equals M. R75 range check OK on every piece (no positive token change).

Why the core is staged (whole-file split impossible): lifecycle 1,344 + service 530 + the service spec swap 478 > 1,500, and main's
service spec fails 10/12 on the new lifecycle. So 2/9 moves the service spec onto the fake DB first with three cases asserting only
what holds on both sides, 4/9 swaps the lifecycle under main's service (new options/ctor args are optional), 6/9 swaps the service.

Intermediate (non-final) lines, all replaced by a later piece:
- 2/9 test/scheduling.service.spec.ts: completed->scheduled and cancel-completed assert HttpException + status still completed
  (4/9 restores ConflictException); availability window asserts BadRequestException, title without ", with a code" (6/9 restores);
  the two meeting_link_status assertions arrive in 6/9.
- 3/9 src/scheduling/jobs/reminder.job.ts:123 emit callback `Promise<void>` -> `Promise<unknown>` (5/9 replaces the job);
  test/booking-reminder-local-time.spec.ts main's world + S-SCHED-2 wording without the call-link sentence (5/9 final).
- 7/9 and 8/9 integrity spec: imports/helper used only by later blocks held back (fs, path, Logger, Prisma, startMs).

## #653 restack (merge-only; base changed to agent120/sched-split-9-integrity-tests-c-live)
Commit 8ed8e3ac merges M 6fc88c45 into 17b2be25 (connects history; #653 held #634 only to bb6f3ea8). Resolved hunks:
- H1 src/scheduling/jobs/reminder.job.ts describeError: #653's `export` (request-expiry.job imports it) + M's B-634-10 body
  (`safeLogDiagnostic(err).slice(0, 200)`).
- H2 src/scheduling/scheduling-session-lifecycle.service.ts reschedule: #653's lapsed-request answer on `moved.count !== 1`
  kept; #653-side claim `deleteMany` dropped with M's B-647-1 comment (claims keyed by start_at).
Semantic follow-through (needed to compile against main's key and zone rules):
- F1 src/scheduling/jobs/request-expiry.job.ts:256 notice claim writes `start_at` (main's NOT NULL key column), not session_start_at.
- F2 src/notifications/emitters/booking.emitter.ts emitRequestExpired: zone via zoneFor(recipient, session) (R4 rule); no clock
  time without a usable zone ("Your <type> request was not confirmed in time, so it has closed. ..."); payload timeZone.
- F3 test/scheduling-request-expiry.spec.ts: BookingEmitter gets `asPrisma(db)` (main C-647-2 constructor).
Commit 9a23e3b2 merges 9/9 c2b27193: tree(9/9) == tree(M), already merged, so every hunk keeps this side; tree unchanged
(94a63a15d3af74c51f8d3436b5e9e9987f06cf3f before and after). Local: tsc clean; request-expiry 20/20, integrity 103/103, service 13/13,
emitter 21/21, job 21/21, reminder-delivery 21/21, delivery-status 4/4, no-pii 11/11, local-time 8/8, log-diagnostic 12/12,
permissions 20/20, qa-p0 17/17. R75 OK. #653 vs 9/9: 19 files, +1,414/-23 = 1,437.

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
- C-634-11 (Opus, optional, carried) src/observability/orm-diagnostics.ts:109-170 (logErrorClass / logErrorCode /
  safeLogDiagnostic): `instanceof Error` runs outside any try; fix rule: wrap the body after safeDiagnostic in
  `try { ... } catch { return 'OtherError'; }`.
- C-S120-1 src/notifications/emitters/booking.emitter.ts:436: the 24h title 'Session tomorrow' is stored in the inbox
  payload; fix rule: title without a relative day for the stored copy.
- C-S120-2 src/notifications/recipient-timezone.ts:89 (main code): the lookup log prints `(err as Error).name`; a non-Error
  throw with a free-form name would print it; fix rule: closed-enum class name as in safeLogDiagnostic.

## HANDOFF
Done 11:21 PDT 10-05 (times from `date`).
- Pieces (draft, stacked, each < 1,500): #712 1/9 7fd99dce284405f018c545d31cdc1d3d25432f68 (1,359, base main) <- #713 a7c8b33a (1,274)
  <- #714 55dfbdce (1,382) <- #715 8040f149 (1,355) <- #716 31318708 (1,402) <- #717 112e0452 (1,068) <- #718 6feb18bb (1,062)
  <- #719 c79c3e67 (1,148) <- #720 9/9 c2b271936f47ecf1827f7a46607d29add381579f (1,218).
- Tree equality: tree(#720) == tree(M 6fc88c45, branch agent120/sched-split-0-merged-reference) == 0595cfd70254cde577bf1cc3a844fa0c179c1d20.
- #653 restacked merge-only on #720: 9a23e3b2471794a1356d9939cc4e06682f1ea7ec (1,437 vs #720), checks green, READY posted.
- #634 left open with a SUPERSEDED comment; the operator closes it after the pieces land. Mobile #325 pairing unchanged.
- Next: dual audit of #712-#720 and #653; land #712-#720 as one stack (rule 11), then #653. D1 open (default: keep 20270222).
- Cleanup: worktrees wt/B-SPLIT-SCHED-120-1/2/3 removed; no ci/* or audit/* branches were created; lock removed; notify written.
