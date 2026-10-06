# M-AVAIL-122 (agent 122) — mobile coach booking options editor

Started 17:21 PDT 2026-10-05. Time box 50 min (ends 18:11).

## State
- PR: growth-project-mobile#381 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381
- Head: feab0c3b74479d2c3b644e91f301a76d92222c0e (branch agent122/avail-booking-options)
- Base: agent115/sched-split-1-scheduling-data @ a4ca533d (operator mail 17:26: #366/#367 landed into #365; tree 61376c9d = #367 2699b4b1)
- Size: 642 changed lines (641 +, 1 -).
- Backend contract: b#735 32d81207 (ops/lanes122/notify/avail.txt).
- Lane: ci/M-AVAIL-122 run 37394728273 green: tsc --noEmit clean, 13 suites / 326 tests pass. Log ops/aud-122/M-AVAIL-122/lane-37394728273.log. Lane branch deleted 17:37.
- PR CI: "Typecheck, lint, test" green at feab0c3b (run 37394781589, 3m51s); the only check on a non-main base.
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6006728984 (FIX ROUND 1 (OPENING, M-AVAIL-122, agent 122) ... READY FOR AUDIT)

## What was built
- Settings > Booking Options row right after Availability (src/screens/coach/settings/BookingOptionsEntry.tsx); hidden on 404/403.
- CoachBookingOptionsScreen: minimum notice (value + Minutes/Hours/Days), window days, buffer before/after, daily maximum switch;
  validation mirrors backend; server 400 sentence mapped to the named field; success/failure copy; "Use the standard options".
- schedulingApi getMyBookingOptions/updateMyBookingOptions; useCalendar useBookingOptions/useUpdateBookingOptions.
- BEYOND_BOOKING_HORIZON client copy: removed the "four months" promise (false once coaches set the window); coach copy added.
- imessageDmRoutes.test.tsx mocks the new row (renders Settings without QueryClientProvider).
- Local: heavy.sh jest coachBookingOptions.test.tsx 8/8 pass; eslint on 9 files clean.

## Decisions (recommended defaults)
1. Entry hides on 404 and 403, shows while loading and on network errors (screen offers Refresh). Keep.
2. No mobile feature flag; the backend route is the switch. Keep.
3. Merge after #365 lands; before b#735 deploys the row stays hidden (404), so order is safe. Land with the scheduling train.
C follow-up: client Calendar copy could use the new open-slots min_notice_minutes / booking_window_days fields.

## HANDOFF
- Finished 17:42 PDT. PR #381 pushed, commented READY FOR AUDIT, CI green. No run in flight.
- Worktree wt/M-AVAIL-122 removed (clean, pushed), local branch m-avail-122 deleted, lane branch ci/M-AVAIL-122 deleted.
  No lock taken. Notify file ops/lanes122/notify/m-avail.txt written.
- Next job: both lenses first review of m#381 at feab0c3b (T3 mobile). If #365 merges to main first, retarget #381's base to main
  (GitHub does this automatically when the base branch is deleted after merge; otherwise `gh pr edit 381 --base main`).
