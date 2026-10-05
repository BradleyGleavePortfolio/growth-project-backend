# AUD-OPUS-H7-120: Claude Opus 5.5 lens, mobile #369 (H7 Health Connect sign-out durability), agent 120

- **Job:** a full review of growth-project-mobile#369 at 3252ec79cd9ab1f28165a1913d8ae3096b590d4a. Tier T4: health data consent, sign-out, and the account-deletion path.
- **Claim:** ops/lanes120/claims/mobile-369-3252ec79-opus (09:28 PDT 10-05). Run time 09:28-09:53 PDT 10-05. All times come from `TZ=America/Los_Angeles date`.
- **Notes:** ops/aud-120/AUD-OPUS-H7-120/. It holds:
  - pr369.json and comments369.json
  - specs.txt (lane 1 spec list)
  - run37342955547.log and run37343605542.log
  - probes/ (onDeviceState.opus120, authActions.opus120, onDeviceCopy.opus120)
  - verdict-369.md, posted-369.json, probe-commits.txt

## Verdict posted
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #369 (H7) | 3252ec79cd9ab1f28165a1913d8ae3096b590d4a | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999043389 |

The head was re-read right before posting (09:52) and right after it, and was unchanged both times. Base agent115/wear-split-6-retire-samsung is still at 1266038c, the #364 head that Opus approved.

**PR CI at the head:** "Typecheck, lint, test" success, run 37244309360. Analyze is absent on the stacked base, as for H1-H6.

**Size:** 1,205 changed lines (1,191+/14-), under the 1,500 new-PR rule.

## Facts verified
- **Diff:** 7 files. The production changes are `src/services/health/onDeviceState.ts` and `src/services/authActions.ts`. Every line was read.
- **Call sites traced:**
  - useWearableConnections (local-auth query, Disconnect)
  - onDeviceSync connect, resume and refresh
  - ConnectProviderSheet runImport and handleContinue
  - onDeviceCopy connectFailureMessage
  - api.ts handleRefreshFailure (goes through signOut)
  - DeleteAccountScreen (calls signOut)
  - `retireOnDeviceState()` with no source, which has no production caller
- **Biometric lockout:** `src/security/biometric-lock.service.ts` onLockout emits logout without calling signOut, but it is unreachable: `requireAuth` has no production caller. Not a finding.
- **expo-secure-store 56.0.4 native source:**
  - iOS `deleteValueWithKeyAsync` (ios/SecureStoreModule.swift:43-51) ignores the SecItemDelete status and never rejects.
  - Android `deleteItemImpl` (SecureStoreModule.kt:243-261) throws when commit fails.
  - On web the module is `{}`, so every call rejects.
- **Prior Opus findings:** C-362-14 and C-362-15 are closed. The flipped probes pass, and the original opus119f DOCUMENTS cases now fail, as expected.
- **Invariant:** consent never outlives a sign-out that actually removed the credentials. Each binding (session, authority) voids the grant on its own, and both together cover each other's failures. The remaining case needs both stores to fail; then the SecureStore token deletes fail too, so the person is still signed in after a restart.

## Probes (CI lanes)
- **Lane 1:** audit/AUD-OPUS-H7-120/369-probes-1, run 37342955547, execution de30efde (3252ec79 + probe commit 62987bd4 + lane workflow). 69 suites, 803 pass / 3 fail. The failures:
  - the 2 original opus119f DOCUMENTS cases (by design: the behaviour is fixed);
  - 1 probe counting bug, fixed in lane 2.
  All PR suites, the B-HC7 top list, every prior Opus probe and the prior Sol probe copies pass.
- **Lane 2:** audit/AUD-OPUS-H7-120/369-probes-2, run 37343605542, execution 5ea1d40b (adds 57d78633). 5 suites, 39/39 pass:
  - onDeviceState.opus120 (11 cases)
  - authActions.opus120 (5)
  - onDeviceCopy.opus120 (1)
  - authorityStore
  - sol119g
- Both audit branches were deleted at 09:52.

## Follow-ups (C)
- **C-369-4.**
  - Where: `src/services/health/onDeviceState.ts:129-139` (`revokeConsentAuthority`), plus its claims at :50-58 and :313-324, the PR body "Residual", and `onDeviceState.authorityStore.test.ts:169-186`.
  - Problem: on iOS a failed Keychain delete is silent, so the replacement write never runs there. The comment, the residual text and the authorityStore case model a rejection iOS never produces.
  - Fix rule: document the iOS behaviour (the session replacement is what voids the grant). Optionally verify the delete with a read-back that falls back to the replacement write, and add an iOS-faithful test.
  - Proof: probe "DOCUMENTS C-369-4" (onDeviceState.opus120).
- **C-369-5 (outside this diff, pre-existing; H7 adds the SecureStore trigger).**
  - Where: `src/services/health/onDeviceSync.ts:252` (the recordLocalAuthorization rejection is not wrapped in OnDeviceStepError) and `src/screens/client/wearables/onDeviceCopy.ts:129-133,207-210`.
  - Problem: a failed local grant write after registration gets the copy "<name> is connected, but your history didn't finish coming in", even though this phone holds no grant. The action works: it falls through to a new Connect.
  - Fix rule: wrap the write as its own step (for example 'authorize') with "couldn't be connected on this phone ... Tap Continue" copy plus a reference, and test the copy and the action.
  - Proof: "DOCUMENTS C-369-5" (onDeviceCopy.opus120).
- **Agreed as C (Sol's, carried):** C-369-2 (progress not bound to the consent session) and C-369-3 (an early throw skips logout).

## Operator decisions (recommended defaults)
1. **#369:** Opus APPROVE at 3252ec79. Land H1-H7 as one unit once Sol's verdict on #369 and #362 is in, with the main-based required checks (Analyze) at landing. Default: yes.
2. **C-369-4 and C-369-5:** ticket them as C (default). Neither blocks the merge.

## HANDOFF
- **State:** the Opus verdict is posted at #369 3252ec79 (APPROVE 0/0/2). Opus has nothing open on H1-H7. The #362 APPROVE at 261e7d4c stands, and H7 closes C-362-14 and C-362-15.
- **Next:** if #369's head moves (a Sol-forced fix round, or a restack), a fresh Opus lens posts a delta from 3252ec79 and replays:
  - ops/aud-120/AUD-OPUS-H7-120/probes/*
  - the earlier Opus probes listed in ops/reports/AUD-OPUS-H46F-119.md HANDOFF (and ops/reports/B-HC7-119-probes.sh)
  - specs list: ops/aud-120/AUD-OPUS-H7-120/specs.txt, plus onDeviceCopy.opus120 at src/screens/client/wearables/__tests__/
  The original opus119f DOCUMENTS C-362-14/15 cases are expected to fail; the flipped copies are in opus120.
- **Cleanup:**
  - Done: worktree wt/AUD-OPUS-H7-120-1 removed, both audit/AUD-OPUS-H7-120/* branches deleted (09:52).
  - Kept: the claim directory.
