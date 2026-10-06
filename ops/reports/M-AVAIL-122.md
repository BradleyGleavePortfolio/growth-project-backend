# M-AVAIL-122 (agent 122) — mobile coach booking options editor

Started 17:21 PDT 2026-10-05. Time box 50 min (ends 18:11).

## State
- PR: growth-project-mobile#381 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381
- Head: feab0c3b74479d2c3b644e91f301a76d92222c0e (branch agent122/avail-booking-options)
- Base: agent115/sched-split-1-scheduling-data @ a4ca533d (operator mail 17:26: #366/#367 landed into #365; tree 61376c9d = #367 2699b4b1)
- Size: 642 changed lines (641 +, 1 -).
- Backend contract: b#735 32d81207 (ops/lanes122/notify/avail.txt).
- Lane: ci/M-AVAIL-122 run 37394728273 (tsc + 13 specs), pushed 17:35.

## What was built
- Settings > Booking Options row right after Availability (src/screens/coach/settings/BookingOptionsEntry.tsx); hidden on 404/403.
- CoachBookingOptionsScreen: minimum notice (value + Minutes/Hours/Days), window days, buffer before/after, daily maximum switch;
  validation mirrors backend; server 400 sentence mapped to the named field; success/failure copy; "Use the standard options".
- schedulingApi getMyBookingOptions/updateMyBookingOptions; useCalendar useBookingOptions/useUpdateBookingOptions.
- BEYOND_BOOKING_HORIZON client copy: removed the "four months" promise (false once coaches set the window); coach copy added.
- imessageDmRoutes.test.tsx mocks the new row (renders Settings without QueryClientProvider).
- Local: heavy.sh jest coachBookingOptions.test.tsx 8/8 pass; eslint on 9 files clean.

## HANDOFF
(see bottom; updated at the end)
