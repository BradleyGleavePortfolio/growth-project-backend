AUDIT Claude Opus 5.5 — growth-project-mobile#360 @ fde1875edc1bd5d14ac8fda4f2e68ee8b7c5ebf5 — VERDICT: APPROVE

A/B/C = 0/0/3

C-360-1 and C-360-2 are carried from this lens's verdict at `4a508d8b` and stay open as the ruled follow-up. C-360-3 is new. None of them blocks this PR.

Job AUD-OPUS-H23-118 (agent 118 wave). Tier T4: health data, by the max-tier rule. I made no push, merge, dispatch, build or production action.

### Prior findings
- **This lens at `4a508d8b`** ([5976279445](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976279445)): APPROVE 0/0/2.
  - C-360-1 (late samples older than the re-read overlap) and C-360-2 (an import pass is all-or-nothing) are not changed by this round.
  - Both stay open as the ruled follow-up before the clinic Android build (JOBS118). They are not blockers here.
  - Lens-report item 5 asked for a closed error class in the Health Connect read catch. It is closed by this round; see below.
- **Sol B-360-1** ([5976328100](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976328100)): Sol rules on its own ID. I checked the closure for new defects and found none.

### Evidence reuse (G09)
- **Base:** #359 `e0f3d2a7` is unchanged.
- **Range since my APPROVE:** `4a508d8b..fde1875` is a fast-forward of two commits: `d605452` (tests) and `fde1875` (fix). It touches 4 files, +169/−2.
- **What rests on prior evidence:** the other 20 files of the piece are byte-identical to `4a508d8b`, which this lens approved on the #317 T4 chain.
- **What was re-checked anyway:** the whole piece was re-read for logging, permission truth, data minimization and the session fence, because this job names those areas.
- **What was audited line by line:** the 4-file delta.

### Delta audit (`healthConnectSyncService.ts`, `onDeviceConnect.ts` and their two suites)
- **Rejected-page catch (`healthConnectSyncService.ts:259-277`).**
  - `fence.throwIfStopped()` is the first statement. It is synchronous, so no await sits between the rejection handler and the check.
  - Sign-out start, an auth event (A to B) or `cancel()` therefore ends the run with `OnDeviceSessionChangedError` (`sessionFence.ts:99-102`). Nothing is classified, recorded, logged, sent or saved.
  - A stop thrown by `assertCurrent` without a generation bump (the user cache moved) still reaches `isOnDeviceStop` and is rethrown.
  - The per-type degrade path is unchanged: the failed type keeps its progress, and a failed resume drops its token.
- **The logged error is a closed class (`:96-103`).**
  - It comes from a `Map` of the 8 read-path codes. I checked them against `react-native-health-connect` 3.5.3 `ExceptionsUtils.kt`, which rejects with `reject(code, message, exception)`.
  - The code is only compared, never copied. Unmapped codes give `unknown`: the write-only `INVALID_*` codes, `UNKNOWN_ERROR`, `__proto__` and `constructor` (a Map lookup, not an object index).
  - Non-objects, non-string codes and a throwing getter also give `unknown`. The classifier cannot throw.
  - The log carries `{ recordType, resumed, error: <class> }` only.
- **Grant read (`:213-216`).** A fence check now runs before the all-denied warn or throw. The warn itself only ever carried `requested: 15`.
- **HealthKit permission catch (`onDeviceConnect.ts:116-118`).** It returns `stopped` when the attempt ended. The message is still only regex-tested (`:123-124`), never copied.
  - On this tree, main's sheet calls `connectOnDeviceProvider(target)` with the default `ALWAYS_CURRENT` (`ConnectProviderSheet.tsx:138`), so behaviour here is unchanged.
- **Tests (`healthConnectSyncService.test.ts:439-545`, `onDeviceConnect.test.ts:250-258`).**
  - They use the real paged client, the real fence and real auth events.
  - Six rejection shapes are covered. Each asserts the exact class, that the next type is still read, and that the canary is absent from every logger call.
  - Three cases stop the run while a page is in flight: sign-out start, an account switch and a cancelled Connect. Each asserts one native call, no ingest, empty progress and no `logger.error`.
  - There is a grant-read-after-stop case, a live control and a classifier table.
  - Failing-before: [run 37175837840](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175837840) failed 12 tests, all of them B-360-1 cases. After: [run 37175851194](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175851194), 53 tests passed.

### Health-data checks (whole piece)
- **Logs and telemetry.**
  - Every logger call in the piece carries only counts, record-type names, booleans or the closed class (`healthConnectSyncService.ts:218,273,293`).
  - The HealthKit services have no logger call.
  - The piece has no Sentry, PostHog or breadcrumb call.
  - `onDeviceConnect.ts:123` reads a message only for a regex test.
- **Minimization.**
  - The wire is the #359 allow-list `toIngestWire`: connection id, provider, metric, bucket, value, unit, bounds, `sourceTz`, `sourceRecordId`.
  - `sourceRecordId` is the Health Connect `metadata.id` (`healthConnectNormalizer.ts:139-143`) or the HealthKit UUID.
  - No source or device name, `rawRef` or `userId` is sent.
- **Permission truth.**
  - Health Connect asks for `buildReadPermissions()`, the same 15 `HEALTH_CONNECT_RECORD_TYPES` the sync reads. The sync only reads granted types and never prompts (`:209-213`).
  - HealthKit asks for the 15 `HEALTHKIT_READ_PERMISSIONS` with `write: []` (`healthKitClient.ts:273-289,312`). Those are the same types `readSamples` queries.
- **Fence.**
  - The fence is type-required, and `fence.userId` must equal `scope.userId` (`healthConnectSyncService.ts:200`; `healthKitSyncService.ts:197`).
  - A synchronous stop check runs before every native call and page.
  - `assertCurrent` runs before every request and before every progress save.

### Piece boundary
- **Reachability.** The only app-reachable changed code is still `connectOnDeviceProvider` from main's sheet. The sync services, ingest and fence are reached only from tests.
- **Rule 11.** Land as one remains mandatory: no build or OTA from an intermediate tree. The reason is in my `4a508d8b` verdict: the old sheet has no `error` case.
- **Main.** Main has moved to `7fdb629a` (#315 trust-center/sentry). `git merge-tree` of the stack with main is clean, and no stack file overlaps main's changes since `367e6c48`.

### CI and size
- **CI.** Typecheck, lint, test is SUCCESS at this exact head ([run 37179701360](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179701360/job/111369586215)): tsc, eslint, and jest with 449 suites / 6,355 tests. The 3 changed suites pass in the log.
  - Analyze (javascript-typescript) and Analyze (actions) run only on PRs based on main (`codeql.yml`). They run when #359 lands the stack.
- **Size.** 24 files, +1,844/−968 = 2,812 lines, under 3,000. I agree with KEEP. This round added 171 lines, all on the logged seam.

### C-360-3 (new, optional): post-await attempt and fence checks are not uniform
- **Where:**
  - `onDeviceConnect.ts:114-115` and `:163-164`: `granted` / `denied` are returned after the native await without `isCurrent()`. The catch at `:118` now returns `stopped`.
  - `healthConnectSyncService.ts:206,213`: a rejection of `initialize()` or `getGrantedPermissions()` that lands after a stop propagates as an ordinary error, not as a stop.
- **Counterexample:**
  1. The HealthKit sheet is up and the attempt ends (close or sign-out start).
  2. The person taps Allow.
  3. The helper returns `granted` for an ended attempt.
  - Nothing is written or logged here. The #362 sheet drops stale outcomes (`isCurrentAttempt`), and the shell logs only a closed class. So this is consistency, not a leak.
- **Fix rule:**
  - After both awaits in `onDeviceConnect.ts`, add `if (!isCurrent()) return 'stopped'`.
  - In the sync service, wrap the two setup awaits so that a rejection runs `fence.throwIfStopped()` before rethrowing.
- **Verify:** stop during each await gives `stopped` / `OnDeviceSessionChangedError`, with live controls. This fits the C-360-1/2 follow-up PR.

### Landing
Land as one with #359 and #361 to #364 (rule 11), then the backend `FEATURE_WEARABLES_INGEST_POST` flip, in the C-317-6 order: #608 deployed, AI flag unset, new clinic binary, device pass.
