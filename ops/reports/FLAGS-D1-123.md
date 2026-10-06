# FLAGS-D1-123 — day-1 flag matrix before the 10-07 Expo build (scout, Claude Opus 5.5, READ-ONLY, agent 123)

Started 19:25 PDT 10-05, report written 19:40-19:50 PDT. Nothing pushed, no PRs, no comments, no workflow runs.
Evidence read: backend main e6f9a5ec0c5bac40f33ac7513ad2653880f265d3 (main CI green at 19:31: all required checks pass; only
release-please, which is not required, failed), mobile main 0f5d626ecd0c15f94285c0484e1d6623cffce14a, tgp-agent-context main eac4e844
(TGP_SOURCE_OF_TRUTH.md), Fly Env Sync plan run 37400579222 (log in ops/aud-123/FLAGS-D1-123/envsync_plan_37400579222.log),
fly-env-truth run 37143727833 (10-03, names only; artifact in ops/aud-123/FLAGS-D1-123/envtruth/), fly-secrets-list run 36885057965
(10-01, names only). No values printed anywhere.

## Production today (from plan 37400579222 + apply 37400979472)
- Production backend = 0521b393 (deploy 6, 18:33). Main is ahead by the Roman train (#667 + #665 #666 #668 #669 #670, merged 19:19),
  b#736 (AI guide crisis fix), b#671 trials (2 migrations: 20270228000000_package_free_trials, 20270313000000_package_trial_truth),
  b#725 (lockout allow-list), b#737 (programs flags; already applied by env sync), b#738 (proxy-addr). So deploy 7 = e6f9a5ec or later,
  `migrations=apply-migrations`.
- Flags ON in production: FEATURE_AI_CONSENT_LEDGER_ENABLED=true, FEATURE_WEARABLES_INGEST_POST=true, BOOKING_REMINDERS_ENABLED=on,
  FEATURE_MWB_TEMPLATES / FEATURE_MWB_AUTOSAVE_UNDO / FEATURE_NAMED_REGIMES=true (+ MWB_AUTOSAVE_LOCK_TOKEN_SECRET, GOOGLE_CLIENT_IDS).
  Defaults-on (absent = on): SIGNUP_ROLE_CHOICE_ENABLED, COACH_WELCOME_SCHEDULER_ENABLED, WORKOUT_REMINDERS_ENABLED, FEATURE_COMMUNITY_SCHEMA.
- Absent (off): every other FEATURE_COMMUNITY_*, FEATURE_MESSAGING_CORE_V2, FEATURE_COACHLESS_HOME, FEATURE_COACH_CODE_TOOLS,
  FEATURE_COACH_BROADCASTS, FEATURE_DUNNING_V2. FEATURE_ROMAN_CHAT_ENABLED is in the manifest's "excluded" list; FEATURE_ROMAN_ADJUST_ENABLED
  is not in the manifest at all. Neither is set on Fly (env-truth 10-03 lists FEATURE_ROMAN_CHAT_ENABLED under "registered but missing").
- Anthropic key: ANTHROPIC_API_KEY is present and non-empty (fly-secrets-list 10-01 "Deployed"; env-truth 10-03 not in the missing or
  empty lists). The env-sync plan does NOT check it (not a manifest name), so the latest proof is 10-03. Roman uses its own Anthropic
  client (src/roman/anthropic-client.provider.ts), not the AI gateway, so AI_GATEWAY_ENABLED being unset does not matter for Roman.

## Mobile today (eas.json on mobile main 0f5d626e)
- production env: TGP_ANDROID_HEALTH_CONNECT=0, EXPO_PUBLIC_USE_MOCK_COMMAND_CENTER=false, EXPO_PUBLIC_NOTIFICATIONS_MOCK=false,
  EXPO_PUBLIC_FF_IOS_HIDE_NON_P2P_PURCHASES=true, EXPO_PUBLIC_FF_CLIENT_CALENDAR=true, EXPO_PUBLIC_FF_MWB_PROGRAMS=true, EXPO_PUBLIC_FF_MWB_AUTOSAVE=true.
- clinic env (extends production; env is merged, per config/expected-env.json "after extends"): TGP_ANDROID_HEALTH_CONNECT=1, CLIENT_TUTORIAL,
  COMMUNITY_TAB, COMMUNITY_HALL, COMMUNITY_COHORTS, COACH_BRIEF, CLIENT_CALENDAR, MWB_PROGRAMS, MWB_AUTOSAVE, CONSULTATION_ONBOARDING = true;
  COMMUNITY_DM=false.
- EXPO_PUBLIC_FF_ROMAN_CHAT is in neither profile, so live Roman chat is OFF in both binaries. It gates the client and coach Roman chat
  screens, the More row and the in-workout Roman hooks (featureFlags.ts:269, ClientNavigator.tsx:520, CoachNavigator.tsx:487).
- Server-driven on mobile (no build-time flag; GET /me/feature-flags or a 404 probe): messaging v2 (`messaging_core_v2`), coachless Home
  (`coachless_home`), approve-to-adjust card (GET /coach/adjustments 404 = hidden, romanAdjustApi.ts:79). Push and scheduling have no
  mobile flag besides CLIENT_CALENDAR.

## Matrix
| Feature (day 1) | Backend flag(s): now -> proposed | Mobile flag(s): now -> proposed | Code merged? (PRs) | Gate / blocker | Owner decision? |
|---|---|---|---|---|---|
| Push notifications | none (no flag; live since deploy 3) -> no change | none (NOTIFICATIONS_MOCK=false both) -> no change | yes: b#692, b#693 (deployed with 20270307000000); m#341 | owner Android push device check on the 10-07 build before announcing Android push (A6.5) | no |
| Coachless sign-up (no code) | SIGNUP_ROLE_CHOICE_ENABLED absent = on -> no change | none -> no change | yes (RoleChoice on mobile main) | none | no |
| Featured coach / coachless Home (banner, code sheet, scripted Roman card) | FEATURE_COACHLESS_HOME unset -> STAYS unset | server `coachless_home` -> mobile UI NOT BUILT | backend yes: b#721, b#722, b#723, b#734 (deploy 5); b#657 is the superseded original, still open. Mobile: no PR, no branch | mobile A1 screens missing; then lens pair, device pass, owner saves the offer via PUT /admin/featured-coach | yes (3) |
| Invite codes (coach Codes screen: create, rotate, revoke, QR, counts) | FEATURE_COACH_CODE_TOOLS unset -> STAYS unset | none -> mobile Codes screen NOT BUILT (M-INV never started) | backend yes: b#658 (deploy 5). Legacy invite codes keep working (src/api/invites.ts) | mobile Codes screen missing; then lens pair + device pass | yes (3) |
| Broadcasts (segmented, scheduled, recurring, cards, saved replies) | FEATURE_COACH_BROADCASTS unset -> STAYS unset | none -> mobile composer NOT BUILT | backend yes: b#726 (with #727-#730 landed into it; deploy 6); b#659 is the superseded original, still open. Mobile: no PR | mobile composer missing; then lens pair + device pass | yes (3) |
| Unified inbox / messaging v2 | FEATURE_MESSAGING_CORE_V2 unset -> **true** | server `messaging_core_v2` -> no eas.json change | yes: b#708-#711 (deployed); m#371, m#377 | manifest gate wants a device pass of the thread polish; the pass needs the flag on, production has only the owner's account, mobile falls back to the legacy thread on 503 | yes (4) |
| Community core (Hall, cohorts, posts, comments, community push, realtime) | FEATURE_COMMUNITY_API, _POSTS, _MESSAGES, _PUSH, _REALTIME unset -> **true** (same five lines as stale b#650, 872 commits behind, never audited) | clinic COMMUNITY_TAB/HALL/COHORTS=true already; production none -> owner decision 2 | yes: b#610 UGC safety (merged 10-02, deployed), b#652; m#314 report/block (merged 10-03) | env-sync precondition: the four sub-flags need FEATURE_COMMUNITY_API=true in the same PR (fly-env-manifest.js:93-103). Today the clinic binary shows a Community tab that answers 503 community.disabled, and More > Community is reachable in production too (docs/reachability.md) | yes (2) |
| Roman live chat | FEATURE_ROMAN_CHAT_ENABLED absent (manifest "excluded") -> **true** | EXPO_PUBLIC_FF_ROMAN_CHAT absent -> **true** in production and clinic | yes: b#667, #665, #666, #668, #669, #670 (main 19:19), b#736; mobile chat + m#372-#376, m#379 | (a) deploy 7 must be live first (train not in production); (b) ENV_RULES has no closed value set for this flag, so the manifest PR must add `values`/`unsetIs` or the plan fails closed; (c) Anthropic key present as of 10-03, re-confirm with a read-only fly-env-truth run before apply; (d) the "stays off in the clinic profile" line, see decision 1 | yes (1) |
| "Your conversations" with Roman | same flag (all /roman routes 404 while off) -> true | same flag (chat header entry); Settings entry is ungated | yes: m#372-#376 (m#331 is the superseded original, still open) | same as live chat | no (follows 1) |
| Daily-cap pop-up | no own flag (ROMAN_DAILY_COST_CAP_USD unset = 100 USD/day platform-wide; 50 turns/24 h per client) -> no change | none -> no change | yes: m#379; codes from b#669 | none. C (carried): the spend cap is platform-wide, not per client (M-ROMANCAP-122 decision 1) | no |
| Roman approve-to-adjust | FEATURE_ROMAN_ADJUST_ENABLED absent, not in manifest -> add as "unset" now, **true** in a one-line follow-up | server (404 = hidden) -> no eas.json change | yes: b#655 (deploy 6), m#337 | **Opus C-337 not fixed on mobile main**: an edit that raises sets shows "18 to 21 sets, -17% less volume" (romanAdjustCopy.ts:182). The copy is in the binary, so the fix must merge before the 10-07 build. Same ENV_RULES `values`/`unsetIs` gap as Roman chat | yes (6) |
| Scheduling (types, approval, expiry, reminders, calendars, coach booking options) | BOOKING_REMINDERS_ENABLED=on (applied 18:52); WORKOUT_REMINDERS / COACH_WELCOME_SCHEDULER absent = on -> no change | CLIENT_CALENDAR=true both -> no change | yes: b#712-#720, b#653, b#643, b#735 (deploy 6); m#365-#367, m#381, m#341 | none. m#336 (dead base) is likely superseded by m#365-#367 (owner OK to close). C: the excluded GOOGLE_CALENDAR_ENABLED, GOOGLE_MEET_ENABLED, FEATURE_GOOGLE_CALENDAR_SYNC, ZOOM_ENABLED, DIAGNOSTIC_AI_ENABLED share one value group with FEATURE_AI_CONSENT_LEDGER_ENABLED in env-truth 10-03, so they are probably "true" on Fly. They cannot be reached because only 'manual' providers are offered (scheduling-provider.registry.ts:86-95). Adopt them into the manifest later | no |
| Dunning v2 (launch step 4 "done, flag off") | FEATURE_DUNNING_V2 unset -> STAYS unset in this PR | none -> no change | yes: b#687-#691, b#724 (deploy 5), b#725 (merged, NOT deployed); m#352-#354, m#380 | needs: deploy 7 (carries b#725), owner confirms the Stripe customer portal is on in live mode, and a check that dunning emails link to a working portal on the owner's account (A7.4 "billing-portal check"). The manifest gate text still names superseded b#628 / m#322 | yes (5) |
| Launch-path flags already on (programs, wearables, AI ledger, Google sign-in) | as listed above -> no change | MWB_PROGRAMS/AUTOSAVE, IOS_HIDE_NON_P2P both; Health Connect clinic 1, production 0 -> no change | yes | production Android build has no Health Connect (TGP_ANDROID_HEALTH_CONNECT=0): leave as is unless the owner wants it in the production Play build | no |

## Proposed diffs (flags whose feature is not fully merged stay OFF)

### (a) Backend: one manifest PR on growth-project-backend main (T4: production flags, client data to the AI provider, member-to-member content). About 45 changed lines.
Merging changes nothing. Apply order: deploy 7 (e6f9a5ec or later, apply-migrations; A6.3 read-only native-trials count first) ->
read-only fly-env-truth run to re-confirm ANTHROPIC_API_KEY present -> Fly Env Sync plan (expect exactly 7 to set, 0 to unset) -> apply
with confirm=SET deploy_staged=true -> /health, /readyz -> check each flag on the owner's account.

1. `.github/fly-env-desired-state.json`, `flags`:
```diff
-    "FEATURE_COMMUNITY_API": "unset",
-    "FEATURE_COMMUNITY_POSTS": "unset",
-    "FEATURE_COMMUNITY_MESSAGES": "unset",
-    "FEATURE_COMMUNITY_PUSH": "unset",
-    "FEATURE_COMMUNITY_REALTIME": "unset",
+    "FEATURE_COMMUNITY_API": "true",
+    "FEATURE_COMMUNITY_POSTS": "true",
+    "FEATURE_COMMUNITY_MESSAGES": "true",
+    "FEATURE_COMMUNITY_PUSH": "true",
+    "FEATURE_COMMUNITY_REALTIME": "true",
@@
-    "FEATURE_MESSAGING_CORE_V2": "unset",
+    "FEATURE_MESSAGING_CORE_V2": "true",
@@
     "FEATURE_COACH_CODE_TOOLS": "unset",
-    "FEATURE_COACH_BROADCASTS": "unset"
+    "FEATURE_COACH_BROADCASTS": "unset",
+    "FEATURE_ROMAN_CHAT_ENABLED": "true",
+    "FEATURE_ROMAN_ADJUST_ENABLED": "unset"
   },
```
   Unchanged and OFF on purpose: FEATURE_COACHLESS_HOME, FEATURE_COACH_CODE_TOOLS, FEATURE_COACH_BROADCASTS (mobile not built),
   FEATURE_DUNNING_V2 (own PR, decision 5), FEATURE_COMMUNITY_VOICE_NOTES (device pass), _DM (clinic profile keeps DM off) and every other
   community extra.
2. Same file, `excluded`: delete the `"FEATURE_ROMAN_CHAT_ENABLED": "Ledger: stays off ..."` line.
3. Same file, `gates`: add
   - `"FEATURE_ROMAN_CHAT_ENABLED": "Day 1 (owner 10-02 16:34 and 10-05 09:57), true: Roman train #665-#670/#667 and b#736 deployed (deploy 7); mobile EXPO_PUBLIC_FF_ROMAN_CHAT on in the production and clinic profiles for the 10-07 build; ANTHROPIC_API_KEY present on Fly; box-2 consent enforced by FEATURE_AI_CONSENT_LEDGER_ENABLED. Unset = off (only 'true'); emergency kill: unset (every /roman route returns 404; saved chats are kept)."`
   - `"FEATURE_ROMAN_ADJUST_ENABLED": "Day 1 (owner 10-05 09:57): b#655 deployed, m#337 merged. Flip to true only after the mobile changeSummary fix (Opus C-337: raised sets showed a negative '% less volume') is merged and in the 10-07 build. Unset = off (only 'true'); emergency kill: unset (every /coach/adjustments route returns 404 and the card hides)."`
   - rewrite `FEATURE_MESSAGING_CORE_V2` to: `"Day 1, true: backend #708-#711 deployed, mobile m#371/#377 merged (server flag messaging_core_v2). Production has only the owner's account, so it is on for the device pass on the 10-07 build. Not a community flag. Kill: unset (routes return 503 messaging.feature_disabled; the app falls back to the legacy thread)."`
   - the FEATURE_COMMUNITY_API gate text can stay (it says flip after #610 is deployed; it is); add "#610 deployed, m#314 merged" for the record.
4. `src/common/env-validation.ts` (the plan rejects a flag without a closed set, fly-env-manifest.js:334-346). The parser needs each line on
   its own, 4-space indent, `values` directly after `name`, `unsetIs` directly after `values`:
```diff
   {
     name: 'FEATURE_ROMAN_ADJUST_ENABLED',
+    values: ['true', 'false'],
+    unsetIs: 'off',
     tier: 'optional',
@@
   {
     name: 'FEATURE_ROMAN_CHAT_ENABLED',
+    values: ['true', 'false'],
+    unsetIs: 'off',
     tier: 'optional',
```
   (both rules read only the literal true: roman.feature.ts:42, roman-adjust.constants.ts:13).
5. `docs/runbooks/launch-flags.md`: regenerate the kill-switch table with
   `node scripts/fly-env/fly-env-manifest.js kill-switches .github/fly-env-desired-state.json src/common/env-validation.ts`
   (test/ci/fly-env-manifest.spec.ts:223 fails on drift); it gains two rows, FEATURE_ROMAN_CHAT_ENABLED and FEATURE_ROMAN_ADJUST_ENABLED,
   both "off | fly secrets unset ... | unset".
6. Follow-up one-line PR after the C-337 mobile fix merges: `"FEATURE_ROMAN_ADJUST_ENABLED": "unset"` -> `"true"`.
7. Not in this PR: FEATURE_DUNNING_V2 -> true, as its own PR after decision 5's checks (update its gate text to the real PRs).

### (b) Mobile: eas.json on growth-project-mobile main (merge before the 10-07 build)
```diff
     "production": {
       ...
       "env": {
         ...
         "EXPO_PUBLIC_FF_MWB_PROGRAMS": "true",
-        "EXPO_PUBLIC_FF_MWB_AUTOSAVE": "true"
+        "EXPO_PUBLIC_FF_MWB_AUTOSAVE": "true",
+        "EXPO_PUBLIC_FF_ROMAN_CHAT": "true"
       }
     },
     "clinic": {
       ...
       "env": {
         ...
         "EXPO_PUBLIC_FF_CONSULTATION_ONBOARDING": "true",
-        "EXPO_PUBLIC_FF_COMMUNITY_DM": "false"
+        "EXPO_PUBLIC_FF_COMMUNITY_DM": "false",
+        "EXPO_PUBLIC_FF_ROMAN_CHAT": "true"
       }
     }
```
- If the owner says no to decision 1, write `"EXPO_PUBLIC_FF_ROMAN_CHAT": "false"` in clinic instead (clinic extends production, so
  leaving it out would inherit true).
- If the owner says yes to decision 2 (community in the general store binary), also add to production:
  `"EXPO_PUBLIC_FF_COMMUNITY_TAB": "true", "EXPO_PUBLIC_FF_COMMUNITY_HALL": "true", "EXPO_PUBLIC_FF_COMMUNITY_COHORTS": "true"`.
- All three names are already declared in config/expected-env.json, so scripts/__tests__/expectedEnv.test.js stays green; no test pins
  EXPO_PUBLIC_FF_ROMAN_CHAT off in eas.json (checked). Leave every Roman sub-flag (FIRST_PAYMENT_WOW, CHECKIN/STREAK_BACKEND_LIVE,
  COMPETENCE_PILL, THREE_ARC_ROUTER, ONBOARDING_POLISH, BODYWEIGHT_POLISH) off: not on the day-1 list, and their backend flags are off.
- C-337 fix, same deadline (src/components/roman/adjust/romanAdjustCopy.ts:181-183, plus one test case for a raise and one for 0):
```diff
 export function changeSummary(c: RomanAdjustChange): string {
-  return `${c.sets_before} to ${c.sets_after} sets, ${c.volume_pct}% less volume`;
+  const sets = `${c.sets_before} to ${c.sets_after} sets`;
+  if (c.volume_pct > 0) return `${sets}, ${c.volume_pct}% less volume`;
+  if (c.volume_pct < 0) return `${sets}, ${Math.abs(c.volume_pct)}% more volume`;
+  return `${sets}, same volume`;
 }
```

## Blockers (in order)
1. Deploy 7 (backend main e6f9a5ec or later, apply-migrations) must run before FEATURE_ROMAN_CHAT_ENABLED is applied; production
   0521b393 has none of the Roman train, b#736 or b#725.
2. C-337 mobile copy fix is not on mobile main; it must merge before the 10-07 build or approve-to-adjust ships with wrong copy.
3. Mobile UI for featured coach / coachless Home, the coach Codes screen and the broadcasts composer does not exist (no PR, no branch).
   Their backend flags stay off; none of the three can be fully live in the 10-07 binary unless built and audited by then.
4. ENV_RULES has no closed value set for FEATURE_ROMAN_CHAT_ENABLED / FEATURE_ROMAN_ADJUST_ENABLED: the manifest PR must carry diff (a)4
   and the regenerated runbook table, or CI and the plan fail closed.
5. Anthropic key proof is from 10-03 (env-truth) and the env-sync plan never checks it: one read-only fly-env-truth run before apply.
6. Outside flags, seen in passing: env-truth 10-03 shows the APPLE_AUDIENCES shape check failing (Sign in with Apple; owner to-do "Apple
   Sign-in key" is still open in A8.6). Worth a fresh env-truth read in the same run as item 5.

## Owner decisions (recommended defaults)
1. Live Roman chat in the clinic binary. Default: ON in both profiles. The "EXPO_PUBLIC_FF_ROMAN_CHAT stays off in the clinic profile"
   line is the 10-01 D1 ruling in Part C2 (retired page). Owner 10-02 16:34 ("Live free-form Roman chat in v1.0: yes") and 10-05 09:57
   (C1: chat and adjust "flip after the stacks land and pass") replaced it. The A7.4 "Stay OFF for launch" row and the manifest's excluded
   text are stale; the operator should fix A7.4 when the PR lands.
2. Community core (Hall, cohorts, posts, comments, push, realtime) on for day 1, and the Community tab in the general (production) binary
   too. Default: yes to both (owner 10-01 11:32 "all of that ... live on day 1"; #610 deployed, m#314 merged; the clinic tab already shows
   it and More > Community is reachable in production today, answering 503). Voice notes, DM and the other extras stay off.
3. Featured coach, coach Codes screen, broadcasts composer: start three mobile builders now (each under 1,500 lines, server-gated so they
   can sit dark in the 10-07 binary), flags stay off until a lens pair and a device pass. Default: yes; anything that misses the build
   rides the clinic OTA channel (#305) or the next build.
4. Messaging v2 on before its device pass. Default: yes (only the owner's account exists; the pass needs it; kill = unset).
5. FEATURE_DUNNING_V2 on for day 1 (SoT A7.4, owner 10-01 11:32, lists it day 1). Default: yes, as its own PR after deploy 7, the owner's
   confirmation that the Stripe customer portal is on in live mode, and one dunning-email portal-link check on the owner's account.
6. Approve-to-adjust on. Default: yes, one-line flip right after the C-337 fix merges (both before Wednesday).

## Carried Cs (no action now)
- C-669-1: "800 mg ibuprofen" gets 911 from Roman (errs to safety). C-736-8: the AI guide returns no crisis route for "I want to take all
  my pills" / "I'm going to OD" (both lenses kept it C). The owner may want C-736-8 closed before live Roman is announced, since both AI
  surfaces will be live.
- Roman spend cap is platform-wide (M-ROMANCAP-122 decision 1). C (edge, deferred to 10k clients) at launch volume.
- Excluded Google Calendar / Meet / Zoom / Diagnostic switches are probably "true" on Fly but unreachable (only 'manual' providers).
- b#650 (community core flip, 10-03) is stale and unaudited: supersede it with the PR above.

## HANDOFF
- State: scout finished 19:50 PDT. Report is complete. No worktrees, branches, claims or locks created. Raw evidence:
  /home/user/workspace/ops/aud-123/FLAGS-D1-123/ (envsync_plan_37400579222.log, run_37143727833.log, run_36885057965.log, envtruth/).
- Next step for the operator: (1) build the backend manifest PR from (a) and the mobile PR from (b) + the C-337 fix (two small PRs, T4 and
  T3); (2) lens pair on each; (3) merge mobile before the 10-07 build; (4) deploy 7, then a read-only env-truth run, then env-sync
  plan/apply for (a); (5) the one-line adjust flip after C-337; (6) dunning flag PR after decision 5's checks.
- If heads moved: re-check backend main vs e6f9a5ec and mobile main vs 0f5d626e; re-read eas.json and the manifest before writing diffs.
