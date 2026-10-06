Tier: T2
Why: Repair ordinary habit creation and incorrect client-facing habit/fasting data using the existing production API contracts.
T4 trigger scan: none; no auth, tenancy, consent, payment, destructive operation, health-data exposure, or credential changes.
T3 trigger scan: none; no offline sync, distributed invariants, or schema changes.
Bounded T1: NO; runtime API-payload and view-model behavior changes.
Canonical builder: GPT-6.1 Sol (AUDIT-15-125).
Parent owner: operator agent 125.
Acceptance evidence: mounted Habits/Fasting screen tests exercise production-shaped API responses, creation payload, check-off/undo, week indicators, load failure/retry, empty state, every selectable fasting target, early stop/history, and ordinary consecutive qualifying days.
Promotion triggers: auth/PII scoping or new persistence requirements are operator-routed T4 work, not part of this PR.

## B fixes
- B1: A client taps Add Habit with an ordinary name, but unsupported icon/color/frequency fields cause production validation to reject every request and prevent habit tracking.
- B2: A client selects 12, 18, 20, or 24 hours and starts or reopens a fast, but the timer and history falsely show a 16-hour target because the app ignores the saved protocol.
- B3: A client ends a fast after a few minutes and sees completion/streak credit despite the confirmation explicitly saying it will not count as completed.

## U fixes
- U1: Checking off an eight-glass habit still shows 0/8 because the app reads `count` instead of the saved API `value`.
- U2: Habit week indicators stay blank after consecutive daily completions because they are hard-coded false.
- U3: Unfinished or failed habit reads show an apparently real 0% instead of loading/error/retry or new-client empty states.
- U4: The add-habit form offers icon/color controls that the production backend neither accepts nor stores; remove those nonfunctional controls, retaining name, target and unit.

## Contract compatibility and scope
- Mobile-only; works against the currently deployed backend.
- Keep legacy numeric fasting target/completion response fields compatible, while reading current `FastingWindow.protocol`.
- Completion follows the existing [local fasting rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a1904f2f4e8d175a38d6eb627303a2312e2b1ace/src/db/fastingDb.ts) (90% of selected target); early-stop confirmation and streak credit now agree with history status.
- Habit streaks endpoint remains retired (410); no new gamification or endpoint.
- No migrations, dependencies, lockfile changes, launch flags or production access.
- Reviewed relevant open m#408, m#409, b#777 diffs and m#404/m#406/m#411/m#412/m#415 file lists; no overlapping source files or duplicate fixes.
- New m#430 independently fixes daily check-in writes and shares `HabitsScreen.tsx` / `useApi.ts`; preserve both changes. This PR touches habit creation/display and loading states, while m#430 touches check-in payload/form state. Its save-check-in blocker is covered there, not duplicated here.

## Validation
- Baseline reproduction: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530838975 — main code plus tests: 12 fail, 1 pass, 13 total, including the unsupported habit fields and non-16-hour protocol failures.
- Initial fix CI: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37531252294/job/112500904517 — lint/typecheck pass; 601 suites and 8,292 tests pass, including all 13 mounted regressions.
- Final-head CI after self-review of status-card wrapping and test cleanup: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532039051/job/112503560370 — all green at `59525ec2342fbafa5682589d6c170cd55550602d`; lint/typecheck pass, 601 suites / 8,292 tests pass, including all 13 new mounted regressions.
