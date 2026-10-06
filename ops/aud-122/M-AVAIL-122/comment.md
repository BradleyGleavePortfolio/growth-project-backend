FIX ROUND 1 (OPENING, M-AVAIL-122, agent 122) — growth-project-mobile#381 @ feab0c3b74479d2c3b644e91f301a76d92222c0e

New PR: coach booking options editor (mobile side of growth-project-backend#735 @ 32d8120712cc106eb87a4a3457661dc2cf427a1e).
Base: `agent115/sched-split-1-scheduling-data` @ a4ca533dd8f0cdaa36c88a33abe2efc40429c666 (scheduling train #365, which now holds #366 and #367; tree 61376c9d = #367 2699b4b1). One commit, 642 changed lines (under 1,500).

**What it does**
- Settings, Coach Tools: **Booking Options** row right after **Availability**. Hidden when `GET /scheduling/coach/booking-options` answers 404 (backend without #735) or 403 (not a coach). No new mobile flag.
- Screen `CoachBookingOptionsScreen`: minimum notice (number + Minutes/Hours/Days, 5 minutes to 30 days), how far ahead clients can book (1-365 days), buffer before / after each session (0-240 minutes), daily maximum switch (off = `null`, on = 1-50, requests included). Short impersonal helper line under each.
- Validation mirrors the backend (`mergeBookingOptions`): whole numbers, ranges, notice shorter than the window. A 400 `INVALID_BOOKING_OPTIONS` or class-validator sentence is shown under the field it names (prefix match on the backend labels).
- Save sends the full set; success "Booking options saved. New bookings and client moves follow them from now on."; failures start "Booking options were not saved." plus the coach next step (COACH_NOT_FOUND: finish coach profile setup). Save writes the response into the cache and refreshes open slots. "Use the standard options" fills in the backend defaults; Save applies them.
- `BEYOND_BOOKING_HORIZON` client copy no longer promises "four months" (false once a coach sets the window); coach copy added.

**Tests** — `src/screens/coach/__tests__/coachBookingOptions.test.tsx` (8): load, save (full set; daily max off sends null; unit change to days), local field error blocks save, backend field error under the named field, range and notice-vs-window rules, Settings row shown on 200 and hidden on 404 (no retry).

**CI**
- Mobile CI lane run [37394728273](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394728273): `tsc --noEmit` clean; 13 suites / 326 tests pass (new spec + coachSchedulingSettings, coachSchedulingFixRound, imessageDmRoutes, schedulingErrors, coachSaasBlockers, CrossPillarSurface, paymentsConnectPackages, romanConversationsReachable, romanA11yR3, importDataFlagOff, calendarScreens, schedulingApi). Lane branch deleted.
- PR CI: CI_STATUS_LINE

**Decisions (recommended defaults)**
1. Entry hides on 404 and 403, shows while loading and on network errors (the screen then offers Refresh). Recommended: keep.
2. No mobile feature flag; the backend route is the switch. Recommended: keep.
3. Merge after b#735 is merged and deployed; before that the row stays hidden (404), so order is safe either way. Recommended: land with the scheduling train.

C (follow-up, not blocking): client Calendar copy could use the new `min_notice_minutes` / `booking_window_days` open-slots fields ("Book at least 1 day ahead").

READY FOR AUDIT
