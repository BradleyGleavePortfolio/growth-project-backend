AUDIT Claude Opus 5.5 — growth-project-mobile#360 @ 4a508d8bc01c2fa080fd120cbe02c7824ce06cdf — VERDICT: APPROVE

A/B/C = 0/0/2

Job AUD-OPUS-W12-116 (operator 116 wave). Tier T4 (health data; max-tier rule). This is split piece H2 of #317 @ `d0407b62`. Read-only: no push, merge, dispatch, build or production action.

### Prior findings
- **This lens on #317:** all findings are closed. The approval chain and the C-317-6 operator gate are as in the #359 verdict.
- **Sol on #317:** B-317-12 is in #364's file, so it does not apply here.
- No finding is open on #360.

### Byte-identity to #317, and evidence reuse (G09)
- **Base:** #359 head `e0f3d2a7`. The piece has one commit, `4a508d8`.
- **24 files, +1678/−969:**
  - 20 modified files: the blob at 4a508d8 equals the blob at d0407b62.
  - 4 deleted files are absent at d0407b62 too: `src/hooks/useHealthKitSync.ts`, `src/hooks/useHealthConnectSync.ts` and their two suites.
- **Base content:** #359 touches none of the 24 files, so their base is main's. The piece diff therefore equals #317's diff for these files, byte for byte. There are no split edits.
- **Reuse decision:** the piece rests on this lens's T4 chain on #317. No line changed after the last APPROVE, and the piece contains no code this lens never approved. The whole diff was re-read for the boundary and privacy checks below.

### Piece boundary
- **One reachable seam.** At this head the only app-reachable changed code is the call to `connectOnDeviceProvider(target)` (default `ALWAYS_CURRENT`) from main's `ConnectProviderSheet.tsx:138`.
  - The sync services, ingest API, progress store and fence are reached only from tests (`git grep` of non-test importers).
- **Deleted hooks.** They had no app importer on main, only their own suites, which are deleted with them (449 suites = 451 − 2).
- **Lazy native load is kept.**
  - `onDeviceConnect` now imports `healthConnectClient` for `buildReadPermissions`.
  - That module requires `react-native-health-connect` only inside `loadHealthConnectLib` (`healthConnectClient.ts:78-83`), behind `assertSupported`.
  - The build-guard suite still asserts that an OFF build performs no native evaluation and no post.
- **Behaviour if this tree shipped alone (not a finding):**
  - **Android:** main's config keeps Health Connect off in every profile, so the call returns `'disabled'` before any changed code runs.
  - **iOS:** the old sheet's `switch (outcome)` (`:140`) has no case for `'error'`, `'update_required'` or `'stopped'`. A HealthKit permission-screen failure would therefore be silent if this tree alone were built or OTA-published. H4 (#362) brings the updated sheet.
  - **Consequence:** rule 11 "land as one" is mandatory for this stack. No build or OTA may come from main between pieces.
- **Samsung guard case.** The Samsung case of `healthConnectBuildGuard.test.ts` is removed here, while `samsungHealth/*` stays until #364.
  - `samsungHealth` has no app importer: only its own suites and the unimported `useSamsungHealthSync` hook use it.
  - Its client still calls `assertAndroidHealthConnectEnabled`.
  - The coverage gap is on unreachable code that #364 deletes.
- **CI:**
  - Typecheck, lint, test is green ([run 37156241700](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37156241700/job/111300091368)): tsc, eslint, and jest with 449 suites / 6,342 tests.
  - Analyze and CodeQL do not run on this PR (`codeql.yml` `pull_request: branches: [main]`). The same bytes passed Analyze (javascript-typescript), Analyze (actions) and CodeQL at #317 d0407b62 ([run 37143998466](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37143998466)), and they run again when #359 carries the landed tree into main.

### Health-data privacy
- **Logs:** `healthConnectSyncService.ts:177,228,248` log counts, record-type names and a native error message.
  - `logger` writes to the console in `__DEV__` builds only (`src/utils/logger.ts`).
  - Sentry drops console breadcrumbs and request bodies (`sentryPrivacy`).
  - The piece has no health values in logs, and no PostHog or Sentry call.
- **Fence:**
  - It is type-required in both services (`HealthKitSyncOptions.fence` at `:128`, `HealthConnectSyncDeps.fence` at `:78`), and `fence.userId` must equal `scope.userId` (`:197`, `:162`).
  - `assertCurrent` runs before the reads, before every request and before the progress save.
  - `throwIfStopped` runs before every native call and every Health Connect page.
  - A stop ends the whole run and is never counted as a per-type failure.
- **No `userId` in the body:** it is removed from both normalizers and from `NormalizedSample`, and the wire format is the allow-listed `toIngestWire`.

### SIZE ASSESSMENT (operator, 19:26): agree with KEEP
- **Counts verified:** 2,647 = source 1,243 + tests 1,404, over 24 files.
  - Non-test source is +760/−483, so additions are under the ~800 target.
  - 125 of the deleted lines are the two dead hooks.
- **KEEP fits 8.2's own criterion:** the audits converged. The content is byte-identical to the dual-reviewed #317, whose only open finding was a test pin carried by #364.
- **Further cut:** a HealthKit / Health Connect cut is possible (`onDeviceConnect` and the build guard tie the two). It would add a restack to four pieces for no gain in auditability.
- **Nit:** the "Seams" line lists directories rather than logical seams. Later assessments should name each candidate cut and say why it was rejected.

### C-360-1: late-arriving samples older than the re-read overlap are never read
- **Where:**
  - `healthConnectSyncService.ts:65,114-119`: a 5-minute overlap per record type.
  - `healthKitSyncService.ts:82,166-174`: a 60-minute overlap.
  - Workouts use the same window (`healthKitClient.ts:390`). Only sleep gets the 36 h look-back (`:226,359`).
- **Counterexample, Health Connect:**
  1. TGP opens at 07:15, so the SleepSession progress is 07:15.
  2. A watch app writes the 23:00–07:00 session to Health Connect at 07:30.
  3. The next open, at 12:00, reads [07:10, 12:00]. The night lies wholly before that range and is never read.
  - The same happens to steps and heart rate that Samsung Health, Fitbit, Garmin or Oura write to Health Connect in batches.
- **Counterexample, HealthKit:** a watch workout from 09:00 to 10:00 reaches the phone at 13:00, after a 12:00 open. The next open reads from 11:00, so the workout is skipped.
- **Cumulative buckets:** an hourly steps or active-energy bucket posted before a late contribution arrives keeps its first value, because the backend keeps the first copy of a dedup key. Widening the overlap alone does not fix these.
- **Fix rule:**
  - Widen the per-type re-read to a look-back, for example 36 h as for HealthKit sleep. Re-posts are deduplicated by `sourceRecordId` and stable bounds.
  - Or use Health Connect's changes token.
  - Post cumulative buckets only after a settle delay (for example, end at or before now − 2 h), or have the backend replace cumulative buckets on the same dedup key.
  - **Test:** progress at T; a record that ends before T − overlap and is written after T is read on the next run.
- **Recommendation:** a follow-up PR after the stack lands, before the clinic Android build, and a late-write case in the device pass.

### C-360-2: an import pass is all-or-nothing
- **Where:** `healthKitSyncService.ts:215,242,261` reads the whole window, posts every batch, and saves progress only at the end. `healthConnectSyncService.ts:240-245` does the same; its reads are bounded at `MAX_READ_PAGES` = 20 per type.
- **Counterexample:**
  - An Apple Watch wearer with about 25,000 samples over 30 days needs about 100 requests at 250 samples each.
  - The backend allows 60 requests a minute (`WEARABLES_INGEST_PER_MIN`), so the pass takes 2–3 minutes including Retry-After waits.
  - Backgrounding the app, or one non-429 failure, in that time discards the pass. The next open starts the 30 days again.
  - Dedup keeps the data correct, but the import may never finish for someone who does not stay on the screen.
- **Fix rule:** read HealthKit oldest-first in day-sized windows, and save progress per window once its batches land, with the same fence checks.
- **Test:** a failure on batch k keeps the progress of the windows before k.

Both C findings are design improvements. Neither makes this piece unsafe.

### Landing
Land as one with #359 and #361 to #364 (rule 11), then the backend flag flip `FEATURE_WEARABLES_INGEST_POST`.
