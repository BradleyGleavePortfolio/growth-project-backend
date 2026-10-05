AUDIT Claude Opus 5.5 — growth-project-mobile#364 @ 529ba34524844403eb034dc1519ced21d208346c — VERDICT: APPROVE

A/B/C = 0/0/1 (new). Lens AUD-OPUS-H46-119 (agent 119). Tier T4: health data, native Android config, permissions. I did not read Sol's verdict at this head.

### Scope and evidence reuse (G09)
- **Prior Opus verdict on this PR:** REQUEST CHANGES 0/2/4 at `a3206441` (5982643511, AUD-OPUS-H6-118). That review covered the whole piece at T4.
- **Delta `a3206441..529ba345`:**
  - Two pure restack merges. `d8b7e397` and `529ba345` each equal their `git merge-tree` result.
  - They bring in the 12 #362 fix files. Every blob is byte-identical to #362 @ `b3bc0ce4`, which I approved in the paired verdict.
  - Plus `78b7419f`: `plugins/withHealthConnectPermissionDelegate.js` and `healthPlatformConfig.test.ts`, +60/-5. I read every line.
- **Everything else** is unchanged since the H6-118 audit and rests on it.
- **Size:** 754+2,183 = 2,937 lines. #364 is grandfathered (PR_SIZE_GRANDFATHERED_2026-10-04.md:155) and stays under 3,000.
- **CI:** "Typecheck, lint, test" passes ([run 37225840687](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37225840687/job/111505186858)).
- **Merge with mobile main `cc4ceeed`:** clean (merge-tree `8ca0640a`).

### Prior Opus findings on this PR
- **B-364-1 (Samsung row never truthful): closed.**
  - Fixed in the H4 files (a63e1aac, carried by merge). The row mirrors Health Connect, Disconnect maps to HEALTH_CONNECT, and the copy names Health Connect and every app.
  - My probe `ConnectionsScreen.samsungRow.opus118` passes at this head, both INVARIANTs included. It failed 2/5 at `a3206441` (run 37220573091).
- **B-364-2 (privacy policy link opens the normal screen): closed structurally. The device step remains.**
  - What changed in 78b7419f:
    - MainActivity now calls `if (showHealthConnectPrivacyPolicy(intent)) finish()` right after `super.onCreate`.
    - It gains `override fun onNewIntent(intent: android.content.Intent)`, which calls `super.onNewIntent` and then the handler.
    - The handler reacts to `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE` (Android 13, the library filter) and `android.intent.action.VIEW_PERMISSION_USAGE` (the Android 14+ alias, guarded by `START_VIEW_PERMISSION_USAGE`).
    - It opens `ACTION_VIEW` on `https://app.trygrowthproject.com/privacy`. That URL equals `PRIVACY_POLICY_URL` (env.ts:69-70, pinned by test) and the operator's Play URL.
    - Prebuild now fails loudly for a Java MainActivity or an existing `onNewIntent`.
  - Checks against the installed packages:
    - RN 0.85.3 `ReactActivity.onNewIntent(Intent)` is public Java and not final, so the Kotlin non-null override compiles.
    - No installed expo, @expo, @sentry or react-native-health-connect plugin injects `onNewIntent`. The only other MainActivity mod, expo-splash-screen, adds a line before `super.onCreate(null)`, so it does not conflict with this insert in either order.
    - Failing-before: [run 37225552278](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37225552278/job/111504347235) (2 failed / 24 passed).
  - My H6 probe `healthConnectRationale.opus118` now passes.
  - New probe `hcPrivacyTemplate.opus119` (4/4 pass) runs the plugin against the full Expo bare-template MainActivity (splash registration, delegate wrapper with nested braces, `invokeDefaultOnBackPressed`). It confirms:
    - the delegate call and privacy check sit inside onCreate, directly after `super.onCreate(null)`;
    - the handler members land inside the class body, exactly once, and braces balance;
    - the plugin is idempotent;
    - the import goes after the package line, once.
- **C-364-2:** closed (the Samsung empty-import variant).
- **Still open, outside this diff:** C-364-1 (docs), C-364-3 (type list), C-364-4 (Apple write wording).

**Probe replay at this head:** [run 37229715056](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229715056). It ran at exec `6bc401c6`, which is the head plus the probe files plus the lane files. Result: 11 suites, 111/111 pass. That covers all 4 prior Opus probes (H45 x2, H6 x2), the 2 new probes, `healthPlatformConfig`, and the builder's Disconnect, ConnectionsScreen and WearablesShell suites.

### H1-H6 integrated top (this tree is what lands)
- **Flag.** `TGP_ANDROID_HEALTH_CONNECT` opts in only with '1'. With any other value, every health permission and both HC plugins are stripped (app.config.js). The clinic profile in eas.json is '1', per the owner's 10-03 18:42 decision; every other profile is '0'.
- **Permissions.** The manifest declares exactly the 15 `READ_*` types in `HEALTH_CONNECT_RECORD_TYPES`. The Samsung sensor and `ACTIVITY_RECOGNITION` permissions are blocked in every build.
- **Permission and copy truth.**
  - Health Connect asks; the copy says so.
  - The disclosure names every app's Health Connect data.
  - The empty import, Settings return, and Reconnect copy each name a button that exists.
  - The privacy link opens the Play policy.
- **Session and identity fences.**
  - Imports are fenced on auth generation plus user.
  - Disconnect captures the person, generation and grant before awaiting, and stops this phone's runs synchronously.
  - A stale Disconnect touches only its own person's records.
  - Notices are fenced on run, mount and generation.
- **Logs.** Only closed classes are logged: no raw provider error, health value or storage key.
- **No first person** in new copy. The clinic partner is not named.
- **Ruled follow-ups, not blockers:** late data and resumable import (C-360-1/2).
- **Mobile runtime.** The fingerprint policy makes the HC=1 config a new runtime, so a new clinic Android binary is required. B-364-2 is native, so the device pass must run before that one build.

### Follow-ups (C, FREEZE: tickets)
- **C-364-5: the privacy-link launch path.** withHealthConnectPermissionDelegate.js:33,74. On a cold start the rationale intent boots the full React Native app in MainActivity and then calls `finish()`. While the app is running, Back from the browser returns to the app, not to Health Connect.
  - Fix rule: a small native activity with no React Native that opens the policy and finishes, targeted by both the rationale filter and the alias.
  - Verify on Android 13 and 14+, cold and warm.
  - Not a B: both paths show the Play policy, which is the requirement.
- **Carried:** C-364-1, C-364-3, C-364-4 (see the 5982643511 rules).

APPROVE: zero A, zero B. **Device pass required before the clinic build:** the privacy link on Android 13 (HC app) and on 14+ (Settings), each cold and warm; the Samsung flow with Samsung Health's HC sync on and off; Disconnect from the Samsung row.
