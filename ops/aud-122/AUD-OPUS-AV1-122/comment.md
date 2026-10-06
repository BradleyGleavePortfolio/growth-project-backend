AUDIT Claude Opus 5.5 — growth-project-backend#735 @ 32d8120712cc106eb87a4a3457661dc2cf427a1e — VERDICT: APPROVE

Lens AUD-OPUS-AV1-122 (agent 122), first review, T4 bookings, RUTHLESS SCOPE. A 0 / B 0 / C 4.

Checked against the item list (operator's 4 design defaults accepted as given):
- Client can book a time the options forbid: no. The only session create path (`requestSession`) and the client move path both run `assertIntervalBookable` inside the per-coach locked tx; it reads the coach's options in the same pass (`intervalBookability` -> `coachCalendarProfile`) and applies notice + window (`assertWithinBookingWindow(start, now, options)`), then daily max, then buffers (src/scheduling/scheduling-session-lifecycle.service.ts:786-830). The pre-lock check uses only the loosest bounds (5 min / 365 days). No other `coachingSession.create` or slot consumer exists in src.
- Open slots show a time that then fails: no. Slots and the booking check share `computeFreeRanges` (buffer gap applied to booking holes) and `fullLocalDays` (daily max) in src/scheduling/slot-computer.service.ts, both fed by the same loader widened by a day each side; `withinBookingWindow` filters by the coach's notice/window carried on the payload (cached payloads included); PATCH invalidates the coach's cache.
- Coach reads/changes another coach's options: no. GET/PATCH `coach/booking-options` take no coach id, use `actor.id` only, and refuse non-coaches with 403 (scheduling-booking-options.service.ts). No route shadowing in the controller.
- Defaults change today's behaviour: no. Defaults 5 min / 120 days / 0 / 0 / null give the same floor, ceiling, slot set and refusals; the wider booking load cannot remove minutes from a range when the gap is 0; daily max is off when null.
- Migration not additive: it is additive (5 `ADD COLUMN IF NOT EXISTS`, NOT NULL with constant defaults, one nullable), latest by name, down.sql drops only what it added; schema parity, forward-apply and reversibility checks are green.

CI at this head: every check green except build-and-test, whose only failures are the 3 tests in test/coachless/coach-code-redemption.spec.ts (Tests: 3 failed, 13864 passed; red on main 6aff479c, fixed on main by #734). test/scheduling-booking-options.spec.ts and every other scheduling spec PASS. Run: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392109327/job/112039363007. No probes needed.

Cs (follow-up, non-blocking):
- C-735-1: when a client asks for a start between 121 and 365 days out at a coach on the default window, the horizon refusal now comes from inside the lock, so a pending-limit / welcome / type refusal can answer first (copy order only).
- C-735-2: after a buffered session the slot grid restarts at end + buffer (e.g. 10:55), so offered times can land on odd minutes; consider snapping to the type's grid (UX polish).
- C-735-3: the coach's minimum notice does not stop a client moving a session that is already inside the notice period, as long as the new time obeys it (design note for the owner, matches the contract).
- C (edge, deferred to 10k clients): open-slots cache on other replicas for up to 60 s after a PATCH; daily-max day edges in the coach's time zone.
