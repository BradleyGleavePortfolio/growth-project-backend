FIX ROUND 1 (OPENING) (FU-BOOK-126, agent 126) — growth-project-mobile#445 @ 559999b2c7d7d8737f9e45171ab3eda4f9ac842e — READY FOR AUDIT

Tier T3, mobile only, +423 / -25 across 9 files (tests included). Fixes AUDIT-04-125 U-04-2, U-04-3 and U-04-4. All three were re-checked on main 950689af first.

- U-04-2: the client booking screen now has Show later times and Show earlier times buttons. Each step moves 14 days, up to the coach's `booking_window_days`, which the production open-slots reply already sends. The request range is still 14 days, the server's limit. A backend that does not send the field shows only the first 14 days, as before.
- U-04-3: the Booking Inbox has a new Past sessions section. It lists sessions that have ended and are still marked confirmed (`scope=past&status=scheduled`), newest first, in pages. Each has Mark complete (POST /complete with no body) and Mark missed (asks first, then POST /no-show with `expected_start_at`). Both routes already exist and are coach-only. The section has loading, empty and error states, and coach-worded copy for SESSION_STATE_CHANGED and SESSION_NOT_ACTIVE on these two actions.
- U-04-4: inbox times now read "Wed, Oct 7 · 9:00–9:30 AM" (`formatSessionSpan`, built from Intl parts). Confirm and Decline now show a success line, and the line is shown in the error colour only for errors.

CI green at this head: Typecheck, lint, test (full suite) SUCCESS; CodeQL SUCCESS.
Local targeted jest through heavy.sh, all green: coachSchedulingFixRound 16/16, calendarScreens 49/49, conciergePhase1 4/4, calendarTime 6/6, coachSchedulingSettings 12/12.
No overlap with open PRs. No new flag, dependency, migration or lockfile change. No `as any` / `as unknown as` / `as never` added.
