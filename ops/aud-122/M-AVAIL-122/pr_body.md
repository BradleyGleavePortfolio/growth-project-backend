## Coach booking options editor (S-AVAIL-122, mobile)

Mobile side of backend growth-project-backend#735 (`GET/PATCH /scheduling/coach/booking-options`, contract at 32d81207). Based on the
scheduling train branch `agent115/sched-split-1-scheduling-data` (#365, which now holds #366 and #367), so it lands right after scheduling.

### What a coach sees
Settings, Coach Tools: a **Booking Options** row right after **Availability** (open hours). The screen has one set of rules for every
appointment type:
- **Minimum notice**: number plus Minutes / Hours / Days. Clients cannot book a time sooner than this from now. 5 minutes to 30 days.
- **How far ahead clients can book (days)**: 1 to 365.
- **Buffer before / after each session (minutes)**: 0 to 240 each.
- **Daily maximum**: switch; off = no limit (`null`), on = 1 to 50 sessions per day, requests included.
- **Use the standard options** fills in the backend defaults (5 minutes, 120 days, no buffers, no daily maximum); Save applies them.

Validation mirrors the backend (whole numbers, ranges, notice shorter than the window). A 400 `INVALID_BOOKING_OPTIONS` (or a
class-validator 400) sentence is shown under the field it names. Success: "Booking options saved. New bookings and client moves follow
them from now on." Failures start with "Booking options were not saved." and give the next step (coach-audience copy).

### Hidden when off
The row is hidden when `GET /scheduling/coach/booking-options` answers 404 (backend without #735) or 403 (not a coach). No new mobile
flag: the entry follows the backend.

### Also
- `BEYOND_BOOKING_HORIZON` client copy no longer promises "four months" (each coach now sets the window); coach copy added.
- Save sets the cached options from the response and refreshes open slots.

### Files
`src/api/schedulingApi.ts` (types + 2 calls), `src/hooks/useCalendar.ts` (query, mutation, `bookingOptionsUnavailable`),
`src/screens/coach/CoachBookingOptionsScreen.tsx` (new), `src/screens/coach/settings/BookingOptionsEntry.tsx` (new),
`SettingsScreen.tsx`, `CoachNavigator.tsx` (route `CoachBookingOptions`), `schedulingErrors.ts` (copy),
`imessageDmRoutes.test.tsx` (mocks the new row; that test renders Settings without a query client).

### Tests
`src/screens/coach/__tests__/coachBookingOptions.test.tsx`: load, save (full set, daily max off sends null), local field error blocks
save, backend field error under the named field, range rules, Settings row shown on 200 and hidden on 404.

Size: 642 changed lines (under 1,500).
