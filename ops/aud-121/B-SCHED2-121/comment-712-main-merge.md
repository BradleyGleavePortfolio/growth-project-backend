MAIN MERGE (B-SCHED2-121, agent 121) — growth-project-backend#712 @ f2af32dd717c679a10e3ed5e67686cbf6421af67

One merge commit: `origin/main` 4bddf24a (push b#692, coach b#674, messaging b#708) merged into `agent120/sched-split-1-foundation` at 9d93b867 (tree 247f9e96 = audited #653 @ 40050cde). Parents are 9d93b867 and 4bddf24a. The resolution follows the prepared routing on `ci/B-SCHED2-121-route-prep` @ 870047c3, plus the B-653-4 move-request line.

**Conflict hunks (3 files)**
| File | Resolution | vs train | vs main |
|---|---|---|---|
| `src/notifications/emitters/booking.emitter.ts` | Kept the train's emitter. The push leg now goes **only** through `NotificationsService.sendPush` (the #692 sender; no `pushToUser`, no second sender). The interim `BOOKING_LOCK_SCREEN` table is gone, and the lock-screen copy comes from `push/lock-screen-copy.ts`. Dedupe key is `kind:session:(move id \| time)`. Move payloads carry `rescheduleEventId` (main's B-693-1). `emitMoveRequested` sets `moveRequested: true` in the push context (`:373`, `:546`, `:614`). | +72/-127 | +552/-167 |
| `test/booking-emitter.spec.ts` | Kept the train's spec, moved to the `sendPush` fake. | +54/-36 | — |
| `test/scheduling.service.spec.ts` | Kept the train's spec; its notifications fake has `sendPush` instead of `pushToUser`. | +1/-1 | — |

**Follow-through needed for the merge to compile and keep the audited behaviour (no other changes)**
- `src/notifications/push/lock-screen-copy.ts` (+25 vs main):
  - fixed lines for the 3 scheduling kinds main lacked: call link needed, call link ready, request closed;
  - `:107`, `:154-155`: the move-request line for `booking_rescheduled` when `context.moveRequested`: **"Time change requested" / "A client asked to move a session. Open the app to review."** Real moves still say "Session moved".
- `src/notifications/push/push-delivery.service.ts:177` (+1 vs main): `asContext` keeps `moveRequested`, so the copy at send time matches the copy at enqueue.
- `src/scheduling/scheduling-session-lifecycle.service.ts:544,555,567` (+7 vs train): `rescheduleEventId` comes from `result.row.updated_at` on all three move paths. Main's auto-merged hunk referenced `updated`, which is undefined in the train's file.
- Tests moved from `pushToUser` to `sendPush`:
  - `test/utils/booking-push-fake.ts` (new);
  - `test/scheduling-lifecycle-integrity.spec.ts`, which also gains a move test A->B->A->B (three pushes, three keys);
  - `test/scheduling-reminder-delivery.spec.ts`, `test/scheduling-request-expiry.spec.ts`, `test/scheduling-booking-concurrency.live.spec.ts`;
  - `test/booking-lock-screen-push.spec.ts`: runs the real sender into outbox rows, and its B-653-4 test checks the move-request line at enqueue **and** at send.

**Local evidence** (heavy.sh, one spec at a time):
- `test/booking-lock-screen-push.spec.ts`: 4/4.
- `test/booking-emitter.spec.ts`: 21/21.
- `test/scheduling.service.spec.ts`: 13/13.
- Narrow tsc (changed src + 7 specs) clean; eslint and prettier clean.
- The other scheduling specs above were not re-run on this head. They are byte-identical to route-prep, where 13 suites / 306 tests passed. PR CI runs them.

New head: **f2af32dd717c679a10e3ed5e67686cbf6421af67**.
