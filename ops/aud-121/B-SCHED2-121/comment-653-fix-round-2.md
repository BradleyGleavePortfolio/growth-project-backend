FIX ROUND 2 (B-SCHED2-121, agent 121) — growth-project-backend#653 @ 40050cde572c7f69f66dc29a7f1be3cabdc391a6

READY FOR AUDIT (delta: one commit on c48adb9f8239d3de00a5a56de6ff1e6a19c8b921, 2 files, +60/-2; PR now +1,844/-42 = 1,886).

**Fixed: B-653-4 (Opus D5, review 6003335592).** A client's move request on a coach-approval session told the coach "Session moved. A session has a new time."
- `src/notifications/emitters/booking.emitter.ts:350`: `emitMoveRequested` passes `lockScreen: 'move_requested'`. The kind stays `booking_rescheduled`.
- `:570`: the push leg passes that state to `bookingLockScreenCopy`.
- `:674-677, :695-697`: new fixed line for that state only. Title `Time change requested`, body `A client asked to move a session. Open the app to review.` No names, no coach-written text, no first person, no exclamation mark.
- Real moves (`emitRescheduled`, coach or client side) still say `Session moved`.

**Test (fails before, passes after):** `test/booking-lock-screen-push.spec.ts:257` (B-653-4). The test sends a move request, then a real move, and checks that only the request gets the new line, with no canary name or type. The all-emitters table at `:192` now pins the request line instead of "Session moved".
- Before (fix stashed): 2 failed (the new test and the old pinned table), 2 passed.
- After: 6 suites green, 182 tests (booking-lock-screen-push, booking-emitter, scheduling-lifecycle-integrity, scheduling-reminder-delivery, scheduling-request-expiry, scheduling.service).
- Both runs were local through heavy.sh. Narrow tsc, eslint and prettier are clean.

**Round 1 lane result (failing-before at 9a23e3b2):** run 37372052489 on ci/B-SCHED2-121-1 finished as a failure, as expected. 3 suites failed: builder probe RED, Opus P-714-1 RED, Sol boundary cases 1-2 RED (edge C). Sol case 3 GREEN. 4 failed, 1 passed.

**Nothing else changed** (ruthless scope). The push-routing follow-up on main must carry this same move-request line (Opus decision 2: yes). Prepared routing work is on branch `ci/B-SCHED2-121-route-prep` @ 870047c3 and does not have this line yet.
