# AUD-SOL-H9-120 — Health Connect H7 fix round 2 and H8 opening

Independent Sol audit lens, agent 120; bounded scope is mobile #369 and #370, T4 health consent and data. [H7 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369), [H8 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370).

## Current state

- Started 2026-10-05 10:41 PDT (local `date`); common rules, LAW, audit contract, prior H7 report/probe and builder report read; no heavy local execution.
- Exact-head claims acquired for #369 `a2bfe2fa906ff5e3b991613a6838a82456db920c` (1,270 lines) and #370 `c7014623520baf23a697f4d646e3d80a423789c5` (1,050 lines); API snapshots/comments saved in `ops/aud-120/AUD-SOL-H9-120/`. [H7 fix round 2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999327369), [H8 opening](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999807045).
- Full three-file H7 fix delta and all ten H8 changed files/surrounding code reviewed; state/auth source is byte-identical between H7 and H8, with no H8 dependency or lockfile edits. [H7 repair](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999327369), [H8 opening](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999807045).
- Independent H7 lane 1 has 170 passing controls and 3 failures solely in an incorrectly added probe assertion that demanded an already-issued native grant write reject; the unchanged original correctly permits that write to resolve but requires durable revocation and drain. This is a probe adaptation error, not a candidate finding; the original 446-line Sol suite was restored byte-identically for unique lane 2, which completes **15 suites / 173 tests PASS** at execution `9c36b35489d21f46c3672bb635cad4a5c5597f95`. [First execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37350441572), [Corrected replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37350900582).
- Independent H8 lane completes **17 suites / 272 tests PASS** at execution `68297452370c209e8df8d0ff1a29e72f1946c9b3` (candidate plus only two test specs/workflow); six new controls cover expired token retry, acknowledged-page/day save failure, stop after upload, real HealthKitClient sleep-piece boundary, and both hourly metrics' two-hour settle. [H8 proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37350796133).
- Exact-head ordinary Typecheck/lint/test succeeds for both PRs; Analyze is absent on stacked bases, not a claimed successful check. [H7 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37345688498/job/111883559185), [H8 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37349317509/job/111895848952).
- Builder probe execution trees independently fetched and compared: their changes from candidate/test-only heads are only probe specs and lane files; before H7 repair the four new B-369-2 assertions fail, and broad after logs contain only the five obsolete-documentation expectations. [Before](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344884167), [H7 broad after](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37345713886), [H8 broad after](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37349349960).

## Prior findings / acceptance

- **B-369-2 CLOSED**, `onDeviceState.ts:191-199,224-246`: epoch checks after awaited session/authority operations prevent stale grant publication; the original actual-signOut session-read and authority-creation interrupted schedules both pass, with token deletion, fresh-module lifetime, other-account and completed-drain controls. [Final H7 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148).
- **H1-H7 (#359-#364, #369) is clear to land as one from this Sol lens**: B-369-1 and H4 B-362-8/9 remain closed in H7 composition; H4's conditional approval is satisfied, not converted to standalone approval. B-362-2/6/7 and committed-sequence failed-grant closure remain intact. [Final H7 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148), [H4 conditional verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5998888651).
- H8 full review and independent native-wrapper/normalizer/page/day probes complete without A/B findings; C-360-1/2 close within the selected one-day/two-hour bounds, not as unlimited late-data/replacement semantics. [Final H8 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).

## Published verdicts

Heads were re-read through live PR REST immediately before each separate POST, unchanged; publication time 2026-10-05 10:50:13 PDT (from local `date`). [H7 published verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148), [H8 published verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).

| PR | Exact head | Sol verdict | A/B/C | Comment |
|---|---|---|---|---|
| #369 H7 | `a2bfe2fa906ff5e3b991613a6838a82456db920c` | APPROVE | 0/0/2 | [Final H7](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148) |
| #370 H8 | `c7014623520baf23a697f4d646e3d80a423789c5` | APPROVE | 0/0/3 | [Final H8](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686) |

## Follow-ups (C)

- **C-369-2**, `src/services/health/onDeviceState.ts:403-432`: bind/discard progress from a stale consent session; preserve normal same-session resume. [Final H7 follow-ups](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148).
- **C-369-3**, `src/services/authActions.ts:384,460-462`, pre-existing/outside delta: resilient auth-cleanup boundary so early rejected dependencies do not skip logout, with truthful recovery; health drain already remains unconditional. [Final H7 follow-ups](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148).
- **C-370-1**, backend `src/wearables/ingestion/dedup.util.ts:55-63`, `ingestion.service.ts:101-108,125-129`, paired mobile `healthConnectSyncService.ts:303-306`: owner-ruled backend follow-up, replace rewritten on-device records by stable provider/source-record identity with compatible read/dedup behavior. [Final H8 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).
- **C-370-2**, `healthKitSyncService.ts:91-102,258-260,303-307`, backend `ingestion.service.ts:125-129`: retain approved two-hour settle limit; backend replace-by-hour semantics then remove settle delay with regression tests for later shares. [Final H8 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).
- **C-370-3**, `healthConnectSyncService.ts:164-168`, `healthKitSyncService.ts:214-222,277-279`, pre-existing: clamp future progress after clock rollback, preserve normal monotonic progress and test recovery. [Final H8 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).
- Existing H4 C-362-5 and Opus C-369-4/5 remain separate tickets, not new Sol count additions; changes-token efficiency is a later improvement, not an extra finding. [H4 follow-up](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5998888651), [Opus follow-ups](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999043389).

## Operator decisions — recommended defaults

- Keep the already selected one-day look-back, two-hour Apple hourly settle and backend rewritten-record follow-up; no new product decision is requested. [H8 acceptance and limits](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).
- Prefer H1-H8 land-as-one once both exact-head lenses approve and integrated main-based required checks are green; no intermediate ship, no device/native/privacy/flag/release readiness claim from these synthetic CI probes. [Final H7 landing disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148), [Final H8 landing disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).

## HANDOFF

Verdicts complete: #369 **APPROVE 0/0/2**, B-369-2 closed and H1-H7 clear-to-land as one from Sol; #370 **APPROVE 0/0/3**, full first review and H8 independent proof green. [Final H7](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148), [Final H8](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).

Cleanup complete 2026-10-05 10:51:51 PDT (from `date`): own `audit/AUD-SOL-H9-120/{369-1,369-2,370-1}` remote branches deleted and absence verified; both own detached worktrees removed; no own local lane branch remains. `cleanup.log` records verification. Completed-head claims and all saved probes, diffs, API snapshots, payloads/receipts and CI logs remain under `ops/aud-120/AUD-SOL-H9-120/`.

Final REST verification confirms both posted heads unchanged. Next operator action is companion-lens/integrated-check reconciliation and landing under rule 11, with the listed C tickets; no further builder remedy is requested by Sol. [H7 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999981148), [H8 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686).

No candidate source or PR-branch edits, local heavy tests, builds, merges, deployments or production action.
