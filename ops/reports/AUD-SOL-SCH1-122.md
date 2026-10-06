# AUD-SOL-SCH1-122 — scheduling mobile, agent 122

Started Mon Oct 5 16:33:49 PDT 2026; final head verification Mon Oct 5 16:47:44 PDT 2026. Independent GPT-6.1 Sol lens; no Opus-round notes, reports or comments read before posting.

## Scope and verified heads

- [growth-project-mobile#365](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365): `cceeb33a71982d44da40e75714332f59844e45fc`, base main, 2,025 changed lines (lockfile excluded: 2,014).
- [growth-project-mobile#366](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366): `fa7744cc237418a90239279541450ce2a8dc5959`, base #365, 1,680 changed lines.
- [growth-project-mobile#367](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367): `6418e759813065dc353720533dfd5c9b5a51ceb3`, base #366, 2,294 changed lines.

All created 2026-10-03, grandfathered under 3,000-line cap. Read common 122 rules, only assigned JOBS122 entry, SoT A1, A2 overrides, A5 rules 11–12, lens format from common 116.

## Initial CI evidence

- #365: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155596282/job/111298222806), [Analyze JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155596287/job/111298223206), [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155596287/job/111298223365): success.
- #366: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155598282/job/111298228111): success; main-only analyses absent at stacked base.
- #367: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37155600279/job/111298233398): success; main-only analyses absent at stacked base.

## Final verdicts

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #365 | `cceeb33a71982d44da40e75714332f59844e45fc` | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/365#issuecomment-6005601538) |
| #366 | `fa7744cc237418a90239279541450ce2a8dc5959` | APPROVE | 0/0/1 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/366#issuecomment-6005616710) |
| #367 | `6418e759813065dc353720533dfd5c9b5a51ceb3` | REQUEST CHANGES | 0/1/1 | [Sol verdict, updated with CI proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367#issuecomment-6005711262) |

All three heads were reverified unchanged immediately before finalization. Review covered ordinary booking payloads, API/backend contract compatibility, appointment types/approval/time off, coach inbox visibility, client booking/session/navigation, safe call links, notification routing and explicit phone-calendar export; time zones, races and retries were not investigated.

## B-367-1 — false welcome booking claim

**Normal-user story:** A new client whose coach offers regular check-ins but no welcome-call type chooses a check-in from the welcome fallback, and the app calls it a welcome call and marks the tour's welcome booking done even though it booked a different appointment ([CalendarBookScreen.tsx](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FCalendarBookScreen.tsx), lines 119–122, 166–168, 289–301).

Counterexample: `my-coaches.welcome = null` and a regular offered type with `is_welcome = false`; selecting its fallback button retains `params.welcome`, which drives both the heading and success signal, while the booking request uses the regular type's ID ([same screen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FCalendarBookScreen.tsx)).

Minimal fix: derive the welcome heading and completion signal from the actual selected/returned welcome type, not the entry-route flag alone; keep ordinary appointment booking and welcome deferral available. Verify the two fallback assertions turn green and the genuine-welcome tests stay green.

**Failing-before proof:** The [single-spec CI lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389639924) completed red with **40 existing tests passing and only the 2 added tests failing**: the screen retained the welcome heading, and a regular booking emitted `welcome_call_booked` once. No product code was changed.

Probe provenance:

- Base audited head: `6418e759813065dc353720533dfd5c9b5a51ceb3`.
- Source probe commit: `0c009c1ae22f1571e954c63bb542e52653db7806`.
- CI workflow wrapper head: `29129d8c96247e95b937a0377c14efa19c34f29f`.
- Added assertions: existing `src/screens/client/calendar/__tests__/calendarScreens.test.tsx:628–659`.
- Saved patch: `/home/user/workspace/ops/aud-122/AUD-SOL-SCH1-122/welcome-fallback-probe.patch`.
- Saved diff: `/home/user/workspace/ops/aud-122/AUD-SOL-SCH1-122/welcome-fallback-probe.diff`.
- Full job log and normalized log: `probe-job.log`, `probe-job-normalized.log` in that evidence directory.

No local npm, jest, typecheck, lint or build was run. The initial `gh run view` log lookup hit an unauthenticated rate-limit error; authenticated REST retrieval obtained the complete job log instead.

## C items and operator decision

- **C-366-1 (outside this diff; acceptance decision):** The weekly editor saves only windows; backend notice/horizon are fixed at five minutes/120 days and the contract has no coach-configurable notice/window/buffer/daily-max fields ([weekly editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fa7744cc237418a90239279541450ce2a8dc5959/src%2Fscreens%2Fcoach%2FCoachAvailabilityEditorScreen.tsx), [backend constants](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/scheduling/scheduling.types.ts), [backend DTO](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/scheduling/dto/scheduling.dto.ts)); recommended default is a separate minimal backend+mobile lane before declaring that owner-required day-1 scope complete, not silent omission or a B assigned to this UI slice.
- **C-367-1:** Explicitly present `expired` and its next action instead of “Status unavailable,” including API expiry type/code support ([status labels](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/6418e759813065dc353720533dfd5c9b5a51ceb3/src%2Fscreens%2Fclient%2Fcalendar%2FcalendarUi.tsx), [server SessionView](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/scheduling/scheduling-session.view.ts)); no crash or core-flow dead end established.

Backend reference was [main `5cde6253f941112f2d9afbcf572a4da838dbb16a`](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5cde6253f941112f2d9afbcf572a4da838dbb16a); scheduling/notifications source matched the original backend checkout.

## Landing and workspace state

#366/#367 approvals/checks are stacked-base evidence, not main-landing attestations; main-only analyses must pass on the landing tree. K2's new Calendar tutorial targets require K3, so do not release K2 alone. Recommended landing default: fix B-367-1, obtain fresh independent verdicts for the changed K3 head, then land the train under A5 rule 11 and required checks.

No PR branch pushes, merges, deployments, production touches, settings changes or paid actions. The only remote push was the throwaway CI lane; its remote and local branch refs have been deleted after completion. The two detached, clean worktrees are retained for reading under `/home/user/workspace/wt/AUD-SOL-SCH1-122-367` and `/home/user/workspace/wt/AUD-SOL-SCH1-122-backref` in accordance with the workspace-preservation instruction; all probe work is committed and additionally saved as patch/diff/logs. No locks were taken; exact-head claim files remain as audit history.

## HANDOFF

Finished. #365 Sol APPROVE at `cceeb33a71982d44da40e75714332f59844e45fc`; #366 Sol APPROVE at `fa7744cc237418a90239279541450ce2a8dc5959` with C-366-1 acceptance decision; #367 Sol REQUEST CHANGES at `6418e759813065dc353720533dfd5c9b5a51ceb3` for **B-367-1 only**, with the completed failing-before proof above and optional C-367-1 expiry presentation. Builder next action: use the saved probe patch to fix truthful fallback heading/signal and run the same single spec in CI; the next Sol lens reviews that B and changed lines only. Operator decision: assign a separate minimal lane for the owner-required coach policy controls before calling the day-1 scope complete. No work or CI run remains in flight.
