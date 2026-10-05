AUDIT GPT-6.1 Sol — growth-project-mobile#367 @ 6418e759813065dc353720533dfd5c9b5a51ceb3 — VERDICT: REQUEST CHANGES

Job: AUD-SOL-SCH1-122, agent 122. Independent first full review. A/B/C = 0/1/1.

### B-367-1 — A regular appointment is falsely reported as the welcome call

**Normal-user story:** A new client whose coach offers regular check-ins but no welcome-call type chooses a check-in from the welcome fallback, and the app calls it a welcome call and marks the tour's welcome booking done even though it booked a different appointment ([CalendarBookScreen.tsx:119–122, 166–168, 289–301](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FCalendarBookScreen.tsx)).

Counterexample: `my-coaches` returns `welcome: null`, and the coach's offered type has `is_welcome: false`; the fallback lets the client select that type, but `params.welcome` still drives the title and the unconditional `welcome_call_booked` signal on successful booking ([same screen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FCalendarBookScreen.tsx)).

**Minimal fix:** Derive the welcome heading and completion signal from the actual selected/returned welcome type, not the entry-route flag alone; keep regular appointment booking available, label it truthfully, and leave welcome deferral available. Verify both non-welcome fallback assertions and the existing genuine-welcome path in the [targeted CI probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389639924).

### C — one nonblocking follow-up

- **C-367-1:** `calendarUi.tsx:11–28` falls back to “Status unavailable” for the deployed backend's `expired` status; add an explicit expired label/deadline/action plus corresponding API type/code support in a follow-up ([status labels](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FcalendarUi.tsx), [server SessionView](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/scheduling/scheduling-session.view.ts)).

### Evidence and landing

Exact-head [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155600279/job/111298233398) succeeded before the audit probe. Main-only analyses are absent at the stacked base; required checks must run on the landing tree. Do not release the stack before B-367-1 is fixed.

No local tests/builds; no time-zone, race or retry investigation.
