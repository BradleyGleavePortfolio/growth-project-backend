# AUD-OPUS-W12-116: Claude Opus 5.5 lens on mobile #359 and #360 (Health Connect split W1 and W2 of #317)

- **Agent:** operator 116 wave, lens Claude Opus 5.5.
- **Window:** started 2026-10-03 20:32 PDT; verdicts posted 20:47 PDT (times from `date`).
- **Claims:**
  - `ops/lanes116/claims/mobile-359-e0f3d2a7-opus`
  - `ops/lanes116/claims/mobile-360-4a508d8b-opus`
- **Notes and evidence:** `ops/aud-116/AUD-OPUS-W12-116/`
  - `verdict-359.md` and `verdict-360.md`: the posted bodies.
  - `opus317.md`, `sol317.md`, `fix317.md`: #317 verdict and fix history.
  - `run359.log`, `run360.log`: CI logs.
- **Footprint:** no worktree, no probe branch, no CI dispatch (lens rule: no heavy local work). No push, merge or production action. Disk 74 percent at start.

## mobile #359 @ e0f3d2a75bf6e462a53e7c0ad4f18e388e72189d: APPROVE, A/B/C = 0/0/0

- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/359#issuecomment-5976279359
- **Base:** main `367e6c48`, which #317 at d0407b62 already contains. One commit; 8 files; +1276/−0.
- **Byte-identity:** all 8 blobs equal #317 @ d0407b62. There are no split edits.
- **Evidence reuse (G09):** rests on this lens's T4 chain on #317:
  - RC at c7e35d84 (5940512410);
  - APPROVE at 58c2d53f, cf387e88, cfa99ce3, 7174daa8 and 82137c31;
  - merge-only APPROVE at d0407b62 (5972163241).
  - Nothing in the piece changed after the last APPROVE, and nothing in it is unapproved.
- **Boundary:**
  - Inert: no app importer of `onDeviceState`, `sessionFence` or `ingestBatching`, and `registerOnDevice` has no caller.
  - No config, package or migration change.
- **Fixture:** sha256 matches the backend pin.
- **CI at this head (all green):**
  - Typecheck, lint, test: run 37156242441 (451 suites / 6,310 tests).
  - Analyze (javascript-typescript) and Analyze (actions): run 37156242445.
  - CodeQL.
- **Privacy:** the piece has no log or analytics calls. The on-device records contain no health values.

## mobile #360 @ 4a508d8bc01c2fa080fd120cbe02c7824ce06cdf: APPROVE, A/B/C = 0/0/2

- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5976279445
- **Base:** #359 head. One commit; 24 files; +1678/−969.
- **Byte-identity:**
  - 20 modified blobs equal d0407b62.
  - 4 deleted files (the legacy useHealthKitSync and useHealthConnectSync hooks and their tests) are absent at d0407b62 too.
  - Evidence reuse is the same as for #359.
- **Boundary:**
  - The only reachable changed seam is main's `ConnectProviderSheet.tsx:138` calling `connectOnDeviceProvider`.
  - **Android:** returns `'disabled'` in every profile at this tree.
  - **iOS:** the old sheet's switch has no case for `'error'`, `'update_required'` or `'stopped'`, so a HealthKit permission-screen failure would be silent if this tree were built or OTA-published alone.
  - **Not a finding,** but it makes rule 11 "land as one" mandatory for this stack: no build or OTA from main between pieces.
  - The lazy Health Connect require is kept.
  - The Samsung guard test case is removed while `samsungHealth/*` stays until #364. That code is unreachable (no app importer) and still guarded at runtime.
- **CI:**
  - Typecheck, lint, test is green: run 37156241700 (449 suites / 6,342 tests).
  - Analyze and CodeQL do not run (`codeql.yml` triggers only on PRs to main). The same bytes passed both at #317 d0407b62 (run 37143998466), and they run again when #359 lands the whole tree into main.
- **Privacy:**
  - Logs carry counts, record-type names and a native error message, through a logger that only writes to the console in `__DEV__` builds. Sentry drops console breadcrumbs and bodies.
  - The fence is type-required, and its user must equal the scope user.
  - The request body carries no `userId`.
- **SIZE ASSESSMENT (19:26): agree with KEEP.**
  - Counts verified: source 1,243 / tests 1,404. Non-test source is +760/−483.
  - The audits converged on #317.
  - Nit: the "Seams" line lists directories, not candidate cuts.
- **C-360-1:** late-arriving samples older than the re-read overlap are never read.
  - Where: Health Connect overlap 5 min (`healthConnectSyncService.ts:65,114-119`); HealthKit 60 min (`healthKitSyncService.ts:82,166-174`). Only HealthKit sleep has the 36 h look-back.
  - Hourly cumulative buckets also keep their first posted value (backend first-write-wins).
  - Fix: a wider look-back or the Health Connect changes token, plus a settle delay for cumulative buckets (or a backend replace).
- **C-360-2:** an import pass is all-or-nothing (progress is saved only after every batch).
  - A heavy Apple Watch history needs about 100 requests at 60 per minute; an interruption restarts all 30 days.
  - Fix: day-sized HealthKit windows with progress saved per window.

## Operator items (not blocking these PRs)
1. **C-360-1 is a day-1 data-completeness item for "Health Connect on and running day 1".**
   - Recommended default: one small T4 follow-up PR on main after #359 to #364 land, before the clinic Android build. It would widen the look-back (ingest dedup makes re-reads safe) and add a settle delay for cumulative buckets.
   - Add a late-write case to the device pass: write a sleep session or workout to Health Connect or Apple Health after an app open, then reopen.
   - Folding it into #360 instead would cost a restack of #361 to #364 and fresh audits of five pieces.
2. **C-360-2:** same follow-up PR, or a later one. It is lower priority than C-360-1.
3. **C-317-6 release order** (this lens, from #317) still applies to the flag flip, B-FLAG:
   - Backend #608, the deletion fan-out over the wearable tables, merged 2026-10-03 02:38Z. Confirm it is in the deployed backend before setting `FEATURE_WEARABLES_INGEST_POST` to true.
   - Keep `EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS` unset.
   - Ship a new clinic binary (never OTA), file the Play Health Connect declaration, then run the device pass.
4. **Stack landing:** land as one (rule 11). Never build or OTA-publish from main while only some pieces have merged (see the #360 boundary note).
5. **Optional, outside the strict rules:** `healthConnectSyncService.ts:228-232` copies `err.message` into a dev-only log. A closed error class, like WearablesShell's `refreshErrorClass` (C-317-b r2), would keep it safe if the logger ever forwards to Sentry. No action needed now.

## HANDOFF
- **mobile #359** @ `e0f3d2a75bf6e462a53e7c0ad4f18e388e72189d`: Opus APPROVE 0/0/0 (comment 5976279359). All required checks are green.
  - Next: Sol verdict at this head (AUD-SOL-W12), then land as one with #360 to #364.
- **mobile #360** @ `4a508d8bc01c2fa080fd120cbe02c7824ce06cdf`: Opus APPROVE 0/0/2 (comment 5976279445). Typecheck, lint, test is green; Analyze runs only when the stack lands on main.
  - Next: Sol verdict at this head; operator decision on C-360-1 (default: follow-up PR before the clinic build).
- If either head moves (a fix round or restack), a fresh Opus lens runs a delta check from these heads using this report.
- **Cleanup:** none needed (no worktree, no audit or ci branch created). The claims stay as records.
