AUDIT Claude Opus 5.5 — growth-project-mobile#369 @ a2bfe2fa906ff5e3b991613a6838a82456db920c — VERDICT: APPROVE

A/B/C = 0/0/2

**AUD-OPUS-H9-120, agent 120.** Exact-head T4 review of FIX ROUND 2 ([builder comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999327369)): the full delta since my APPROVE head `3252ec79` ([Opus H7 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/369#issuecomment-5999043389)), and its composition with H1-H6. Head re-read right before posting. Base `agent115/wear-split-6-retire-samsung` @ `1266038cd311f3dcfd8e472c04e3241a3061866b` (the #364 head, unchanged). Size 1,250+/20- = 1,270 changed lines, under the 1,500 limit. PR CI at this head: Typecheck, lint, test **success** ([run 37345688498](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37345688498)); Analyze absent on the stacked base, as for H1-H6.

**Evidence reuse (G09).** Outside `src/services/health/onDeviceState.ts` and two test files, the tree is byte-identical to `3252ec79`, so my H7 review and lanes carry for the rest. The delta (3 commits, fast-forward) was read in full and re-tested in a new lane below.

### B-369-2 (Sol): closed
`serialWrite` now hands each write a `current()` check on the sign-out epoch captured at call time (`onDeviceState.ts:192-197`). `recordLocalAuthorization` calls it after the session read (`:229`), after a session write (`:233`), after the authority read (`:237`), after an authority creation (`:242`), with no await between the last check and the grant write (`:246`). Every interleaving with `retireOnDeviceStateAtSignOut` (`:342-359`) was traced:

| In-flight Connect at sign-out | End state |
|---|---|
| held at the session read or write | rejects `OnDeviceSessionChangedError`; no grant; a session value already handed to the native module binds nothing and the chain replaces the session |
| held at the authority read or creation | rejects as stopped; no grant; an authority created meanwhile binds nothing and the chain's second revocation removes it |
| grant write already issued | lands bound to the authority the immediate revocation deletes (Android: replaces on a failed delete), so it is void after a restart even if the app exits before the chain |
| Connect started after sign-out began | captures the new epoch and works (no lock-out) |

The rejection reaches `connectOnDevice` (`onDeviceSync.ts:252`) unwrapped, so the sheet shows the existing "signed-in account changed" copy (`src/screens/client/wearables/onDeviceCopy.ts:113-121`), the same class as a fence stop. `setSyncProgress` keeps its one-step write. The two changed existing tests (authorityStore round-1 case, signOutDrain in-flight case) only drop the old "the in-flight grant reached disk" behaviour; both keep the end-state assertions (no key, no grant).

### Probes (CI lane, no local runs)
Lane `audit/AUD-OPUS-H9-120/369-probes-1` at this head plus probe commit `087beb7b` ([run 37352819047](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37352819047)): 77 suites (every PR suite, the 20 earlier probe files, Opus H7-120 and Sol H7-120 probes, new `onDeviceState.opusH9`), **861 pass / 5 fail**, the 5 by-design failures listed in the builder comment and nothing else: `audit364.samsungRetirement` original SAMSUNG_HEALTH case; `opus119f` DOCUMENTS C-362-14 and C-362-15 (closed by H7); "CLOSED C-362-12" in `opus119f` and `.flipped`, which fail only on `await Promise.all([writing, retired])` because the in-flight write now rejects as stopped. New `onDeviceState.opusH9`, 7 cases, all pass:
- H9-1 / H9-2: first Connect held at the session write / at the authority read, then sign-out: rejects stopped; a restart snapshot taken while the chain is held, and a restart after it, read no consent.
- H9-3 (`it.each`, 2): grant write issued before sign-out lands after it; void after a restart taken before the chain, including the Android failed immediate delete.
- H9-4: two Connect writes (running and queued) at sign-out: both reject stopped, no key, no grant.
- H9-5: liveness: Connect and progress after sign-out work, also after a restart.
- H9-6: the C-362-12 replay at the new contract (write rejects; no key, no grant).

### Composition H1-H7
H1-H6 heads are unchanged and dual APPROVE: #359 `e0f3d2a7`, #360 `fde1875e`, #361 `574b32a8`, #362 `261e7d4c` (Opus [5985217014](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5985217014); Sol [5998888651](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5998888651), conditional on this composition), #363 `5266d658`, #364 `1266038c`. This delta changes no caller contract beyond "a Connect in flight at sign-out rejects as stopped", which every caller already handles as a fence stop. **From the Opus lens, H1-H7 (#359-#364, #369 @ `a2bfe2fa`) is clear to land as one unit**, with the main-based required checks (Analyze) run at landing.

### Findings
No A, no B. Carried C (not on the B-369-2 lines, unchanged):
- **C-369-4** `src/services/health/onDeviceState.ts:129-139` (`revokeConsentAuthority`): on iOS a failed Keychain delete is silent, so the replacement write never runs there; the comment and the authorityStore case model a rejection iOS never produces. Fix rule: document the iOS behaviour (the session replacement is what voids the grant); optionally verify the delete with a read-back that falls back to the replacement write, with an iOS-faithful test. Proof: "DOCUMENTS C-369-4" (`onDeviceState.opus120`), passes in the lane above.
- **C-369-5** (outside this diff) `src/services/health/onDeviceSync.ts:252`, `src/screens/client/wearables/onDeviceCopy.ts:129-133,207-210`: a failed local grant write (other than a stop) is not wrapped in `OnDeviceStepError`, so the copy says the source is connected but history did not finish, although this phone holds no grant. Fix rule: wrap the write as its own step with "could not be connected on this phone" copy plus a reference, and test copy and action. Proof: "DOCUMENTS C-369-5" (`onDeviceCopy.opus120`), passes in the lane above.

Sol's C-369-2, C-369-3 and C-362-5 stay follow-ups. Note, not a finding: the `serialWrite` doc says a running write "never creates consent state" after the immediate revocation; strictly, a session or authority value already handed to the native module can land, binding nothing (H9-1, H9-2 show the end state is clean).

Spends nothing; no merge, no deploy.
