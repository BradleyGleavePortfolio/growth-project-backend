# AUD-SOL-W12-116 — GPT-6.1 Sol

## Mandate and final evidence status

T4, read-only audit of mobile #359 at `e0f3d2a75bf6e462a53e7c0ad4f18e388e72189d` and #360 at `4a508d8bc01c2fa080fd120cbe02c7824ce06cdf`; both exact heads claimed for this lens. Scope and land-as-one mandate are recorded in the [operator readiness record for #359](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/359#issuecomment-5975773302) and [readiness / size assessment for #360](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5975773333).

This lens's latest original approval is #317 at `82137c312e957cb05eedeaebf86fcd95029f2bde`; its later `d0407b62` request-changes contains only B-317-12, two clinic-on test expectations outside these pieces. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972055787); [merge-only Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972176395).

G09 applicability: all 8 #359 changed blobs and all 20 surviving #360 changed blobs are byte-identical to both original heads above; #360's four deleted files are absent at both original heads. [Approved original tree](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/82137c312e957cb05eedeaebf86fcd95029f2bde); [split #359](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/e0f3d2a75bf6e462a53e7c0ad4f18e388e72189d); [split #360](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/4a508d8bc01c2fa080fd120cbe02c7824ce06cdf).

Full piece-boundary review completed independently; H1 reuses accepted source evidence, while H2 reuse is explicitly partial because a newly executed privacy counterexample overrides the previous absolute logger-safety inference, without reopening the repaired shell classifier or pretending the defect was caused by splitting. [Published H1 decision](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/359#issuecomment-5976316854); [published H2 decision](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976328100).

Evidence retained in `ops/aud-116/AUD-SOL-W12-116/`: complete piece diffs, original audit/fix comments, exact-head check-run JSON, per-file blob identity and CI logs. No local heavy command, candidate edit, build, merge or production action.

## Required checks

- #359: Typecheck, lint, test SUCCESS; both Analyze checks SUCCESS at exact head. [Typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37156242441/job/111300093936); [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37156242445/job/111300093944); [Analyze JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37156242445/job/111300093875).
- #360: Typecheck, lint, test SUCCESS at exact head (449 suites / 6,342 tests); Analyze main-base-only and not run on this stacked base, so whole-stack main-based Analyze results remain a landing gate, not a claimed green H2 check. [Typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37156241700/job/111300091368); [stacked base and land rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5975773333).

## #359 completed

Posted APPROVE, A/B/C 0/0/0, after fresh-head confirmation; its 8 paths are byte-identical to the previously approved original and the full piece is inert, account-scoped and independently green at the specified head. [Published Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/359#issuecomment-5976316854).

## #360 completed — REQUEST CHANGES 0/1/0

Posted exactly one verdict after fresh-head confirmation at `4a508d8bc01c2fa080fd120cbe02c7824ce06cdf`: REQUEST CHANGES, A/B/C 0/1/0. [Published Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976328100).

All 3,697 diff lines read; 20 surviving blobs equal the original approved head, the 4 deleted hook/test paths are absent there too, and the H1 base changes none of H2's paths. [Exact H2 source](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/4a508d8bc01c2fa080fd120cbe02c7824ce06cdf).

The one app-reachable changed seam is the existing sheet's call to `connectOnDeviceProvider(target)` without an attempt callback; its older switch does not handle the helper's new `error` outcome on iOS, so no partial-stack build/OTA is safe, and the operator's land-as-one rule is mandatory rather than optional. [H2 source tree](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/4a508d8bc01c2fa080fd120cbe02c7824ce06cdf); [land-as-one instruction](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5975773333).

The changed Health Connect read-error catch still forwards arbitrary native error text into the logger and does not re-check the fence before that logging; unlike direct sample/count logs, that can violate the closed-data privacy boundary, including when a rejected page arrives after sign-out begins. [H2 source](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/4a508d8bc01c2fa080fd120cbe02c7824ce06cdf).

**B-360-1:** `src/services/health/healthConnect/healthConnectSyncService.ts:218-232`, especially `:221,:231`, logs arbitrary native error text and checks only whether the rejection itself is a stop error, not whether the actual fence has stopped; the fulfilled-native-read path is fenced but the rejection path is not. [Exact catch](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4a508d8bc01c2fa080fd120cbe02c7824ce06cdf/src%2Fservices%2Fhealth%2FhealthConnect%2FhealthConnectSyncService.ts).

The independent three-case actual-service / real-paged-client / real-session-fence logger-boundary probe executed at audit commit `7e3c9a9360440ae64a15239bec17fcb3280817f4`, derived from exact H2 plus only a probe spec and lane files: **2 failed / 1 passed**. [Executed job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201/job/111356709877).

First failure: native Weight read rejects with the synthetic `AUDIT_360_PRIVATE_WEIGHT_81_6_KG` marker and the service forwards it verbatim in the logger's `error` field; second failure: sign-out's synchronous stop happens during the native page, the page then rejects, and identical sensitive text is logged after retirement despite no upload/progress. [Concrete failing assertions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201/job/111356709877).

The unchanged-session empty-read control passes; these are logger-boundary failures, not native-device validation, actual private data, infrastructure/type failure or production Sentry/analytics transport claims. [Control and scope of execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201/job/111356709877).

**Minimal repair:** check the stop/session fence first in the rejected-page catch, before logging or classifying, and replace `err.message` / `String(err)` with a closed allow-listed class/code while retaining recordType/resumed structural fields and failed-type retry/progress behavior. [Repair locus](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4a508d8bc01c2fa080fd120cbe02c7824ce06cdf/src%2Fservices%2Fhealth%2FhealthConnect%2FhealthConnectSyncService.ts).

**Verify:** reuse the saved failing-before spec; after repair all three cases must pass, plus non-Error rejection / cancelled-page / account-switch-page controls and existing pagination/resume/partial-read cases, followed by required exact-head CI and dual re-audit. [Available failing-before proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201/job/111356709877).

Probe spec saved at `ops/aud-116/AUD-SOL-W12-116/audit360.loggerPrivacy.test.ts`, direct job log at `probe-360-logger.log`, and public run summary/job-ID recovery at `probe-run-page.html`; candidate PR branch remains unchanged. [Audit-only execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201).

GitHub watch's jobs-list route returned a 403 rate limit; public run-summary recovery supplied job ID `111356709877` and the authenticated direct-job-log route succeeded, with no retry of the failed jobs-list endpoint. [Recovered direct job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201/job/111356709877).

## Size disposition and workspace

Verified H1 size +1276/-0 = 595 implementation + 262 fixture + 419 test lines, and H2 +1678/-969 = 1,243 source (760 added / 483 removed) + 1,404 test (918 added / 486 removed) lines; agree with H2's 19:26 KEEP assessment, and the small logger repair must not exceed the 3,000 cap. [H1 verdict/counts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/359#issuecomment-5976316854); [H2 assessment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5975773333); [H2 verdict/counts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976328100).

Only the temporary audit remote branch was pushed, and it has been deleted; candidate source, PR branches, production, builds, required checks and main were never changed.

All saved evidence retained; own clean worktrees remain at `wt/AUD-SOL-W12-116-359` (candidate read-only) and `wt/AUD-SOL-W12-116-360` (test-only audit commit), in accordance with this subagent's workspace-preservation instruction.

## Exact final state and next steps

- #359 `e0f3d2a75bf6e462a53e7c0ad4f18e388e72189d`: APPROVE 0/0/0; all three required checks green; no builder work for H1. [Final H1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/359#issuecomment-5976316854).
- #360 `4a508d8bc01c2fa080fd120cbe02c7824ce06cdf`: REQUEST CHANGES 0/1/0; required existing test job green, independent privacy probe red 2/3; assign a builder to repair B-360-1 in H2, restack upwards under the wear lock, then obtain fresh dual exact-head audits. [Final H2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976328100); [failing-before CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175348201/job/111356709877).
- Do not build/deploy/publish OTA from an intermediate piece; the stack lands as one with integrated required checks, followed by the approved ingest-flag and clinic binary/device acceptance sequence. [Operator land rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5975773333).

## HANDOFF
