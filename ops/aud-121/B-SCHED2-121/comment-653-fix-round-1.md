FIX ROUND 1 (B-SCHED2-121, agent 121) — growth-project-backend#653 @ c48adb9f8239d3de00a5a56de6ff1e6a19c8b921 — READY FOR AUDIT

Answers Opus RC 6002182391 (#653 0/2/1), Opus RC 6001957114 (#714 0/1/1) and Sol RC 6001979762 (#653 0/2/1). One commit on top of the audited head 9a23e3b2 (parent 9a23e3b2471794a1356d9939cc4e06682f1ea7ec). T4 (PII on lock screens). Size: +1,786 / -42 = 1,828 changed lines (PR opened 2026-10-03, limit 3,000).

Per the operator ruling (the train lands as one, A5 rule 11) B-714-1 is fixed here in the top piece; #712-#720 are not touched.

### Fixed
- **B-714-1** (Opus, #714) and **B-653-1** (Opus, #653): booking and expiry pushes put the client's name and the coach-written session-type name on the lock screen. `src/notifications/emitters/booking.emitter.ts:566` the push leg of `deliver()` now sends `bookingLockScreenCopy(kind, payload)` (`:622-697`): one fixed title and body per kind, no display name, no type name, no notes or reasons. Reminders keep only the time in the recipient's validated zone ("Your session is on Tue, Oct 6, 10:00 AM PDT." / "Your session starts at 10:00 AM PDT."); with no usable zone, the fixed line with no clock time. Unknown kinds get a generic line. The function reads only `kind`, `scheduledAt` and `timeZone`, so no other payload field can reach the lock screen. The inbox row (inside the app) is unchanged and keeps the full detail. Wording is the push stack's `lock-screen-copy.ts` (B-692-1) text for the seven kinds it has, plus three new lines (call link needed, call link ready, request closed), so routing through the #692/#693 sender later keeps the same copy.
- Push data payload (tap routing: kind, category, actionScreen, actionParams, notificationId) and the delivery outcome contract (`push: PushDeliveryCode`) are unchanged, so the reminder and expiry retry/settle logic is untouched.

### Lock-screen lines (no first person, no exclamation marks, no emojis; each true for every emitter that uses the kind)
| Kind | Title | Body |
|---|---|---|
| booking_requested | Session request | There is a new session request. Open the app to see it. |
| booking_confirmed (client confirmed / instant, coach booked) | Session confirmed | Your session is confirmed. Open the app to see the details. |
| booking_declined | Session request | Your session request was declined. Open the app to see the details. |
| booking_cancelled | Session cancelled | A session was cancelled. Open the app to see the details. |
| booking_rescheduled (moved / move requested) | Session moved | A session has a new time. Open the app to see it. |
| booking_reminder_24h | Session reminder | Your session is on <date, time, zone>. (no zone: You have a session in about 24 hours. Open the app to see the details.) |
| booking_reminder_1h | Session starting soon | Your session starts at <time, zone>. (no zone: Your session starts in about an hour. Open the app to see the details.) |
| booking_link_needed | Add a call link | A session has no call link yet. Open the app to add one. |
| booking_link_ready | Call link ready | The call link for your session is ready. Open the app to see it. |
| booking_request_expired (both sides) | Session request closed | A session request has closed. Open the app to see the details. |

### Tests
- New `test/booking-lock-screen-push.spec.ts` (3 tests): all 14 emitter calls (every method, both confirm variants, both expiry roles) with canary display names, canary type name and canary notes/decline/cancel reasons; asserts the exact fixed line per push, no canary, no first person or "!", reminders with time only; no-zone variant has no clock time; `bookingLockScreenCopy` ignores names/notes and falls back on a bad zone and an unknown kind; the inbox rows keep the full detail.
- Updated assertions that pinned the old push text: `test/booking-emitter.spec.ts` (requested push, reminder titles, no-zone bodies), `test/scheduling-reminder-delivery.spec.ts` (24h push text; call-link detail read from the inbox row), `test/scheduling-lifecycle-integrity.spec.ts` (request push; the two "confirmation names the committed time" checks now read the inbox row, which is where the time is).

### Probe replay (both lenses)
- Failing-before lane at the old head 9a23e3b2 + probes: branch `ci/B-SCHED2-121-1`, run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372052489 (queued; GitHub runner incident, about 150 runs queued repo-wide). Specs: builder probe (all 14 calls, canaries), Opus P-714-1 probe, Sol `653-expiry-boundaries` spec.
- Local evidence while the lane queues (`ops/heavy.sh`, one jest run, TZ=UTC):
  - Before (9a23e3b2): builder probe RED (14 pushes leak name/type), Opus P-714-1 RED (5 pushes leak, e.g. "Jamie Canary-Person asked for Canary Type Name on Tue, Oct 6, 10:00 AM PDT...").
  - After (c48adb9f): builder probe GREEN, Opus P-714-1 GREEN, new spec 3/3 GREEN; `booking-emitter`, `scheduling-reminder-delivery`, `scheduling-lifecycle-integrity`, `scheduling-request-expiry` all GREEN (171 tests in the run). Sol boundary spec: case 3 (dead-worker takeover control) GREEN; cases 1 and 2 RED, unchanged, ruled C (edge) below.
  - `tsc --noEmit` over the changed source and specs (narrow project, 1,060 files followed): clean. Prettier and ESLint on the five files: clean.
- PR CI at c48adb9f: queued (runner incident). Not re-triggered.

### Money-list self-check
Webhook order/redelivery: not touched. Concurrency and lock order: no new await, lock or transaction; only the push text changes. Terminal states: unchanged (same outcome codes). Fail-closed: a missing or invalid zone, a bad instant or an unknown kind yields a fixed line, never inbox text and never UTC. Currency/minor units: not touched. Copy truth: table above; each line is true for every emitter using the kind (a move request does give the session a new time, awaiting approval).

### Owner edge-case freeze (_COMMON_121 item 13) applied
- Sol B-653-1 (move waiting on the coach lock across the exact deadline, `scheduling-session-lifecycle.service.ts:408,420-434,469-487`) -> **C (edge, deferred to 10k clients)**: a same-instant lock-wait window at the deadline second; no money, no private data. Fix rule kept: re-read the clock after the lock and enforce the deadline at the write boundary.
- Sol B-653-2 (notice leases from the sweep start after a pass longer than four minutes, `request-expiry.job.ts:114-127,247-256,375-395`) -> **C (edge, deferred to 10k clients)**: a timing/lease window that needs a five-minute expiry pass, far above launch volume; worst case a duplicate notice. Fix rule kept: claim-time leases, renewed/fenced singleton.
- Opus B-653-2 (live-Postgres expiry proof) -> C (edge), operator ruling.
- Migration keeps 20270226000000 (operator ruling).

### Follow-ups (C), not changed in this round
- C-714-1 Sol / C-714-2 Opus: `booking.emitter.ts:485` stored 24h inbox title "Session tomorrow"; fix rule: date-free title "Session reminder" (the push title already is).
- C-653-1 Sol: `scheduling-session-lifecycle.service.ts:873` `.name` in the lazy-expiry audit catch; fix rule: `safeLogDiagnostic(err)`.
- C-653-3 Opus (edge): `request-expiry.ts:61` / `request-expiry.job.ts:145` rows with NULL `request_expires_at` from the rolling deploy never expire; fix rule: sweep backfills the deadline with a CAS.
- C-714-2 Sol: `recipient-timezone.ts:87-91` `.name` log; fix rule: `safeLogDiagnostic`.

### Next push (push-sender routing)
b#692 (with #693 merged into its branch) is not on main at 13:53 PDT (head b7479245, CI queued). When it lands: merge main into #712's branch (hunks listed), restack #713 -> #653 merge-only (one push per PR), and route every booking/expiry push through `NotificationsService.sendPush` only (no second sender), with the three extra lines added to `lock-screen-copy.ts`. That is a second push and a new review round on the changed lines.
