**Tier:** T3 (core flow: client first run, Day-1 onboarding fallback). Mobile only.
**Why:** AUDIT-01-125 U-01-2 and U-01-3 (FU-FIRSTRUN-126, agent 126). Every Day-1 write used a field the backend rejects with a 400, so a client sent through Day-1 saw "Couldn't save your progress" on every step.
**T4 trigger scan:** none. No auth, RLS/tenancy, money, credentials or destructive data. The only server writes are `PUT /profile { onboarding_completed: true }` (already sent by lean onboarding) and the device zone on the existing `PUT /notifications/timezone` route that `services/timezoneSync.ts` already uses at sign-in.
**T3 trigger scan:** core flow (Day-1 onboarding persistence + Day One win copy). No navigation, gate or flag change. Works against the current production backend (f71bb9a4): every field sent is on the backend allow-list; `setTimezone` falls back to `PATCH /notifications/preferences { timezone }` on 404/405.
**Bounded T1:** `src/screens/day-one/api.ts`, `src/screens/day-one/i18n/en.json`, `src/screens/client/Day1WinScreen.tsx`, `src/navigation/README.md`, tests.
**Canonical builder:** FU-FIRSTRUN-126 (Claude Opus 5.5).
**Acceptance evidence:** new `src/screens/day-one/__tests__/dayOneSavesAccepted.test.ts` uses a fake backend that answers 400 for any key outside the DTO allow-list, like production. On main: 7 of 8 fail (the notification-permission control passes). With this change: 8/8 pass. Also passing locally: `day1OnboardingFlow.test.ts` (23), `day1OnboardingScreens.test.tsx` (27), `Day1WinScreen.test.tsx` (16, 2 new). Targeted eslint clean.

## Fixes
- **U-01-2 (Day-1 saves rejected).** A client whose last onboarding answer did not reach the server (for example offline at Q6) is sent through Day-1, and every step shows "Couldn't save your progress" and needs "Continue offline", because the writes use fields the backend does not have.
  - `completeDayOne` sends `{ onboarding_completed: true }` (accepted; read back as `profile.onboardingCompleted`, so the client is not sent through Day-1 again on another device). It sent `day_one_completed`.
  - `saveCheckInTime` sends only the device zone (`PUT /notifications/timezone`, source `device`; 404/405 fallback to the preferences route). A zone the backend refuses (other 4xx) does not block the step. A network failure still fails it, so "Continue offline" queues it. It sent `daily_checkin_time` / `daily_checkin_timezone` to `PUT /profile` and `PATCH /notifications/preferences`; neither exists.
  - `saveGoals` makes no network call (the backend has no goals field); the selection stays in the Day-1 draft on the device.
  - Result: the queued items from "Continue offline" now drain (test covers a 4-item queue draining to an empty, cleared checkpoint).
- **U-01-3 (Day One win copy).** A client who taps a Day One card sees "YOUR FIRST DATA POINT" before logging anything, and the "Submit your first check-in" card lands on the habit list and says "between you and your coach" to coachless clients too. Now: eyebrow "YOUR FIRST STEP" (recommended default), card "Check off today's habits" / "Opens your habit list. One tick a day is how streaks start.", meal card no longer assumes a coach.
- **Day-1 copy that contradicted the app** (same file, same flow): check-in subtitle no longer says "We'll remind you once a day at this time" (no reminder at a chosen time exists); Ready no longer says "Your coach has been notified you've joined" (shown to coachless clients); notifications screen no longer says "Never spam" / "Nothing else. Promise." (booking reminders and milestones also send); goals subtitle no longer says it can be adjusted any time (no screen for it); "Continue offline" copy has no first person.

## Not in this PR
- A real backend home for Day-1 goals and the check-in time plus a reminder at that time needs a migration and a job: post-launch (operator/owner decision).
- m#411 (offline resume) is closed and not used here.
