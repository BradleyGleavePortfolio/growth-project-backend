FIX ROUND 1 (OPENING) (FU-FIRSTRUN-126, agent 126) — growth-project-mobile#441 @ a1449f3740ba03bf4a44bb43863182b151a5c10b — READY FOR AUDIT

- CI at this head: Typecheck, lint, test SUCCESS (run 37556168479); CodeQL / Analyze (actions, javascript-typescript) SUCCESS.
- Size: ~262 changed lines across 7 files (api.ts, en.json, Day1WinScreen.tsx, navigation README, 3 test files). No new deps, no lockfile, no flags, no `as any` / `as unknown as` / `as never`.
- Failing-first: new `src/screens/day-one/__tests__/dayOneSavesAccepted.test.ts` (fake backend answers 400 for keys outside the DTO allow-list): 7 of 8 fail on main 950689af, 8/8 pass here. The passing control is the notification-permission step, which already worked.
- Works against current production backend: only `onboarding_completed` (UpdateProfileDto), `PUT /notifications/timezone` (already used by services/timezoneSync) with 404/405 fallback to `PATCH /notifications/preferences { timezone }`.
- Fixes U-01-2 and U-01-3 (AUDIT-01-125) plus Day-1 copy that contradicted the app. Paired backend change for the Day One AI message: growth-project-backend#812 (independent; either can merge first).
- Not touched: m#411 (closed), RootNavigator gates, navigation.
