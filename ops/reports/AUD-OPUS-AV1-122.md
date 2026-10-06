# AUD-OPUS-AV1-122 — Opus lens, growth-project-backend#735 (coach booking options), first review

- Lens: Claude Opus 5.5, agent 122. Started 17:18 PDT, verdict posted 17:22 PDT (2026-10-05, from `TZ=America/Los_Angeles date`).
- PR: growth-project-backend#735, head 32d8120712cc106eb87a4a3457661dc2cf427a1e (base main, merge-base 6aff479c), 13 files, +872/-43 (915, under the 1,500 cap).
- Claim: ops/lanes122/claims/backend-735-32d81207-opus
- Head verified right before posting: unchanged.
- Verdict: **APPROVE**. A 0 / B 0 / C 4.
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735#issuecomment-6006378295
- Comment text: ops/aud-122/AUD-OPUS-AV1-122/comment.md. CI log extract: ops/aud-122/AUD-OPUS-AV1-122/bt2.log

## What was checked (item list only, operator's 4 design defaults accepted)
1. Client books a time the options forbid: no. `requestSession` (the only `coachingSession.create`) and the client branch of `rescheduleSession` call `assertIntervalBookable` inside `runBookingTx` (per-coach lock). It loads the options in the same pass (`intervalBookability` -> `coachCalendarProfile`), applies notice + window, then daily max, then buffers. The pre-lock check uses only the loosest bounds (5 min / 365 days).
2. Open slots show a time that then fails: no. Same `computeFreeRanges` (buffer gap on booking holes) and `fullLocalDays` (daily max) for slots and booking; same loader (bookings widened by a day each side); `withinBookingWindow` uses the payload's coach notice/window; PATCH calls `invalidateCoach`.
3. Coach reads/changes another coach's options: no. No coach id in the route; `actor.id` only; non-coach 403. No route shadowing.
4. Defaults change today's behaviour: no (5 / 120 / 0 / 0 / null reproduce the old floor, ceiling, slots and refusals).
5. Migration not additive: additive (ADD COLUMN IF NOT EXISTS x5, constant defaults), latest by name, down.sql exact reverse; parity/forward/reversible checks green.

## CI at the head
All checks green except build-and-test: only test/coachless/coach-code-redemption.spec.ts fails (3 tests; red on main 6aff479c, fixed on main by #734). All scheduling specs including test/scheduling-booking-options.spec.ts PASS. Run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392109327/job/112039363007. No probes or lane runs used.

## Cs (non-blocking)
- C-735-1: 121-365-day requests at a default-window coach now get the horizon refusal inside the lock, so pending-limit / welcome / type refusals can answer first (copy order only).
- C-735-2: slot grid after a buffered session restarts at end + buffer (odd minutes such as 10:55); consider snapping to the type grid.
- C-735-3: min notice does not stop a client moving a session already inside the notice period, if the new time obeys it (design note, matches contract).
- C (edge, deferred to 10k clients): 60 s per-process open-slots cache on other replicas after PATCH; daily-max day edges in coach time zone.

## HANDOFF
Done. Verdict APPROVE posted at 32d8120712cc106eb87a4a3457661dc2cf427a1e (comment 6006378295). Worktree wt/AUD-OPUS-AV1-122-1 removed; no ci/* or audit/* branches were created; no locks held (claim file stays as the record). Nothing left for this lens at this head. If the head moves, a delta re-review (20 min) checks only the changed lines; the Sol lens verdict is the operator's to pair with this one.
