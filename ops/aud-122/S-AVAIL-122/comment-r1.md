FIX ROUND 1 (OPENING, S-AVAIL-122, agent 122) — growth-project-backend#735 @ 32d8120712cc106eb87a4a3457661dc2cf427a1e

New PR on main (6aff479c, includes 95b0a05d and the scheduling train b#712-#720). Job text: SoT A9 "S-AVAIL-120 = coach booking options only" (owner 10:32 "COACHES DECIDE THEIR TIMES AND AVAILABILITY"). Size 915 changed lines (tests included), under 1,500. No banned casts. No onboarding change.

**Options (per coach, CoachProfile columns; defaults = the old fixed rules)**
- `min_notice_minutes` 5..43,200, default 5
- `booking_window_days` 1..365, default 120
- `buffer_before_minutes` / `buffer_after_minutes` 0..240, default 0
- `daily_max_sessions` 1..50 or null, default null (no cap)

**Endpoints (coach-only, own data, next to open hours)**
- `GET /scheduling/coach/booking-options` returns the five values plus `defaults` and `limits`
- `PATCH /scheduling/coach/booking-options` takes any subset; `daily_max_sessions: null` clears the cap; 400 `INVALID_BOOKING_OPTIONS` names the field and range; 403 for a non-coach
- open-slots response adds `min_notice_minutes` and `booking_window_days` (additive)
- Mobile contract: ops/lanes122/notify/avail.txt

**Enforcement.** Client bookings and client moves check all five inside the existing per-coach `pg_advisory_xact_lock` transaction. Notice and window are read from the coach row under the lock, then open hours, the daily maximum (moved session excluded) and buffers. Refusals reuse existing codes with plain copy: SESSION_IN_PAST / BEYOND_BOOKING_HORIZON / SLOT_UNAVAILABLE ("too close to another session", "day is fully booked"). Open slots honour the same rules, and the cache is cleared on save. Coach moves keep the 5-minute floor, can go up to the larger of 120 days and the coach's window, and are not bound by buffers or the cap.

**Migration** `20270318122000_coach_booking_options`: five additive columns with defaults, plus down.sql. Schema parity, forward-apply and reversibility checks are green.

**Tests** `test/scheduling-booking-options.spec.ts` (15 cases): each option is enforced on booking and shows up in open slots, defaults are unchanged, endpoint validation works, and the endpoints are coach-only. CI lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392131534 is green: tsc --noEmit plus 9 scheduling specs, including lifecycle-integrity 104/104.

**Decisions for the operator (recommended default = what shipped)**
1. Options are set per coach and apply to every appointment type. Recommended: keep per coach for launch; per-type overrides are a follow-up.
2. Buffers add up (before + after between two sessions) and only keep sessions apart; they may fall outside open hours. Recommended: keep.
3. The daily maximum counts requested, scheduled and pending_provider sessions on the coach's local day. Recommended: keep.

PR CI at this head: every check passes except build-and-test. Its only failures are 3 tests in `test/coachless/coach-code-redemption.spec.ts` (revoked, expired and exhausted codes return 500 `redemption_failed` instead of 410). Main 6aff479c fails the same 3 tests with the same counts (run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37390793076). This PR does not touch that code path, and every other suite passes, the new spec included (814 suites vs 813 on main). Schema parity, forward migrations and reversibility are green.

READY FOR AUDIT
