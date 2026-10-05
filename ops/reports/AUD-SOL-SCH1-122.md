# AUD-SOL-SCH1-122 — scheduling mobile, agent 122

Started Mon Oct 5 16:33:49 PDT 2026. Independent GPT-6.1 Sol lens; no Opus-round notes or comments read.

## Scope and verified heads

- [growth-project-mobile#365](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365): `cceeb33a71982d44da40e75714332f59844e45fc`, base main, 2,025 changed lines (lockfile excluded: 2,014).
- [growth-project-mobile#366](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366): `fa7744cc237418a90239279541450ce2a8dc5959`, base #365, 1,680 changed lines.
- [growth-project-mobile#367](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367): `6418e759813065dc353720533dfd5c9b5a51ceb3`, base #366, 2,294 changed lines.

All created 2026-10-03, grandfathered under 3,000-line cap. Read common 122 rules, only assigned JOBS122 entry, SoT A1, A2 overrides, A5 rules 11–12, lens format from common 116.

## Initial CI evidence

- #365: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155596282/job/111298222806), [Analyze JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155596287/job/111298223206), [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155596287/job/111298223365): success.
- #366: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155598282/job/111298228111): success; main-only analyses absent at stacked base.
- #367: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155600279/job/111298233398): success; main-only analyses absent at stacked base.

## Review

#365 code review complete: APPROVE, A/B/C = 0/0/0; [verdict posted](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6005601538).

#366 code review complete: APPROVE, A/B/C = 0/0/1; [verdict posted](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6005616710). C-366-1 is the cross-backend owner-acceptance question on notice/window/buffers/daily max, not a defect in an offered control.

#367 candidate B: selecting a regular appointment from the welcome fallback retains the welcome-call title and unconditionally emits `welcome_call_booked` on success, despite the chosen type not being the coach's welcome type ([CalendarBookScreen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FCalendarBookScreen.tsx), lines 119–122, 168, 289–301).

One CI-lane probe in flight: [welcome-fallback screen proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389639924), lane head `29129d8c96247e95b937a0377c14efa19c34f29f`; source probe commit `0c009c1` adds two normal-user assertions to the existing calendar screen spec. Probe diff saved to `/home/user/workspace/ops/aud-122/AUD-SOL-SCH1-122/welcome-fallback-probe.diff`. No local tests or builds.

Backend contract reference verified against [main commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5cde6253f941112f2d9afbcf572a4da838dbb16a); scheduling/notifications source is unchanged from the original backend clone's checkout.

Candidate nonblocking follow-ups: deployed expiry state is not represented explicitly by the new UI; coach-policy acceptance gap (notice/window/buffers/daily max) crosses the existing backend boundary. Keep these separate from the one precise welcome false-claim B. No time-zone, race, retry investigation.

## HANDOFF

Review in progress at exact heads above. Read-only detached worktree `/home/user/workspace/wt/AUD-SOL-SCH1-122-367`; diff/API evidence under `/home/user/workspace/ops/aud-122/AUD-SOL-SCH1-122/`. No production, settings, branch pushes, merges, local builds or tests performed.
