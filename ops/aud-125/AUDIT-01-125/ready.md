FIX ROUND 1 (OPENING) (AUDIT-01-125, agent 125) — growth-project-mobile#431 @ 2b735827896f3e7bce0e88b43c73911d80da968b — READY FOR AUDIT

- Fixes U-01-1: a new client who taps "Skip for now" on the Day One screen no longer gets that full-screen screen again on every app open (skip remembered per user id in prefs; RootNavigator skips the first-win status read for that user only).
- Tier T2, 116 changed lines (47 test). No backend, API, flag, dependency or lockfile change; works against the current production backend.
- Failing first: test-only commit d0123f30, ci-lane run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532574885 (2 failed for behaviour: skip marker not written; skipped user still sent to Day One. Controls passed: no skip shows Day One; another account's skip does not apply).
- PR CI at this head: Typecheck, lint, test SUCCESS (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532706299/job/112505819114). CodeQL (Analyze) still queued on the runner at posting time.
- Build profile: holds under eas.json "clinic" (standard path = coachless clients and clients whose coach has no clinic program).
- Overlap: RootNavigator.tsx also edited by m#413 (linking) and m#411 (draft hook); different hunks.
