AUDIT Claude Opus 5.5 — growth-project-mobile#362 @ 261e7d4c37429c65bf8e84468c5521380ff5b0cc — VERDICT: APPROVE
A/B/C = 0/0/2

AUD-OPUS-H46F-119 (agent 119), T4 (health data). Short delta from this lens's APPROVE at df44285d8b60a421277114601efa475744c5fac1.

**Delta read in full.** `git diff df44285d..261e7d4c` is one commit and two files: src/services/health/onDeviceState.ts (+47/-4) and src/services/authActions.ts (+3/-6). Every line was read, along with every caller of `recordLocalAuthorization`, `setSyncProgress` and `getLocalAuthorization`, and the session fence.

**Prior findings from this lens**
- **C-362-12 (Sol B-362-7): CLOSED.**
  - signOut now calls `retireOnDeviceStateAtSignOut()` synchronously, right after `stopOnDeviceHealthWork()` and before any await.
  - That call bumps the sign-out epoch, so every grant or progress write still queued rejects with `OnDeviceSessionChangedError` and never runs. It also records `signedOutThroughSeq`, so every grant with a sequence at or below it reads as null for the rest of this run.
  - It then queues the prefix removal on the same chain, behind the native write in flight. The returned promise never rejects and is awaited in signOut's clear `Promise.all`, so `await signOut()` is the boundary. Account deletion also ends in signOut.
  - The raw prefix sweep was dropped from `ASYNC_SIGN_OUT_PREFIXES`, so nothing removes these keys outside the chain.
- **C-362-13: CLOSED.** A failed or dropped grant write restores the previous `authWrittenAt` value, but only when the entry still holds this write's sequence. My H46E probe is flipped to expect null and passes.

**Other checks**
- **Stale Connect after sign-out cannot write a grant.** `connectOnDevice` calls `fence.assertCurrent()` right before `recordLocalAuthorization`. `assertCurrent` re-checks the generation after its await, and only microtasks separate that check from the synchronous sequence bump, so a sign-out tap (a macrotask) cannot slip in between. Both sync services also assert right before `setSyncProgress`. A probe proves this.
- **Restore ordering.** The reaction that settles the tail and the catch in `recordLocalAuthorization` both run before a concurrent `getLocalAuthorization` continues past `await storageTail`.
- **No regression for a new session.** A grant written after sign-out has a sequence above `signedOutThroughSeq` and is honoured. A Disconnect that started before sign-out never removes it.
- **Same unbounded-wait observation as H46E.** A native operation that never settles would also hold signOut. AsyncStorage always settles, so this is accepted.

**Probes (CI lane)**
- Run [37240428066](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37240428066) at 261e7d4c + probes: 13 suites, **167/167 pass**.
  - New probe onDeviceState.opus119f (8 cases): CLOSED C-362-12 with the real retire; a Connect whose fence predates sign-out records nothing; a pre-sign-out Disconnect never removes a post-sign-out Connect; a double sign-out; a failed write after a failed removal; DOCUMENTS C-362-14; DOCUMENTS C-362-15 plus its control.
  - Also passing: the flipped opus119e, opus119, opus119d, onDeviceState, onDeviceConnect, onDeviceSync, sessionFence, authActions (both), useWearableConnections (base and disconnect), and DeleteAccountScreen.
- Run [37240438780](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37240438780) at the #364 top: 63 suites, **757/758 pass**.
  - The only failure is the superseded AUD-SOL-H6-118 audit364.samsungRetirement expectation (Expected SAMSUNG_HEALTH, Received HEALTH_CONNECT). Its adapted hc4 copy passes, so the failure is by design.
- PR CI: Typecheck, lint, test is green at this head (run 37239676176).

**Findings**
- **C-362-14 (rated C; reported by the builder).** Location: onDeviceState.ts `retireOnDeviceStateAtSignOut`.
  - Counterexample: `removeMany` (or `getAllKeys`) rejects at sign-out. The grant is voided for this run, but after an app restart the same account reads the old grant again. DOCUMENTS C-362-14 in opus119f shows this with an isolated module re-import over the same disk.
  - Rated C because only the account that granted the permission can read the grant back (the key is per user; another account reads null in the probe), it needs a storage failure, and it matches the pre-FIX ROUND behaviour.
  - Fix rule: persist a sign-out marker (or a pending-removal list) and retry the removal at the next launch before any grant read; a restart test should see null.
- **C-362-15 (new).** Location: onDeviceState.ts `recordLocalAuthorization` catch block.
  - Counterexample: two grant writes for the same key overlap and both fail. The second one restores the first one's failed sequence (its prior), so an older Disconnect (since below that value) keeps the old grant and its progress. DOCUMENTS C-362-15 in opus119f passes; its single-failure control retires the grant.
  - Rated C because it needs two overlapping Connect taps on one source, both storage writes failing, and an older Disconnect.
  - Fix rule: keep a committed-sequence map set only after `setItem` resolves, and on failure restore that map's value (or delete) instead of the prior-at-call value. Test: flip DOCUMENTS C-362-15 to null.
- **Carried open (unchanged lines):** C-362-3 remainder, C-362-4, C-362-5, C-362-7, C-362-8, C-362-9 and C-362-10.

**Size.** 2,983 changed lines, under the grandfathered 3,000 ceiling. Any further change here must go to #363 (tests) or come with a split.

**Evidence reuse.** Only this lens's own approvals: everything outside `df44285d..261e7d4c` was approved at df44285d and is unchanged.
