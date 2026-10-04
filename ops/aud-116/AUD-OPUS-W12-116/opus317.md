-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5940512410
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ c7e35d847dae7cb08422d221ec0657b769192e7c — VERDICT: REQUEST CHANGES

Tier: T4 (health-data collection, local account and device authorization, persisted import correctness).

Range audited: merge-base `53447a36..c7e35d84`, two commits.
- `b28566c` is the prior audited `f63da34e` rebased onto main. `git diff f63da34e b28566c` touches only `package.json` and `package-lock.json` from main.
- `c7e35d8` is the fix round, read in full.

Read-only. Formed independently.

## Prior findings (Sol BLOCK at f63da34e)
- **A-317-1: CLOSED in code and tests.**
  - `refreshOnDevice` (src/services/health/onDeviceSync.ts:205-222) reads nothing unless three things hold:
    - a local authorization exists for the currently signed-in user id and source (onDeviceState.ts `auth:<source>:<userId>`);
    - its bound connection id is in the server list;
    - that connection is `connected`.
  - Only `connectOnDevice` writes that record, and it is called only from the Connect tap after the platform permission step (ConnectProviderSheet.tsx:144). These are the only two callers of either sync service.
  - Sign-out sweeps `ON_DEVICE_STATE_PREFIX` (authActions.ts:100). Account deletion calls `signOut()`. Disconnect retires the source (useWearableConnections.ts).
  - A session fence runs before every ingest request and before every progress save (sessionFence.ts; healthKitSyncService.ts:225-244; healthConnectSyncService.ts:217-223).
  - The declared residual (the check is not atomic with the send) is bounded server-side. Every sample carries the old account's connection id, and backend #623 returns 403 for a connection the JWT user does not own (wearable-samples.controller.ts:270-299, verified on #623).
  - Tests: onDeviceSync.test.ts:204 (remote row without local Connect), :214 (A's Connect never used for B), :264 (after sign-out), :140 (account changed during register).
- **B-317-1: CLOSED.** Progress is keyed by `progress:<source>:<userId>:<connectionId>`. The legacy SecureStore cursors are never read and are removed at sign-out (authActions.ts:37).
- **B-317-2: CLOSED.**
  - Health Connect stores a per-type resume token on a truncated read. A failed type keeps its progress, and a failed resume drops the token (healthConnectSyncService.ts:183-209).
  - HealthKit advances only the metrics that were read, and `complete` is reported up to the passes loop (MAX_IMPORT_PASSES = 3).
- **B-317-3: CLOSED.**
  - Sleep is grouped per session (2 h gap) with minute-level source overlap resolution.
  - Edge sessions are deferred. A 36 h look-back (healthKitClient.ts:226, 356-359) means a deferred night is read whole later, because the next window starts from saved progress, not from the open time.
- **B-317-4: CLOSED.** `getWeightSamples` gets `unit: 'kg'` (healthKitClient.ts:355). In the locked `react-native-health`, `hkUnitFromOptions` maps `"kg"` to `gramUnitWithMetricPrefix:Kilo` (RCTAppleHealthKit+Utils.m:279-280). The pound default sits at Methods_Body.m:47.
- **C-317-1 and C-317-2: CLOSED.**
  - Batches now use a UTF-8 byte counter (ingestBatching.ts:116).
  - The 30-day scope and coaching use are shown before Continue (ConnectProviderSheet.tsx:301-307). AI box 2 is not touched.

## New findings
- **B-317-5: after any sign-out, an on-device source on this phone stops syncing, and the app offers no way to resume except Disconnect.**
  - Evidence:
    - Sign-out sweeps every local authorization (authActions.ts:100). The server row stays `connected`.
    - On the next Health open, `refreshOnDevice` returns `not_authorized` (onDeviceSync.ts:216 or :220). The shell drops it silently, since only `imported` acts (WearablesShell.tsx:88-90).
    - The Connections row derives its action from the server status only. `connected` maps to `Disconnect` (ConnectionsScreen.tsx:80-84, 189-190), so the Connect sheet is unreachable while the row says Connected.
    - The same happens on a second phone of the same account, and after a reinstall.
    - This contradicts the new pre-Continue copy, "new data each time you open Health" (ConnectProviderSheet.tsx:305). The client and the coach see a connected source whose data quietly goes stale.
  - Minimal fix:
    - For the platform's on-device row, when the server says `connected` but `getLocalAuthorization(currentUser, source)` is null, show `Reconnect` with a one-line note, for example "Not syncing on this phone. Tap Reconnect to continue."
    - Route it to the existing sheet and `connectOnDevice`. The backend registration is an idempotent upsert.
    - Add tests:
      - a ConnectionsScreen test: connected row plus no local record gives the Reconnect action, and a tap runs `connectOnDevice`;
      - a test that zero native reads happen before the tap, which keeps A-317-1 intact.
- **C-317-3 (release ordering):** same as C-623-1. Do not flip `FEATURE_WEARABLES_INGEST_POST` until backend #608 (the account-deletion fan-out that covers wearable tables) is deployed. Keep `EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS` off until R2b, since `wearable_insight.*` has no box-2 check.
- **C-317-4 (pre-existing, optional):** Disconnect runs with no confirm and keeps the samples already stored on the server (backend disconnect only flips status). If a confirm is added later, say plainly that past data stays with the coach.

## Evidence
- Local at the exact head (heavy.sh, `--runInBand`, shared deps; package.json identical): `npx jest --runInBand --forceExit src/services/health src/screens/client/wearables/__tests__/ConnectProviderSheet.test.tsx src/screens/client/wearables/__tests__/WearablesShell.test.tsx src/screens/client/wearables/__tests__/ConnectionsScreen.test.tsx src/screens/client/wearables/__tests__/HealthFitnessScreen.rhr.test.tsx src/screens/client/wearables/__tests__/recoveryData.test.ts src/services/__tests__/authActions.test.ts` gave **24 suites, 327 tests passed**.
- The fixture `contracts/wearables-ingest-v1.fixture.json` hashes to sha256 `3c8701f9f9f592a188115bb6eea63b0417d38eba306d238465ac02de51579cfb`, equal to the backend #623 pin.
- Copy in the changed screens: no exclamation marks, no emojis.
- CI at c7e35d84: Typecheck, lint, test; Analyze (javascript-typescript); Analyze (actions); and CodeQL are all SUCCESS.
- No device run. The owner's iPhone and Android pass remains the proof for the native plugin and permissions.

-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5961091995
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ 58c2d53fa061071e193e5e3b5f981209425e9e0c — VERDICT: APPROVE

Lane AUD-OPUS-4 (agent 112), the second Opus lens. This is the T4 re-audit after my RC at c7e35d84 (5940512410) and AUD-SOL-5's BLOCK at c7e35d84 (5939974918). The range read was c7e35d84..58c2d53:
- merge 54916fa (main 2c17c241);
- fix round 4, 0b733fb (34 files);
- fix round 4b, 58c2d53 (7 files, read in full).

**A 0 · B 0 · C 2.**

### Merge seam (54916fa)
This merge had conflicts, so it is not tree-equal to `merge-tree`. I reviewed the resolution against the conflicted merge-tree (138be84). There were 8 files; the resolution keeps both sides and adds nothing else:
- **`authActions.ts`:** the sign-out sweep keeps `ON_DEVICE_STATE_PREFIX` (this PR) and `LEGACY_DRAFT_PREFIX` plus `purgeConsultationDraft` (#310).
- **`ConnectProviderSheet.tsx`:** keeps the on-device import flow and #323's `'disabled'` Health Connect case.
- **`healthConnectSyncService.ts`:** keeps #323's `assertAndroidHealthConnectEnabled` and this PR's scoped progress store. The removed `secureStorage` import was the legacy cursor store, which this PR retires.
- **`onDeviceConnect.ts`:** keeps #323's type-only `react-native-health-connect` import (lazy load for builds without Health Connect) plus this PR's permission builders.
- **`expected-env.json`:** adds `EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS` (default off), as #319's env-manifest guard requires.
- **Deleted:** the test for the hook this PR removed.
- **Build guard test:** updated to the new `syncHealthConnect(scope)` signature.

### Prior findings
- **A-317-1 r3 (Sol: account captured only after the permission dialog): CLOSED.**
  - `handleOnDeviceConnect` (`ConnectProviderSheet.tsx:244-275`) awaits `beginOnDeviceConnect()` before `connectOnDeviceProvider()`, i.e. before the native prompt.
  - `beginSessionFence` (`sessionFence.ts:118-125`) captures the auth generation synchronously, then reads the user, so an auth event during that read also yields null.
  - The fence is carried into `connectOnDevice` (`onDeviceSync.ts:234-258`). There `assertCurrent()` runs before register, again before `recordLocalAuthorization`, and before every read, request and progress save in the HK and HC services. The scope's `userId` comes from the fence.
  - The sheet cancels the fence on close, provider change and unmount (`:136-152`), and drops a stale continuation (`attemptRef.current !== fence`).
  - Sol's interleaving (A taps; B signs in while the prompt is up; the prompt resolves granted) now raises `session_changed` at the first `assertCurrent`, before any registration. `ConnectProviderSheet.accountSwitch.test.tsx` drives the real sheet, orchestrator, fence and storage with a deferred prompt, covering A→B, sign-out and same-account re-login. All three end with zero registrations, zero local grants and zero reads or posts, and there is a positive control.
  - The dormant `samsungHealthSyncService` uploader, which posted with no fence, is removed. The fenced HK and HC services are the only ingest posters left.
- **B-317-2 (Sol: an incomplete import closed as a success): CLOSED.**
  - `handleImportOutcome` (`:194-227`) closes only when `complete`.
  - A partial import keeps the sheet open with a truthful message and Continue import (`resumeOnDeviceImport`, the same fence, and a local grant required for the same connection). All reads failing gives Try again.
  - The refresh when Health opens surfaces partial and failed results.
  - Tests: `ConnectProviderSheet.test.tsx:196,247` and the WearablesShell partial-refresh case.
- **B-317-5 (mine: an on-device source silently stops syncing after sign-out): CLOSED.**
  - The Connections row shows "Not syncing here" with Reconnect when the server row is connected but this phone holds no local Connect for the person (`isConnectedButNotSyncingHere`), including a local Connect bound to an older connection. Health shows the same note.
  - The check reads app storage only and makes zero native reads before the tap.
  - Tests: `ConnectionsScreen.test.tsx:319,339`.
- **C-317-4 (mine: no confirm on Disconnect): CLOSED in 4b.**
  - `DisconnectConfirmDialog` names the source and what stops, says "Data already shared stays with your coach", and makes Cancel the first (default) action.
  - Failures get coded copy (offline, 401, 404 already, 403, 429, 5xx/unknown with a reference and support).
  - Tests: `ConnectionsScreen.test.tsx:212-227` and others.
- **Least privilege (4b): VERIFIED.**
  - `app.json` drops `READ_TOTAL_CALORIES_BURNED`, `READ_BASAL_BODY_TEMPERATURE` and `READ_HEALTH_DATA_IN_BACKGROUND`.
  - `healthPlatformConfig.test.ts` now asserts that the declared `android.permission.health.*` set equals the set derived from `HEALTH_CONNECT_RECORD_TYPES`. Runtime requests (`buildReadPermissions`) come from the same list.
- **Health Connect clinic-only: VERIFIED.** `eas.json` sets `TGP_ANDROID_HEALTH_CONNECT="1"` for clinic only. In preview and production `app.config.js` strips the Health Connect permissions and plugins.

### C findings (optional)
- **C-317-5: two Samsung-era permissions remain with nothing reading them.**
  - With Health Connect enabled (clinic), the manifest still declares `com.samsung.android.hardware.sensormanager.permission.READ_ADDITIONAL_HEALTH_DATA` (`app.config.js:5-38`, `app.json`) and `android.permission.ACTIVITY_RECOGNITION`.
  - After the uploader removal, no app code reads Samsung data or activity recognition. `src/services/health/samsungHealth/*` is imported only by its own tests.
  - Fix: drop both permissions and the unimported Samsung client before the Play health declaration, or justify them in it.
- **C-317-6: release ordering (carries C-317-3).**
  - FEATURE_WEARABLES_INGEST_POST stays off until backend #608 (the account-deletion fan-out over the wearable tables) is deployed.
  - `EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS` stays unset everywhere (no box-2 check).
  - A new clinic binary is required (native permissions and plugins; never OTA), followed by the owner's iPhone and Android device pass.
  - The Play Health Connect declaration must be filed before reviewed tracks.

### Residuals accepted as documented
- **Check-then-send:** the fence is checked before each request, but not atomically with the send. The server bounds this: every sample carries the starting account's connection id, and backend #623 returns 403 for a connection the JWT user does not own.
- **Session change during register:** this can leave an empty connected row for the new account (no grant, nothing read). That row shows "Not syncing here" plus Reconnect.

### Evidence
- **CI at this exact head:** Typecheck/lint/test, Analyze (javascript-typescript), Analyze (actions) and CodeQL all pass.
- **Local run (heavy.sh, `--runInBand`, at 58c2d53):** 7 suites / 119 tests passed (`ops/evidence/AUD-OPUS-4-112/317-targeted.log`). The suites:
  - `ConnectProviderSheet.accountSwitch`
  - `ConnectProviderSheet`
  - `ConnectionsScreen`
  - `WearablesShell`
  - `healthPlatformConfig`
  - `onDeviceSync`
  - `sessionFence`
- **Not run:** no device test and no prebuild.

I made no push, merge, dispatch or production action.

-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964176914
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ cf387e88d2a18e8dd047a831a18dc273d6136328 — VERDICT: APPROVE

T4 delta from my APPROVE at `58c2d53f` ([5961091995](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5961091995)). I also read Sol's REQUEST CHANGES at the same head ([5961170156](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5961170156)) and the PR body's "Fix round S-WEAR-3" table, which is the record for this round; there is no FIX ROUND comment. **A0 / B0 / C1.**

### Range and merge purity
The range `58c2d53f..cf387e88` is:
- merge `d9bf600` (main `f34b5b99`);
- fix `7744c20` (not named on the card; it carries most of the round);
- fixes `9203592` and `f2edbde`;
- merge `cf387e8` (main `aae30ac0`).

Both merges are pure:
- `git merge-tree --write-tree 58c2d53f f34b5b99` gives `41c7e36e`, which equals the `d9bf600` tree.
- `git merge-tree --write-tree f2edbde aae30ac0` gives `bb71f56f`, which equals the `cf387e88` tree.

The own-fix diff `d9bf600..f2edbde` (34 files, +1439/−1662) was read in full.

### My prior findings: still closed, no regression
- A-317-1, B-317-2 and B-317-5 are untouched by the delta apart from additive checks.
- C-317-4 (disconnect confirm): only copy changed (no "we"), and it is still coded.
- **C-317-5: CLOSED.**
  - `app.json` drops `ACTIVITY_RECOGNITION` and the Samsung sensor permission.
  - `app.config.js:11-14,38-61` filters and blocks both in every build, merging any existing `blockedPermissions`.
  - The unimported `samsungHealth/` client is deleted. `rg Pedometer|expo-sensors|ACTIVITY_RECOGNITION|samsungHealth` over runtime code finds no remaining user.
  - Test: `androidHealthConnectConfig.test.js` "S-WEAR-3 (Opus C-317-5)", covering `'1'`, `'0'`, unset and a legacy config.
- C-317-6 release ordering remains in the body.

### Closures of Sol's findings: checked for new defects (Sol rules on its own IDs)
- **B-317-6:**
  - The synchronous `epochRef` is bumped on Continue (`ConnectProviderSheet.tsx:404`, before any await), and on close/provider change (`:169`) and unmount (`:162`).
  - The on-device and cloud continuations both check `current()` after every await (`:194-205`, `:298-317`). A late fence is `cancel()`ed (`:310`).
  - A double tap simply supersedes the first attempt.
  - Tests: `accountSwitch.test.tsx` "B-317-6", with a deferred `readUserCache` for hide, unmount and provider change, plus a positive control that reaches the prompt and sync. The control proves the deferral harness is live, so the test is honest.
- **B-317-7:**
  - `stopOnDeviceHealthWork()` is the first statement of `signOut()` (`authActions.ts:302`, before any await).
  - `readRecordsPaged` checks `assertCurrent` and then `throwIfStopped` immediately before each native page, with no await between the check and `read(...)` (`healthConnectClient.ts:318-321`).
  - Every record type re-checks (`healthConnectSyncService.ts:200`). A page in flight at the stop is dropped (`:209`), and a stop is rethrown, never treated as a per-type failure (`:221`).
  - HealthKit checks before `requestAuth` and before and after `readSamples` (`healthKitSyncService.ts:204,214,216`).
  - The generation bump at sign-out start can only stop work, never start it. A sign-out that later fails just ends a running import, and the next open resumes from saved progress.
- **B-317-8:**
  - `cloudConnectFailureMessage` (`onDeviceCopy.ts:362`) reads status and machine code only:
    - network → internet + Continue;
    - 401 → Log in again, which really signs out (`ConnectProviderSheet.tsx:393-397`);
    - 403 → client accounts only;
    - 429 → wait;
    - 503 `wearables_cloud_disabled` → not switched on yet;
    - anything else → a short reference, the one support address (`SUPPORT_EMAIL` from #324) and `reportUnexpected` with `{status, code, requestId}` only (`:225-229`).
  - A sign-in window that will not open, and a `locked` auth session, each get their own copy.
- **Permission states:**
  - The sync no longer opens the Health Connect permission UI on its own (`healthConnectSyncService.ts:167-176`). Connect asks only on the tap.
  - When every type is revoked, the copy offers Open Health Connect.
  - `update_required` and `unavailable` are split, and nothing opens without a tap.
  - A HealthKit failure is no longer mislabeled as a refusal: "not available" maps to `unsupported`, and anything else maps to `error` with a reference and Sentry.
  - A first import with zero samples explains where to check, instead of closing silently (`ConnectProviderSheet.tsx:260-265`).
  - The Health notice buttons now do what their label says (`WearablesShell.tsx` `runNoticeAction`).
- **Copy:** no we/us/our (enforced by the `onDeviceCopy.test.ts` guard), no exclamation marks or emojis, and every failure names a working next step.
- **Privacy:** reports carry status, code and reference only. No health values or message text.

### Seams
- `git merge-tree` of this head with #305 `279dd8e3` is clean (`660dc215`). The `androidHealthConnectConfig.test.js` hunks of the two PRs do not overlap.
- #305's guard reads `TGP_ANDROID_HEALTH_CONNECT` from eas.json, so the clinic `"1"` set here is enforced correctly. Only #305's doc line is stale (see C-317-7).

### C-317-7 (optional; stale docs)
- **`src/services/health/onDeviceConnect.ts:108-116` (JSDoc of `connectHealthConnect`):** it still says the function opens the Health Connect settings entry point when Health Connect is missing. The code now returns `unavailable` or `update_required` and opens nothing on its own. Fix: update the comment.
- **`docs/OTA_UPDATES.md:120`, #305's file, after both merge:** it says the clinic value is `TGP_ANDROID_HEALTH_CONNECT=0`, which is stale once this PR sets clinic to `"1"`. Fix: whichever PR merges second updates the line, or drops the hard-coded value.

### Evidence
Required checks at `cf387e88`: Typecheck/lint/test, Analyze (javascript-typescript), Analyze (actions) and CodeQL are all SUCCESS. mergeStateStatus is CLEAN. The builder's "fails before" numbers (77 failed on `d9bf600`) are a claim; I verified the test structure and controls by reading, not by re-running.

The 8 device checks in the PR body stay operator gates, followed by release order OR-113-11.

No push, merge, dispatch, build or production action by this auditor.

-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964421857
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ cfa99ce3f8c2b9f6f2b7007ccc316b8956e97b05 — VERDICT: APPROVE

T4 delta from my APPROVE at `cf387e88` ([5964176914](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964176914)). I read Sol's RC at that head ([5964162719](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964162719)), FIX ROUND 4 ([5964393578](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964393578)) and Sol's APPROVE at this head. **A0 / B0 / C0.**

### Range and merge purity
The delta is `175537b` (fix) plus `cfa99ce3` (merge of main `1f8981dd`, #314). `git merge-tree --write-tree 175537b 1f8981dd` gives `88ab70ec`, which equals the head tree, so the merge is pure and app.json keeps main's expo-audio plugin. The own diff covers 8 files and was read in full.

### C-317-7 (mine)
**Closed for this PR.** The `connectHealthConnect` JSDoc is corrected (`onDeviceConnect.ts:126-134`). The `docs/OTA_UPDATES.md` clinic line stays with whichever of #305 and #317 merges second.

### B-317-9 and B-317-10 (Sol's IDs): checked for new defects
- **Native setup (B-317-9):**
  - `connectOnDeviceProvider(provider, isCurrent)` returns `stopped` at each checkpoint: before HealthKit auth (`:112`), before and after `getSdkStatus` (`:146,148`), and synchronously after `initialize`, with no await before `requestPermission` (`:160`).
  - A setup throw after the attempt ended maps to `stopped`, not `error` (`:194`), so no reference or Sentry report is produced for a user's own close.
  - The sheet's `live()` (`ConnectProviderSheet.tsx:345-354`) is the same fence, plus mount and epoch, plus `throwIfStopped`.
  - On `stopped`, a closed or replaced sheet shows nothing. A still-open sheet whose session moved shows the session-changed copy (`:356-364`).
  - The default `ALWAYS_CURRENT` keeps the existing callers unchanged.
- **Cloud browser (B-317-10):**
  - The auth generation is captured at the tap, before the first await. `current()` now means mounted, plus same epoch, plus same generation.
  - After the browser returns, a stale result does nothing visible (`:218-225`): no tutorial signal, no `onConnected`, no `onClose`. Only the connection list is re-read, and only in the same session.
  - The generation moves only on auth-screen and onboarding `authEvents.emit` and at sign-out start. No authenticated-app path bumps it, so a legitimate OAuth return is never dropped.
- **Tests:** `ConnectProviderSheet.attemptFence.test.tsx` runs the real sheet, helper, orchestrator and fence; only the Health Connect native module, browser, API and cache are doubled.
  - It holds `getSdkStatus` or `initialize` across hide, unmount, provider change and sign-out (`stopOnDeviceHealthWork`, as `signOut` does first), plus a logout event.
  - It holds the browser result (`success` or `dismiss`) across the same cases, plus a newer Continue.
  - Each group has a live control. The two existing tests that changed only gained the `expect.any(Function)` argument.

### Seams
`git merge-tree` of this head with #305 `4ac5980e` (`4518963a`) and with #326 `edcd05cf` (`2852cf9c`) is clean.

### Evidence
Required checks at `cfa99ce3` (Typecheck/lint/test, Analyze ×2, CodeQL) are SUCCESS.

C-317-6 release order and the 8 device checks remain operator gates. No push, merge, dispatch, build or production action by this auditor.

-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5971856663
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ 7174daa88a67c6d8028b2c741fd4d1d76d5b3c8b — VERDICT: APPROVE

T4 delta from my APPROVE at `cfa99ce3` ([5964421857](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964421857)). I read the builder self-finding B-317-11 ([5964440190](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964440190)) and FIX ROUND 5 ([5971833355](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5971833355)). **A0 / B0 / C0.**

### Range
The first-parent history has three commits:
- **`737a95a`, a merge of main `4f1d74d8`.** It is pure: `git merge-tree --write-tree cfa99ce3 4f1d74d8` gives `9119a12c`, which equals the merge's tree.
- **`4e72bf0`, tests only.**
- **`7174daa`, the fix.** It touches `ConnectProviderSheet.tsx` (+90/−14 incl. comments) and `WearablesShell.tsx` (+26/−2).

The own delta covers 5 files and was read in full. There is no package, lock, app.json or eas.json change.

### B-317-11: CLOSED (code + failing-before test)
- **The attempt check.** `isCurrentAttempt(epoch, fence)` (`ConnectProviderSheet.tsx:190-196`) is true only while the sheet is mounted, `epochRef` is unchanged and `attemptRef` still holds the attempt's fence. The epoch moves on unmount (`:163-169`), on `[visible, provider]` (`:172-183`) and on a new Continue (`:508`).
- **`runImport` (`:309-360`) now takes `epoch` and `fence`,** and captures the auth generation before its first await. After `run()` settles:
  - **Stale (closed, replaced or unmounted):** no `handleImportOutcome`, tutorial signal, `onConnected`, close, message or `connectFailureMessage`, so no Sentry report. Only `invalidate()` runs, and only in the same session.
  - **Still this sheet but the session moved:** success is silent. Failure shows the session-changed copy through `connectFailureMessage(new OnDeviceSessionChangedError())`. The default reason `session_changed` (`sessionFence.ts:25`) maps to specific copy with Continue (`onDeviceCopy.ts:113-121`), not to the reporting fallback.
  - **`finally`** clears `importing` only for the current attempt.
- **Callers.** `handleImportOutcome` has one caller, `:338`, after the fence. `handleResume` (`:456-483`) captures the epoch synchronously and passes the attempt's fence.
- **Busy state.**
  - `[visible, provider]` resets `requestingOnDevice`, and the `finally` blocks clear it only for their own epoch or attempt.
  - `continuing` (`:548`) no longer reads the shared `startOauth.isPending`. `handleContinue` sets `requestingOnDevice` before branching, so cloud and on-device attempts both stay single-flight on their own sheet.
- **Tests.** `ConnectProviderSheet.importEpoch.test.tsx` uses the real sheet, `onDeviceSync`, fence and storage; only the native module, browser, API and Sentry are doubled. It covers:
  - close and reopen, and provider change, × import success and failure, with no visible effect, no report and exactly one same-session re-read;
  - the next sheet's Continue is not busy;
  - unmount × 2 and sign-out × 2 (session-changed copy, no re-read for the next person, no report);
  - held resume × 2;
  - controls showing that an unchanged attempt still connects, messages and reports once.

### C-317-a/b/c/d (builder): CLOSED
- **a.** `WearablesShell.tsx:112-153` checks the mount, the latest run and the auth generation before any notice or invalidate.
- **b.** The refresh-failure log carries `{ error: err.name | typeof }` only, with no message or body.
- **c.** `handleOpenExternal` (`:441-452`) rechecks the mount and epoch after the await.
- **d.** The test is renamed.

Each item is covered in `WearablesShell.test.tsx` / importEpoch. C-317-7 / OR-115-5 is resolved in #305 `d7f41e5`, so the docs line is right in either merge order.

### Evidence
- **Failing before.** The tests alone at `4e72bf02`, [run 37141124980](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37141124980) (workflow_dispatch), conclude `failure`: 2 suites / 17 tests failed, 6191 passed.
- **At this head.** [Run 37141169059](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37141169059) (head_sha 7174daa8, pull_request) concludes `success`.
- **Required checks** at `7174daa8` are all success: Typecheck, lint, test; Analyze (javascript-typescript); Analyze (actions); CodeQL.

### Integration
- The head is BEHIND main `47124a4d` (#326 merged). `git merge-tree` with main is clean (`22c50c7d`), so the operator's update-branch is mechanical and needs a merge-only delta.
- The merge with #305 `d7f41e5b` is clean (`5aaa8fa8`).
- Outside this diff: `ConnectionsScreen` "We couldn't load your connections" belongs to the OR-115-4 copy PR #339.

C-317-6 release order and the 8 device checks remain operator gates. No push, merge, dispatch, build or production action by this auditor.

-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972118238
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ 82137c312e957cb05eedeaebf86fcd95029f2bde — VERDICT: APPROVE

T4 delta audit from my APPROVE at `7174daa8` ([5971856663](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5971856663)). Answers FIX ROUND 6 ([5972003820](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972003820)). **A0 / B0 / C0.**

### Range
- **`ea06106`:** merge of main `47124a4d`. It is pure: merge-tree `22c50c7d` equals the commit tree.
- **`cdd4446`:** tests.
- **`82137c3`:** the fix. Code changes only `src/screens/client/wearables/WearablesShell.tsx`.

### The delta (C-317-b r2)
The refresh failure is now logged as a closed class: `refreshErrorClass` returns `'aborted' | 'network' | 'http' | 'type' | 'error' | 'other'`.
- **No error text is copied.** `Error.name` is compared only against fixed constants, and the class comes from `isAxiosError` / `response` / `TypeError`. None of the error's message, body, value or name is copied into the log.
- **A stale failure is silent.** The `logger.warn` moved below `if (!current()) return;`, so a failure from a signed-out, unmounted or superseded run logs nothing.
- **Unchanged behaviour.** User copy (`connectFailureMessage`) and the notice path are unchanged.

### Tests
- A closed class only.
- An arbitrary `Error.name` carrying a name and a number never reaches the log.
- A non-Error rejection is logged as `other`.
- A stale failure is silent.

Proof: the [before run 37142129659](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37142129659) (`ci/B-MOB-B-317-before` at `a97c6dd9`, this head minus the fix) concluded `failure`.

### Evidence
Head checks are all success: Typecheck, lint, test; Analyze (javascript-typescript); Analyze (actions); CodeQL.

No push to the PR branch, merge, dispatch or production action by this auditor.

-----
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972163241
AUDIT Claude Opus 5.5 — growth-project-mobile#317 @ d0407b625e1d2bc63ebe9d063296bc85461842ed — VERDICT: APPROVE

Merge-only delta from my APPROVE at `82137c31` ([5972118238](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972118238)). **A0 / B0 / C0.**

- **One merge, nothing else.** The only first-parent commit is `d0407b6`, which merges main `367e6c4` (#305 merged). The second parent is on `origin/main`.
- **The merge is pure.** `git merge-tree --write-tree 82137c3 367e6c4` gives `ec754f15`, which equals the head tree. There is no conflict hunk and no PR-side change.
- **CI is still running.** At posting time: CodeQL and both Analyze checks are success; "Typecheck, lint, test" is in progress. The merge gate requires it green.

No push to the PR branch, merge, dispatch or production action by this auditor.

