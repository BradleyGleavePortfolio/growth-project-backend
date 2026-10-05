# AUD-OPUS-H46D-119: Claude Opus 5.5 lens on Health Connect H4 #362 FIX ROUND 3, H5 #363 and H6 #364 delta (T4: health data)

- **Operator:** agent 119.
- **Run time:** 14:05-14:26 PDT 10-04. Every time here comes from `TZ=America/Los_Angeles date`.
- **Claims (taken 14:06):** ops/lanes119/claims/mobile-362-73dbefbc-opus, mobile-363-f62f1bbe-opus and mobile-364-b261f218-opus.
- **Notes folder:** ops/aud-119/AUD-OPUS-H46D-119/. It holds:
  - 362-delta.diff and verdict-{362,363,364}.md;
  - posted-*.txt and the run logs run37235136229.log, run37235147469.log and run37235444731.log;
  - probes/useWearableConnections.opus119d.test.tsx.

## Verdicts posted (each head re-read just before posting, 14:25, unchanged)

| PR | Head | Verdict | A/B/C (new) | Comment |
|---|---|---|---|---|
| mobile #362 (H4) | 73dbefbcbe97544710058dcab176ea8713654042 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5984555005 |
| mobile #363 (H5) | f62f1bbe5d41332db403fd4e598f6ab864550dc1 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5984556343 |
| mobile #364 (H6) | b261f2188f3b6932145f05c45f7763c838bfc6ed | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5984556566 |

**CI.** "Typecheck, lint, test" is green at every head: #362 run 37233807134, #363 run 37234051935, #364 run 37234054947. Analyze runs only on PRs based on main.

## Facts verified
- **#362 delta (b3bc0ce4..73dbefbc).** 5 files, +94/-22 (153a0707 and 73dbefbc). Every line was read.
- **#363.** The own diff is 6 files, +1,385, tests only.
  - The 3 ConnectProviderSheet tests are byte-identical to 2858bac5.
  - The merges 3d5231f2 and a021c9e6 are pure.
- **#364.** The own-diff patch-id is e50c714e at both 529ba345 and b261f218.
  - The merges 783cef8e, ab14d8d2 and b261f218 are pure.
  - The 5 H4 delta files are byte-identical to #362.
- **Size.** All three PRs are grandfathered (governance list lines 153-155) and stay under 3,000 lines: 2,913, 1,385 and 2,937.
- **Session fence.**
  - The hook re-checks the session after each await, at :163 and :166.
  - The API applies a per-request `transformRequest`. In axios 1.16.1 it runs after the async token interceptor, and the xhr adapter then sends with no await in between.
  - On a 401, the retry goes back through the same `transformRequest`.
  - A same-user refresh emits no auth event, so it does not block a legitimate retry.
- **Later grants.** The sequence fence works: the number is bumped synchronously before `setItem`, and there is no await between the filter and `removeMany`.

## Probes (CI lane)
- **#362 top: run 37235136229.** 10 suites, 96/96 tests pass.
- **#364 top: run 37235147469.** 15 suites, 145/145 tests pass. This includes H5's sessionEpoch and transport suites.
- **New probe, opus119d (4 tests):**
  - A 401 refresh where the session moves during the refresh: the retry is not sent. The control case sends it.
  - A newer grant written during the identity read is kept. The control case retires the start grant.
- **Failing-before: run 37235444731 at b3bc0ce4.** 2 of 4 tests fail (the switch case sends one extra request; conn-new is removed). Both controls pass.
- **Replayed:**
  - opus119
  - hcPrivacyTemplate.opus119
  - healthConnectRationale.opus118
  - ConnectionsScreen.samsungRow.opus118
  - the two H45 probes

## Follow-ups (C)
- **C-362-11 (new)** (src/services/health/onDeviceState.ts:176-177): the comment says "storage applies writes in call order". That is not guaranteed on Android: in @react-native-async-storage 3.1.1, the legacy LegacyStorageModule.kt runs each call as its own coroutine on Dispatchers.IO.
  - The failure fails closed: the newer grant is lost and reads stop until the next Connect.
  - Fix rule: chain local-authorization writes and retirement removals through one JS promise queue, or correct the comment.
  - Test: use a storage double that resolves multiRemove after a later multiSet.
- **Confirmed from the builder:**
  - C-362-9 (api.ts:262-267): the message is rewritten on the fence error.
  - C-362-10: the retireOnDeviceState(source) branch is unused.
- **Carried open:**
  - C-362-3 remainder
  - C-362-4
  - C-362-5
  - C-362-7
  - C-362-8
  - C-363-1
  - C-364-1..5
  - H3 INGEST_DISABLED_COPY
- **Closed:** C-362-6.

## Operator decisions (recommended defaults)
1. **An aborted Disconnect closes silently.** Default: accept. Every generation bump is a sign-out start or an authEvents emit, and either one re-bootstraps RootNavigator. So no person is left on a screen where the no-op stays visible.
2. **A Disconnect racing Log out is dropped.** This also applies to cloud providers. Default: accept (never send under another session).
3. **Carried decisions:**
   - Play privacy URL: https://app.trygrowthproject.com/privacy.
   - The Samsung row mirrors Health Connect.
   - A no-session Disconnect retires older grants for every account on the phone.
   - The owner runs a device pass before the single clinic Android build.
   - Defaults: yes, keep, keep, owner runs it.

## HANDOFF
- **All three PRs have an Opus APPROVE at their current heads.**
  - #362: 73dbefbc
  - #363: f62f1bbe
  - #364: b261f218
- **Next steps:**
  - Sol's H46D verdicts are pending (not read by me).
  - If any head moves, a fresh Opus lens posts a delta from these heads and replays ops/aud-119/AUD-OPUS-H46D-119/probes/ plus ops/aud-119/AUD-OPUS-H46-119/probes/.
  - H1-H6 land as one, with Analyze at the main-based landing.
- **Cleanup:**
  - Done: audit/AUD-OPUS-H46D-119/{362-probes,364-probes,362-before} deleted, worktrees wt/AUD-OPUS-H46D-119-{1,2,3} removed, claims left in place.
  - Not done: no push to a PR branch, no merge, build or dispatch.
