# AUD-SOL-HC13-121 — independent review notes

## Evidence and scope
- Review opened at 2026-10-05 14:51:53 PDT and targeted verification began at 14:53:24 PDT, both from local `date`.
- Claims cover mobile `2ea649a1` and backend `958d340d`; live PR heads remained exact at 14:54:03 PDT. [Mobile candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378), [backend candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731)
- Read _COMMON_121 items 1–14, only the assigned JOBS121 entry, source-of-truth A1/A6/A9.1, and lens contract section 8.
- Independent of the other lens's current-round notes/comment; prior Sol H9 report and builder opening comments were allowed evidence. [Prior Sol H8 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/370#issuecomment-5999981686), [mobile opening](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6002676577), [flag opening](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6002677024)

## Mobile review
- All 11 changed files reviewed: 1,055 additions/deletions, no generated/lockfile exclusions needed. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378)
- `ingestBatching.ts:261-324,357-376`: finite queued acquisition waits, shared pacing state, bounded 429 retries, fence after acquisition before HTTP; no account information added to shared pacer. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378)
- `onDeviceSync.ts:220-243`: actual production HealthKit and Health Connect paths both pass `sharedIngestPacer`, not merely test seams. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378)
- `healthConnectSyncService.ts:283-347`: only completed fresh reads filter look-back records; resume pages and first imports post normally; type/page save order and scope are unchanged. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378)
- `lookBack.ts:61-69,111-135`: filters only known spans/modified times wholly inside completed reads; overlapping sleep chooses one record, preserving disjoint naps. First-session-wins is an explicitly accepted launch default. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378), [builder acceptance](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6002676577)
- `healthKitSyncService.ts:317-347`, `healthKitNormalizer.ts:489-525`: end-range selector is threaded from piece to normalizer; existing full-reader and whole-session gates remain; the run pacer and fence are supplied on each batch. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378)
- Permissions, package/native configuration and dependencies are untouched in this PR. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378)

## Independent targeted execution
- The job-specific permission allows one spec through `heavy.sh`; executed exactly one: `src/services/health/healthConnect/__tests__/healthConnectSyncService.hc12.test.ts`, 6/6 PASS, 3.525 seconds, pipeline `0 0`.
- Log: `ops/aud-121/AUD-SOL-HC13-121/healthConnectSyncService.hc12-local.log`.
- This is local synthetic verification, not CI/native/store/device acceptance; neither candidate source nor tests were changed.
- No new probes were added for prohibited edge categories.

## Backend review
- `.github/fly-env-desired-state.json:35,94`, `docs/runbooks/launch-flags.md:142-151`: sole managed value change is ingest `unset` to `true`; explicit merge/apply/verify/device ordering and rollback match the existing guard and workflow input. [Backend PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731)
- Existing `on-device-ingest.feature.ts:19-30`, `wearable-samples.controller.ts:228-296`, `wearables-throttle.ts:23-33` retain fail-closed flag handling, JWT-stamped subject, owned/live connection/provider checks and isolated 60/60-second bucket. [Backend PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731)
- No independently executed backend test; builder's 136 manifest/sync/workflow assertions are reported evidence, not this lens's execution. [Backend opening](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6002677024)

## CI and disposition
- Mobile checks cancelled: [CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37371374734), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37371374836).
- Backend substantive checks cancelled; readiness comment failed trying to download missing `deploy-readiness-board`; readiness gate skipped. [Readiness run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372034843)
- No in-scope A/B, no new C; approval is source/code approval only, not permission to bypass required checks.
- Existing replacement ticket remains [backend #732](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/732); no edge analysis/probe or new product decision.
- Intended verdicts: APPROVE 0/0/0 on both exact heads; mobile merge before flag apply, then owner device pass.
