FIX ROUND 2 (FU-FIRSTRUN-126, agent 126) — growth-project-mobile#441 @ 9cc1fcdc1fe0982df000a5b320a0dcbeef6d6fa5 — READY FOR AUDIT

Fixes LF-SOL-126 B-441-1 (REQUEST CHANGES at a1449f37). One commit on top of a1449f37; no other behaviour changed.

- **B-441-1:** a client who picks goals and a check-in time, then taps "Open my dashboard", now keeps both answers.
  - New `src/screens/day-one/answers.ts`: the answers are kept on the device per account in `prefsStorage` under `onboarding.day1_answers:<userId>` (same pattern as `onboarding.lean_q5_draft:<userId>`). Only fields that are present overwrite, so a skipped step never erases an earlier answer. A different account reads nothing.
  - `saveGoals` keeps the real goals (no longer a no-op). `saveCheckInTime` keeps the selected time and zone before it sends the zone.
  - `ReadyScreen` keeps the draft's goals, time and zone for `user.id` before `clearResumeState()`. If that write fails, the checkpoint stays (the Day-1 gate already passes on the local completion flag). "Continue offline" keeps them too.
  - Sign-out: the prefix is added to `authActions` `USER_SCOPED_PREFIXES`, so the next person on the phone never inherits it (the same rule m#409 applied to Day-1 drafts).
  - Unchanged: `PUT /profile { onboarding_completed: true }`, `PUT /notifications/timezone` with the 404/405 fallback. No reminder promise, no migration, no flag, m#411 not reopened.
- **Regressions (fail at a1449f37, pass here):** in `day1OnboardingScreens.test.tsx`, "finishing keeps the goals and the chosen check-in time for the account" goes through the ReadyScreen finish flow and reads both answers back after the checkpoint is cleared. In `dayOneSavesAccepted.test.ts`, 3 cases now check the kept goals, time and zone, including after the offline queue drains and the checkpoint clears; another account reads null. `authActions.test.ts` sign-out sweep now covers the new key.
- **Local runs:** dayOneSavesAccepted 8/8, day1OnboardingScreens 28/28, day1OnboardingFlow 23/23, authActions 14/14. Targeted eslint is clean. R75: no new `as any` / `as unknown as` / `as never` / empty catch.
- **CI at this head:** Typecheck, lint, test SUCCESS (run 37558533543). CodeQL and Analyze (actions, javascript-typescript) SUCCESS. Mergeable.
- **Size:** +398 / −41 = 439 changed lines including tests (was 261).
