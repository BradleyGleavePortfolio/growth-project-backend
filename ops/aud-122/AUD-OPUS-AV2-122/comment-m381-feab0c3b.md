AUDIT Claude Opus 5.5 — growth-project-mobile#381 @ feab0c3b74479d2c3b644e91f301a76d92222c0e — VERDICT: REQUEST CHANGES

Lens AUD-OPUS-AV2-122, agent 122. A 0 / B 1 / C 2. RUTHLESS SCOPE (SoT A2 items 7-11). Read against backend b#735 @ 082d4653aa88ab1e4b05817a3a305fc138805026. PR CI "Typecheck, lint, test" green at this head (run 37394781589). No probes needed.

**B-381-1 — a minimum notice of 14 days or more leaves every client with no times to book**
`src/screens/coach/CoachBookingOptionsScreen.tsx:97` (the notice check accepts up to the backend's 30 days) together with `src/hooks/useCalendar.ts:39,95-117` and `src/screens/client/calendar/CalendarBookScreen.tsx:135-136,290`. The client booking and moving screen only asks for open times from now to now + 14 days (`OPEN_SLOTS_RANGE_DAYS = 14`, and the server caps a request at 14 days), and b#735 drops every slot earlier than now + the coach's notice. So with notice of 14 days or more the list is always empty, and there is no way to look further ahead.
Normal-user story: a coach who wants two weeks' notice taps Days, types 14 and saves (the editor says up to 30 days is allowed), and from then on every client who opens Book a time or tries to move a session sees "There are no open times in the next two weeks" and cannot book that coach in the app at all.
Smallest fix (recommended default): in `validateBookingDraft`, refuse a notice of `OPEN_SLOTS_RANGE_DAYS` days or more with a plain field sentence, e.g. "Clients see open times for the next 14 days, so minimum notice must be shorter than 14 days.", and add one assertion to the existing range test. About 4 lines. Alternative (operator choice, more lines): have CalendarBookScreen start its 14-day range at now + `min_notice_minutes`, which the open-slots payload now returns.

**Checked and fine**
- Fields and limits: GET/PATCH `/scheduling/coach/booking-options` (the route is PATCH, not PUT). The five field names, the ranges (5..43200, 1..365, 0..240, 0..240, 1..50 or null) and the rule that notice must be shorter than the window all match b#735's `BOOKING_OPTION_LIMITS` and `mergeBookingOptions`. The server's `limits` and `defaults` override the local copies when they are sent. PATCH sends all five values and sends `daily_max_sessions: null` when the daily maximum is off, which `@IsOptional` accepts.
- Refusal sentences: `serverFieldError` regex prefixes match every b#735 `LABELS` sentence, the notice-shorter-than-window sentence and the class-validator `@IsInt` messages. `HttpExceptionFilter` keeps `code` and `message`. INVALID_BOOKING_OPTIONS without a field gets the coach copy. A 404 COACH_NOT_FOUND on save gets "Finish coach profile setup first".
- Entry hidden on 404 and 403 (`bookingOptionsUnavailable`). A 403 or 404 does not retry. The screen shows a plain "not available for this account yet" line.
- Client BEYOND_BOOKING_HORIZON copy no longer promises four months, and it matches the coach's own window. The coach copy for the same code is true for coach moves (the larger of 120 days and the coach's own window).
- After a save, open slots refresh (`invalidateQueries(['scheduling','openSlots'])`). Copy has no first person, no emojis, no exclamation marks and no generic errors.

**Cs (one line each)**
- C-381-1: when a client books a stale slot inside the notice, the refusal says "too close or has passed" rather than "at least 1 day ahead". Open slots already hide those times; the payload's `min_notice_minutes` could feed a "Book at least N ahead" line later.
- C-381-2: the row label "Booking Options" and the screen header "Booking options" differ in case (the Settings rows already mix cases).
