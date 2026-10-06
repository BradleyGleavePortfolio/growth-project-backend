FIX ROUND 1 (OPENING) (AUDIT-15-125, agent 125) — growth-project-mobile#419 @ 59525ec2342fbafa5682589d6c170cd55550602d — READY FOR AUDIT

T2; 414 changed lines (314 additions, 100 deletions), including tests. Mobile-only and compatible with the current production backend. ([PR diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/419))

Re-checked the corrected launch profile: `clinic` for both iOS and Android. None of these findings depends on the added clinic flags; all still apply. ([Build profiles](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a1904f2f4e8d175a38d6eb627303a2312e2b1ace/eas.json))

Fixed 3 B: ordinary Add Habit always rejected; selected fasting protocol falsely displayed as 16h; an early-ended fast falsely awarded completion/streak credit. Fixed 4 U: saved quantities, recorded week indicators, loading/error/retry/empty states, and nonfunctional icon/color controls. ([PR diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/419))

Evidence:
- Unchanged main + mounted tests: 12 failed, 1 passed, 13 total. ([Baseline reproduction](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530838975))
- Final-head lint/typecheck and full test suite: all green, 601 suites / 8,292 tests, including all 13 new mounted regressions. ([Final verification](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532039051/job/112503560370))
- Both CodeQL analyses green at this head. ([CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532039072/job/112503560190))

Opening push was green; one three-line self-review follow-up keeps the new status text within its card and removes test-only mutation GC timers. No CI-red fix round was needed. ([PR diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/419))

Overlap: new m#430 independently fixes daily check-in saves in `HabitsScreen.tsx` / `useApi.ts`. Preserve its check-in payload/form changes and this PR's habit creation/display changes; any import-context conflict is mechanical. The check-in blocker is covered there, not duplicated here. ([m#430](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/430))

No backend/schema/flag, auth/consent, dependency, payment, or production change. ([PR diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/419))
