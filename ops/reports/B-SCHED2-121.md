# B-SCHED2-121 (builder, Claude Opus 5.5, agent 121) — scheduling train FIX ROUND 1 in #653

Started 13:42 PDT 10-05. Lock: ops/lanes121/locks/sched. Evidence: ops/aud-121/B-SCHED2-121/.

## State (GitHub verified 14:35 PDT)
- #653 head 40050cde572c7f69f66dc29a7f1be3cabdc391a6 (round 1 c48adb9f on audited 9a23e3b2, round 2 40050cde). +1,844/-42 = 1,886,
  23 files (opened 10-03, limit 3,000).
- FIX ROUND 1 / READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/653#issuecomment-6002743444
- FIX ROUND 2 / READY FOR AUDIT (B-653-4): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/653#issuecomment-6003441858
- #714 one-liner: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/714#issuecomment-6002743640
- #712-#720 untouched. Operator ruling 14:1x: no push 2 into the train, no restack; routing via sendPush becomes a follow-up PR
  on main after b#692 and the train land, before BOOKING_REMINDERS flips.
- PR CI at 40050cde: 1 completed, 1 in progress, 9 queued. PR CI at c48adb9f: build-and-test in progress.

## Findings handled
- B-653-4 (Opus D5 RC 6003335592, operator: valid B): FIXED in round 2. booking.emitter.ts:350 emitMoveRequested passes
  lockScreen 'move_requested'; :570 push leg passes it; :674-677/:695-697 fixed line "Time change requested" / "A client asked to
  move a session. Open the app to review." Same kind. Test booking-lock-screen-push.spec.ts:257 (fails before: 2 failed/2 passed,
  b653-4-before.log; after: 6 suites/182 green, b653-4-after.log); table at :192 pins it.
- B-714-1 + B-653-1 (Opus): FIXED in push 1. booking.emitter.ts:566 push leg uses bookingLockScreenCopy (:622-697): fixed
  per-kind lines (wording = push stack lock-screen-copy.ts), reminders keep time only, inbox row unchanged.
- Sol B-653-1 (stale pre-lock now) -> C (edge). Sol B-653-2 (sweep-start leases) -> C (edge). Opus B-653-2 -> C (edge, ruling).

## Evidence
- Lane (failing-before at 9a23e3b2 + builder probe + Opus P-714-1 + Sol boundary spec): ci/B-SCHED2-121-1, run
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372052489 = failure as expected: 3 suites
  failed (builder probe RED, Opus probe RED, Sol cases 1-2 RED = edge C), Sol case 3 GREEN; 4 failed / 1 passed. Branch deleted.
- Local heavy.sh: probe-before.log (both probes RED at 9a23e3b2), probe-after.log (GREEN), local-jest-after.log (4 touched suites +
  new spec green; Sol cases 1-2 red = edge Cs, case 3 green). tsc narrow project clean; prettier/eslint clean.
- PR CI at c48adb9f (14:09): migrations, schema parity, npm audit, size-label, test-deploy-readiness green; build-and-test and live
  lanes queued.

## Follow-ups (C)
- C-714-1/C-714-2: booking.emitter.ts:485 stored inbox title "Session tomorrow" -> "Session reminder".
- C-653-1 Sol: scheduling-session-lifecycle.service.ts:873 -> safeLogDiagnostic(err).
- C-653-3 Opus (edge): request-expiry.ts:61 / request-expiry.job.ts:145 NULL request_expires_at -> CAS backfill in sweep.
- C-653-S1 (Sol B-653-1, edge): scheduling-session-lifecycle.service.ts:408,420-434,469-487 -> fresh clock after lock, deadline at
  the write boundary.
- C-653-S2 (Sol B-653-2, edge): request-expiry.job.ts:114-127,247-256,375-395 -> claim-time leases, renewed/fenced singleton.
- C-714-2 Sol: recipient-timezone.ts:87-91 -> safeLogDiagnostic.
- C (edge, new): dedupe key kind:session:time for booking_confirmed means confirm A -> move -> confirm B -> move back -> confirm A
  sends the third confirm push as a duplicate (same as the push stack's design on main). Fix rule: confirm key uses the session
  updated_at like moves.

## Routing follow-up (not in the train; operator ruling 14:1x)
Branch ci/B-SCHED2-121-route-prep @ 870047c344c33b276fa00660338ab83240050deb (no workflow runs). Two commits on c48adb9f:
- fe4557cc: merge of agent115/push-split-1-outbox-foundation b7479245 (main 5da537d6 + #692 + #693); conflicts taken from the
  train side: src/notifications/emitters/booking.emitter.ts, test/booking-emitter.spec.ts, test/scheduling.service.spec.ts.
- 870047c3: routing. Files: src/notifications/emitters/booking.emitter.ts (deliver() -> NotificationsService.sendPush only, dedupe
  kind:session:(move id | time), outcome EnqueueCode or 'failed', gate pushAllowedByPreferences, BOOKING_LOCK_SCREEN removed,
  rescheduleEventId on move payloads); src/notifications/push/lock-screen-copy.ts (+3 templates: link needed, link ready, request
  closed); src/scheduling/scheduling-session-lifecycle.service.ts (rescheduleEventId = result.row.updated_at on all three move
  paths; fixes the auto-merged undefined `updated`); test/utils/booking-push-fake.ts (new); test/booking-lock-screen-push.spec.ts
  (REAL sendPush + enqueue into outbox rows); test/booking-emitter.spec.ts, test/scheduling-lifecycle-integrity.spec.ts (+ A->B->A->B
  move test), test/scheduling-reminder-delivery.spec.ts, test/scheduling-request-expiry.spec.ts,
  test/scheduling-booking-concurrency.live.spec.ts, test/scheduling.service.spec.ts (sendPush fakes).
- Evidence (local, heavy.sh): ops/aud-121/B-SCHED2-121/prep-route-jest-2.log = 13 suites / 306 tests green (live spec skipped
  locally); narrow tsc, eslint, prettier clean.
- What is left for the follow-up PR on main (after b#692 and the train are on main):
  1. Branch from main; port 870047c3's routing (the merge commit is not needed once both are on main).
  2. MUST carry the B-653-4 move-request line (Opus decision 2: yes): the route-prep branch predates 40050cde, so add a
     move-request template to push/lock-screen-copy.ts ("Time change requested" / "A client asked to move a session. Open the
     app to review.") selected by request state for booking_rescheduled, and keep the B-653-4 test.
  3. Re-run the 13 suites plus the live spec in a backend CI lane; failing-before probe = booking-lock-screen-push.spec on main.
  4. Edge C noted: confirm dedupe key kind:session:time repeats on confirm A -> move -> confirm B -> move back -> confirm A; fix rule:
     key confirms by session updated_at like moves.

## MAIN MERGE into #712 (operator 14:45)
- #712 (agent120/sched-split-1-foundation) 9d93b867 (tree 247f9e96 = audited #653 @ 40050cde) + origin/main 4bddf24a -> merge commit
  f2af32dd717c679a10e3ed5e67686cbf6421af67. mergeable=true (blocked on checks); CI at 14:48: 8 completed, 10 in progress.
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/712#issuecomment-6003702168 (body
  ops/aud-121/B-SCHED2-121/comment-712-main-merge.md). Notify: ops/lanes121/notify/sched-main-merge.txt.
- Conflicts: booking.emitter.ts, test/booking-emitter.spec.ts, test/scheduling.service.spec.ts -> route-prep 870047c3 versions
  (sendPush only) + B-653-4 via context.moveRequested (emitter :373/:546/:614; lock-screen-copy.ts :107/:154; push-delivery
  asContext :177). Follow-through: lock-screen-copy 3 templates, lifecycle rescheduleEventId (result.row.updated_at), sendPush fakes.
- Local: main-merge-booking-lock-screen-push.log 4/4, main-merge-booking-emitter.log 21/21, main-merge-scheduling.service.log 13/13;
  narrow tsc + eslint clean. Worktree wt/B-SCHED2-121-5 removed after push.
- The routing follow-up from the 14:1x ruling is now done inside this merge; ci/B-SCHED2-121-route-prep can be deleted by the
  operator once #712 lands.

## HANDOFF
Round 1 (c48adb9f) and round 2 (40050cde, B-653-4) pushed; READY FOR AUDIT on #653 (comment 6003441858). No restack, #712-#720
untouched. Lane ci/B-SCHED2-121-1 collected and deleted. Worktrees wt/B-SCHED2-121-1..4 removed. Kept: ci/B-SCHED2-121-route-prep
@ 870047c3 for the routing follow-up (see section above; it must add the move-request line). Evidence files stay in
ops/aud-121/B-SCHED2-121/.
Update 14:48: main merged into #712 (head f2af32dd); booking pushes now go through sendPush with the move-request line. Next:
PR CI on #712 and the delta lens on the merge commit.
