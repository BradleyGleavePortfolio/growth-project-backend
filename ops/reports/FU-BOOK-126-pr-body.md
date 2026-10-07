Tier: T3
Why: three coach/client booking screens change behaviour (client open-times paging, coach complete / missed actions on ended sessions, inbox time format and result lines). Mobile only; uses existing production routes and fields.
T4 trigger scan: none. No auth, RLS/tenancy, PII, money, credentials or destructive data. Complete and no-show call the existing coach-only routes (backend assertIsSessionCoach, scheduled -> completed | no_show only, after start); the mobile hooks already existed. No package or session-count logic exists, so marking an outcome moves no money.
T3 trigger scan: core flow (book) touched on the client: the 14-day open-slots request is unchanged; Show later times only moves `from` by 14 days, inside the coach's booking_window_days that production already returns. Older backend without the field: first page only, as today. No migration, no new flag, no dependency, no API contract change.
Bounded T1: n/a.
Canonical builder: FU-BOOK-126 (agent 126 fleet, Claude Opus 5.5).
Acceptance evidence: new cases in src/screens/client/calendar/__tests__/calendarScreens.test.tsx (paging helper; Show later / earlier asks for the next 14 days; empty first page still offers later times; no field -> no later page), src/screens/coach/__tests__/coachSchedulingFixRound.test.tsx (Past sessions list from scope=past&status=scheduled; Mark complete; Mark missed confirms then sends expected_start_at; coach copy on SESSION_STATE_CHANGED; empty state; readable request time + Confirm success line) and src/calendar/__tests__/calendarTime.test.ts (formatSessionSpan). These fail on main (no paging, no Past sessions, toLocaleString times). PR CI runs the full suite and type-check.

## U fixed (from AUDIT-04-125, re-checked on main 950689af)

- U-04-2: a coach sets "How far ahead clients can book" to 120 days, but a client booking a session only ever sees the next 14 days and has no way to see later times.
  Fix: Show later times / Show earlier times step 14 days at a time up to the coach's window; a range note ("Showing open times from Wednesday, October 21 to Tuesday, November 3."); the no-times fallback also offers later times; first-page copy names the coach's window when it is shorter than two weeks. The coach-side copy ("Open times are offered up to this many days from today") is now true and is unchanged.
- U-04-3: a coach who finished a session yesterday has no way in the app to mark it done or missed, so the client's Calendar reads "Confirmed" for it forever.
  Fix: a Past sessions section in the Booking Inbox (ended sessions still confirmed, newest first, paged) with Mark complete and Mark missed (missed asks first). The result line says what the client sees ("Marked complete. <type> shows as completed in Calendar for <client>."). Loading, empty and error states; coach copy for an outcome on a session already closed or not started.
- U-04-4: a coach opens the Booking Inbox and reads "10/7/2026, 9:00:00 AM – 9:30:00 AM".
  Fix: "Wed, Oct 7 · 9:00–9:30 AM" (built from Intl parts, so platform spacing does not change it) on requests, upcoming and past rows. Confirm and Decline now show a success line, and the line is error-coloured only for errors.

## Scope

9 files, +422 / -25 (tests included). No overlap with open mobile PRs (m#439 AIB-5, m#302, m#264/m#265, dependabot: none touch scheduling).

C (edge, deferred to 10k clients): outcomes for a session still in progress are offered once its end time passes, not before.

Nothing merged or deployed.
