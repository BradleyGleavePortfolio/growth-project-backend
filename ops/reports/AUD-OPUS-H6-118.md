# AUD-OPUS-H6-118 — Claude Opus 5.5 lens, mobile #364 (Health Connect H6, top of HC stack)

Operator: agent 118. Started 10:18 PDT 10-04, verdict posted 10:36 PDT (times from `TZ=America/Los_Angeles date`).
Claim: ops/lanes118/claims/mobile-364-a3206441-opus. Notes: ops/aud-118/AUD-OPUS-H6-118/
(c364.json, c317.json, pr364.json, 364-piece.diff, blob-eq-vs-d0407b62.txt, probe-*.log, probe specs, verdict-364.md, posted-364.json).
Worktree kept (no node_modules linked): wt/AUD-OPUS-H6-118-364, detached at local probe commit 217dbf05 (= head + 2 probe specs).

## Verdict
- mobile #364 @ a3206441d57ea51130490e6e54cc8228bff40687: REQUEST CHANGES, A/B/C = 0/2/4.
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982643511
- Head and checks re-read at 10:36 just before posting. Head unchanged; CLEAN; Typecheck, lint, test success (run 37179975081).
- Sol posted REQUEST CHANGES at this head at 10:27 (5982566404). I saw only its first line and did not read the body.

## Facts verified
- Piece diff: 19 files +699/-2,183 = 2,882 (operator SIZE KEEP 5975773365).
- Restack 78ee52c0 -> a3206441 is a pure merge (merge-tree = head tree d449a43a).
- 18 of 19 piece blobs are equal to #317 d0407b62 (Opus APPROVE chain through 5972163241). The only DIFF is easUpdateGuard.test.js: 2 lines, clinic '1', per the owner decision.
- Merge-tree of the head with main 7fdb629a is clean (3c874afb). No file overlap with main since 367e6c48.
- Ingest contract: the fixture sha 3c8701f9... is byte-equal to production backend 643817b3 test/_fixtures/wearables-ingest-v1.mobile.json, with the same pin in test/wearables/ingest-contract.spec.ts (strict schema; test/ is a jest root).
  - src/wearables, test/wearables and test/_fixtures are identical between production 643817b3 and main b644198b.
  - The mobile client posts the bare array to /v1/wearables/samples/ingest.
- Production backend register-on-device.dto.ts accepts APPLE_HEALTHKIT and HEALTH_CONNECT only, so no SAMSUNG_HEALTH connection can exist.
- useSamsungHealthSync was never imported by any screen on main. The AsyncStorage cursor is still swept at sign-out (authActions.ts:57).
- Backend #608 (deletion fan-out incl. WearableSample/WearableConnection) is an ancestor of production 643817b3 (C-317-6 precondition met).
- react-native-health-connect 3.5.3:
  - its manifest declares no permissions;
  - its plugin adds only the rationale intent filter;
  - the delegate API matches the plugin's call.

## Findings (posted)
- **B-364-1: the Samsung Health row is never truthful after a Samsung connect.**
  - Where:
    - ConnectionsScreen.tsx:151-178 (and the :171 not-syncing check);
    - onDeviceSync.ts:61-66;
    - wearablesConnectionsApi.ts:156-161, 361-362;
    - onDeviceCopy.ts:335-344;
    - ConnectProviderSheet.tsx:662-668.
  - What happens: the server gets a HEALTH_CONNECT row, and the Samsung row says "Not connected" and offers "Connect". The copy says "Samsung Health asks" and "Samsung Health data", but Health Connect asks and all HC records of the 15 types are read (the Samsung-origin filter was deleted in this piece).
  - Proof: run 37220573091, job 111489892576, exec 989f961e. 2 INVARIANT fail; 3 controls and 22 existing tests pass.
  - Fix rule: keep the tile. The Samsung row mirrors the Health Connect state and actions, or folds into the HC row as "Includes Samsung Health". The copy names Health Connect and all-app reads.
  - Verify: both INVARIANT cases pass, plus a disclosure test.
  - Probe spec: ops/aud-118/AUD-OPUS-H6-118/ConnectionsScreen.samsungRow.opus118.test.tsx.
- **B-364-2: the Health Connect privacy-policy link opens the app's normal screen.**
  - Where: plugins/withHealthConnectPermissionDelegate.js:14-18,46-58. The Android 14 alias and the library's rationale filter both point at MainActivity, and nothing handles either action.
  - Requirement: Android's HC guide says the activity "must display the same privacy policy you provide for your app in the Google Play Console".
  - Proof (structural): run 37220808402, job 111490581453, exec 43443a5f. 2 INVARIANT fail; 1 control and 24 healthPlatformConfig tests pass.
  - Fix rule: route both intents to PRIVACY_POLICY_URL, with a plugin test and a device step on Android 13 and 14+. It must land before the single clinic build (native, so no OTA fix).
  - Probe spec: ops/aud-118/AUD-OPUS-H6-118/healthConnectRationale.opus118.test.ts.

## Follow-ups (C)
- **C-364-1 (docs):**
  - docs/mobile/HEALTH_NATIVE_MODULES.md:1,8,20,32,159,167 still describe a Samsung Sensor SDK connector and permission;
  - docs/android-health-connect-build-switch.md:21 says versionCode 4 (app.json has 5);
  - docs/android-health-connect-build-switch.md:35-37 says ON passes permissions unchanged (ON now filters and blocks two).
  - Fix rule: update the docs.
- **C-364-2 (same lines as B-364-1, may ride its fix):** the Samsung empty-import copy (onDeviceCopy.ts:335-344) omits Samsung Health's own Health Connect sync setting. Fix rule: add a Samsung variant that names the setting.
- **C-364-3 (outside diff, main):** the on-device dataDescription lists (wearablesConnectionsApi.ts:140-162) name 4 categories while 15 types are read. #339 fixes the "We'll" voice only. Fix rule: derive the categories from the read lists, pinned by a test.
- **C-364-4 (outside diff, main):** NSHealthUpdateUsageDescription / healthUpdatePermission (app.json) say the app "may write workouts", but HealthKit requests write: [] (healthKitClient.ts:312). Fix rule: make the copy truthful.

## Integrated top (H1-H6)
- The tree is #317 d0407b62 + the guard pin + B-360-1.
- It is not landable at this tree: Sol's B-362-1..4 on #362 (5982471782) are present here. I independently confirmed B-362-1 by reading useWearableConnections.ts:117-121 (raw err to logger.warn). Not counted on #364 (guide rule 9).
- The H23 Cs (C-360-1/2/3, C-361-1/2) stay ruled follow-ups.
- Fingerprint runtime policy: the HC=1 clinic config is a new runtime, so a new clinic Android binary is required, and no OTA can reach the 09-30 binary.

## Operator decisions (recommended defaults)
1. **Where B-364-1 is fixed.** Default: fold it into the #362 (H4) builder round with B-362-1..4. ConnectionsScreen.tsx, onDeviceCopy.ts and ConnectProviderSheet.tsx are edited there anyway, so this avoids a second restack.
2. **B-364-2** belongs to this piece's own plugin. Default: the same builder job, under the wear lock, before the single clinic Android build.
3. **Cs:** ticket C-364-1/3/4. C-364-2 rides with the B-364-1 fix.
4. **Device pass, add:**
   - tap the HC privacy link on Android 13 (HC app) and on Android 14+ (Settings);
   - run the Samsung phone flow with Samsung Health's HC sync on and off.

## HANDOFF
- mobile #364 @ a3206441d57ea51130490e6e54cc8228bff40687: Opus REQUEST CHANGES 0/2/4 (5982643511); Sol REQUEST CHANGES (5982566404).
- CI: Typecheck, lint, test green (run 37179975081). Analyze is main-only.
- Next: a builder round closes B-364-1 (likely in H4) and B-364-2 (H6 plugin), replays both probe specs from ops/aud-118/AUD-OPUS-H6-118/, and restacks. Then a fresh Opus lens audits the new #364 head as a delta from this verdict.
- Cleanup: both audit branches were deleted at 10:37 (audit/AUD-OPUS-H6-118/364-samsung-row, 364-hc-rationale). The run logs stay viewable. The worktree and notes are kept. No PR branch push, merge, build, dispatch or production action.
