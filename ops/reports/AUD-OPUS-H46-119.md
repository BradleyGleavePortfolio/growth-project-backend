# AUD-OPUS-H46-119: Claude Opus 5.5 lens on mobile Health Connect H4 #362 and H6 #364 (T4: health data)

- **Operator:** agent 119.
- **Run time:** 12:41-12:56 PDT 10-04. Every time here comes from `TZ=America/Los_Angeles date`.
- **Claims:** ops/lanes119/claims/mobile-362-b3bc0ce4-opus and mobile-364-529ba345-opus.
- **Notes folder:** ops/aud-119/AUD-OPUS-H46-119/. It holds 362-delta.diff, verdict-362.md, verdict-364.md, posted-*.txt, the run logs (run37229715056.log, run37229740105.log) and probes/.

## Verdicts posted (both heads re-read at 12:55, unchanged and CLEAN)

| PR | Head | Verdict | A/B/C (new) | Comment |
|---|---|---|---|---|
| mobile #362 (H4) | b3bc0ce4d7e62763671881e6babd60aa518203cc | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5983805919 |
| mobile #364 (H6, top of the HC stack) | 529ba34524844403eb034dc1519ced21d208346c | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5983806176 |

**CI.** "Typecheck, lint, test" passed at both heads: #362 run 37225736086, #364 run 37225840687. Analyze runs only on PRs based on main.

**Sol.** After I posted, prstate showed Sol at REQUEST CHANGES on #362. I did not read Sol's body; my verdicts are independent of it.

## Facts verified
- **#362 delta (439937c9..b3bc0ce4).** 12 files, +580/-45 (commits a63e1aac and b3bc0ce4). H3 574b32a8 is an ancestor of both heads.
- **#364 delta (a3206441..529ba345).** It has the same 12 files, byte-identical to #362 b3bc0ce4, plus 78b7419f (the plugin and its test). The merges d8b7e397 and 529ba345 are pure: merge-tree equals the head tree.
- **Main.** #364 merges cleanly with mobile main cc4ceeed (merge-tree 8ca0640a).
- **Size.** Both PRs are grandfathered (governance list lines 153 and 155) and stay under 3,000 lines: 2,835 and 2,937.
- **Builder's failing-before runs.** All confirmed as failures:
  - 37223683422: 17 failed / 48 passed.
  - 37225682321: failed.
  - 37225552278: 2 failed / 24 passed.
- **Native code.** RN 0.85.3 `ReactActivity.onNewIntent(Intent)` is public Java and not final. No installed plugin injects `onNewIntent`. expo-splash-screen inserts before `super.onCreate(null)`, so it does not conflict with this change.
- **Privacy URL.** `PRIVACY_POLICY_URL` is https://app.trygrowthproject.com/privacy, which is the operator default.
- **eas.json.** The clinic profile has HC=1; the other profiles have 0.

## Prior Opus findings and their status
- **#362:**
  - B-362-1 and B-362-2 are closed (a63e1aac, plus failing-before run 37223683422).
  - C-362-1, C-362-2 and C-362-3 (the in-flight part) are closed.
- **#364:**
  - B-364-1 is closed by a63e1aac.
  - B-364-2 is closed structurally by 78b7419f. A device pass is still required.
  - C-364-2 is closed.

## Probes (CI lane; both runs passed)
- **#362: run 37229740105.** Exec de4e69b3 = head + probes. 8 suites, 78/78 tests pass.
- **#364: run 37229715056.** Exec 6bc401c6. 11 suites, 111/111 tests pass.
- **Replayed from earlier lenses:**
  - H45 ConnectionsScreen.emptyImport.probe
  - H45 WearablesShell.settingsReturn.probe
  - H6 ConnectionsScreen.samsungRow.opus118
  - H6 healthConnectRationale.opus118
- **New in this round:**
  - probes/useWearableConnections.opus119.test.tsx (4 tests):
    - Samsung row on Android: the server call is HEALTH_CONNECT, reads stop, A's grant is retired and B's grant is kept, and the list is invalidated.
    - On an iPhone, Disconnect does not stop Apple Health reads.
    - A failed server Disconnect stops nothing and keeps the grant.
    - A cloud Disconnect never stops on-device reads.
  - probes/hcPrivacyTemplate.opus119.test.ts (4 tests): the plugin works on the full Expo bare-template MainActivity, stays inside the class, inserts once, is idempotent, and braces balance.
- The audit branches were deleted at 12:56. The workspace copies above are the replay source.

## Follow-ups (C)
- **C-362-6** (useWearableConnections.ts:134-136): the docblock says a stale Disconnect "refetches". The code at :161-164 does not. Fix rule: correct the comment.
- **C-362-7** (ConnectionsScreen.tsx:253-258): the Samsung subline also shows on iPhone. Fix rule: show it on Android only.
- **C-362-8** (onDeviceState.ts:163-164): if the first grant read fails (a storage error read as null) and the next read succeeds, the grant is kept after Disconnect. Reads stay blocked, because the server connection is gone. Fix rule: treat "unreadable" differently from "absent".
- **C-364-5** (withHealthConnectPermissionDelegate.js:33,74):
  - On a cold start, the privacy link boots the full React Native app and then finishes.
  - On a warm start, Back from the browser returns to the app, not to Health Connect.
  - Fix rule: a small non-RN native activity, targeted by both filters.
- **Carried open:**
  - C-362-4: the type list (the voice part is in #339).
  - C-362-3 remainder: the refresh is not aborted on unmount.
  - C-362-5: RHR is not counted in the has-data check.
  - C-363-1.
  - C-364-1: docs.
  - C-364-3: the sheet type list.
  - C-364-4: the Apple "may write workouts" wording.
  - H3 INGEST_DISABLED_COPY claim.

## Operator decisions (recommended defaults)
1. **Play Console privacy URL** = https://app.trygrowthproject.com/privacy. Default: yes; the plugin and env pin it.
2. **Samsung row mirrors Health Connect.** Default: keep it.
3. **No-session Disconnect retires the source for every account on the phone.** Default: keep it (fails closed).
4. **Device pass before the single clinic Android build (native, so no OTA fix).** Default: the owner runs it.
   - The privacy link on Android 13 (HC app) and on 14+ (Settings), each cold and warm.
   - The Samsung flow with Samsung Health's HC sync on and then off.
   - Disconnect from the Samsung row.

## HANDOFF
- **#362 @ b3bc0ce4:**
  - State: Opus APPROVE 0/0/3 (5983805919). Sol is at REQUEST CHANGES (seen in prstate; body not read).
  - Next: if Sol's findings bring a fix round, a fresh Opus lens audits the delta from b3bc0ce4 and replays my probes from ops/aud-119/AUD-OPUS-H46-119/probes/.
- **#364 @ 529ba345:**
  - State: Opus APPROVE 0/0/1 (5983806176).
  - Next: if #362 changes, the restack needs a short delta verdict.
  - H5 #363 (2858bac5) gets its short delta from the next lens, per the job entry. That is not part of my job.
- **Cleanup:**
  - Done: audit/AUD-OPUS-H46-119/{362,364}-probes deleted, worktrees wt/AUD-OPUS-H46-119-{1,2} removed, claims left in place.
  - Not done: no push to a PR branch, no merge, build or dispatch.
