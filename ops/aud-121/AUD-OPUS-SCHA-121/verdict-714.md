AUDIT Claude Opus 5.5 — growth-project-backend#714 @ 55dfbdce84b644f2c25826e11040a9ef8b597e0f — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4 (piece 3/9 of the S-SCHED-2 split of #634; this piece adds the device push for every booking event, which puts text on lock screens). This is the first review of the split. I judged the stack as a whole and this piece as safe on main alone.

### Evidence reuse (G09) and what I audited in full
- My model's lens approved #634 at `e18e8055` ([5972118900](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900)).
- `src/notifications/emitters/booking.emitter.ts` is NOT byte-identical to `e18e8055`. The main merge (resolution R4) rewrote its zone rules, so I audited the whole file and its spec again.
- The R4 resolution itself is correct:
  - Zones come from `resolveRecipientTimeZone(prisma, user, session)` (main's provenance rule: a supplied zone, then the own, booking or assigned coach's zone, else null). Every emitter has a no-zone variant without a clock time. Every payload carries `timeZone`.
  - The constructor takes `(notifications, prisma)` (C-647-2). `formatWhen` / `formatTime` require `tz`, so there is no silent Pacific default.
  - The 24h body names the date (C-647-3).
- The finding below comes from a decision that came after #634 was approved. It is not a merge defect.

### B-714-1 (B, privacy: names on lock screens): every booking push sends the full in-app text, display names included, through the legacy sender
- **Where:** `src/notifications/emitters/booking.emitter.ts:516`, in `deliver()`:
  - `this.notifications.pushToUser(args.userId, args.title, body, ...)` sends `body`, which is the in-app body (`:467`).
  - That body carries the other party's display name and the coach-written session type name, for example `:173` `${p.clientDisplayName} asked for ${what} on ${when}. ...`.
- **Main today** (`5da537d6`): the booking emitter writes inbox rows only and sends no booking push. This piece adds the device push for all booking kinds, including both reminder kinds. It is not behind a flag. Only the reminder sweep is gated, by `BOOKING_REMINDERS_ENABLED`, which #643 turns on.
- **Rulings in force that this breaks:**
  - TGP_SOURCE_OF_TRUTH A6.5: "reminder pushes show no name".
  - The push stack's accepted fix B-692-1: lock screens show only fixed per-kind text, because profile text (a display name can be an email address) must not reach a lock screen. `src/notifications/push/lock-screen-copy.ts` on #693 has a fixed template for every `BOOKING_*` kind.
- **Counterexample, already proven by this PR's own green test:** `test/booking-emitter.spec.ts:126-139` asserts that the push to `coach-1` has `body: row.body`, which is `'Jamie asked for Quick Q/A Call on Tue, Oct 6, 10:00 AM PDT. Approve or decline in your booking inbox.'`. The client's name and the type name land on the coach's lock screen. Reminders do the same: `Your <type> with <name> starts at 9:00 AM PDT.`
- **Fix rule:**
  - The push leg of `deliver()` sends only fixed per-kind lock-screen copy: no display name, no session type name, no notes or reasons.
  - Reminder pushes may keep the session time in the recipient's zone (operator ruling: "keep the session time, no name"). With no zone, no clock time.
  - The in-app row keeps today's full copy.
  - Take the wording from #693's `lock-screen-copy.ts` table, so the two stacks agree when they meet. Whichever stack lands second sends booking pushes through the push stack's `sendPush` outbox (one push per event, never both senders). See the operator note in my report.
  - Keep the fix inside #714's 1,500-line budget (1,382 now), or put the new test in #720 if it does not fit.
- **How to verify:** a spec that drives every emitter (`emitRequested`, `emitBooked`, `emitConfirmed`, `emitDeclined`, `emitCancelled`, `emitRescheduled`, `emitMoveRequested`, `emitLinkNeeded`, `emitLinkReady`, `emitReminder24h`, `emitReminder1h`) with a canary display name and type name, and asserts that no `pushToUser` title or body contains either. It must fail before the fix and pass after. My probe for this is `ops/aud-121/AUD-OPUS-SCHA-121/probes/booking-lock-screen.probe.spec.ts` (red by reading at this head: `:516` sends the in-app body). Also update `:126-139`, which pins the current behaviour.

### C-714-2 (C, copy truth; same as the builder's C-S120-1): the stored 24h title says "Session tomorrow"
- `booking.emitter.ts:436` stores the title `'Session tomorrow'` in the inbox row's payload (`deliver()` puts `title` into `payload`).
- C-647-3 made the stored body name the date, so it stays true when read the next day. The stored title still says "tomorrow".
- Fix rule: the stored title has no relative day, for example `'Session reminder'` (the same as #693's lock-screen template). Only a push rendered at send time may say "tomorrow".

### Piece boundary
- 5 files, +1,043/-339 = 1,382 (under 1,500). The emitter and its spec are final (== M).
- Intermediate lines, all replaced by later pieces:
  - `src/scheduling/jobs/reminder.job.ts:123`: the emit callback type changes from `Promise<void>` to `Promise<unknown>`, the only source change outside the emitter; 5/9 replaces the job.
  - `test/booking-reminder-local-time.spec.ts`.
  - The no-pii baseline drops the `booking.emitter.ts` entry. The legacy count is now 0, and the baseline fails if it grows back.
- On main alone with this piece, main's lifecycle and reminder job call the new emitter. It compiles, and the CI suites are green. The only new runtime behaviour is the booking push in B-714-1.

### CI at this head
All checks that run on a stacked PR are green (build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, Schema parity, npm audit). `git merge-tree` with current main `5da537d6` is clean.

### Method
- I read the code at the exact head and diffed it against `e18e8055`, M `6fc88c45` and main `ee55f814` / `5da537d6`.
- I read the push stack's #693 head `cc0a167f` for its `booking.emitter.ts` and `lock-screen-copy.ts`, for context only (not audited here).
- No local suites. Nothing was pushed to the PR branch.
